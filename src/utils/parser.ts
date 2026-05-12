import { XMLParser } from "fast-xml-parser";
import {
  Alarm,
  Calendar,
  Event,
  EVENT_STATUSES,
  EventStatus,
  RecurrenceRule,
  SupportedComponent,
  Todo,
  TODO_STATUSES,
  TodoStatus,
} from "../models";
import ICAL from "ical.js";
import { Temporal } from 'temporal-polyfill';

const normalizeParam = (
  value: string | string[] | undefined
): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

/**
 * Converts an ICAL.Time object to Temporal.ZonedDateTime
 */
function icalTimeToTemporal(icalTime: ICAL.Time, tzid?: string): Temporal.ZonedDateTime {
  // Get the timezone - use the provided tzid or the time's zone
  let timezone = tzid || (icalTime.zone && icalTime.zone.tzid !== 'UTC' ? icalTime.zone.tzid : 'UTC');

  // Debug: Log the timezone value to see what we're getting
  if (timezone && typeof timezone === 'string' && timezone.includes('FLOAT')) {
    console.log('[icalTimeToTemporal] Detected FLOATING timezone:', JSON.stringify(timezone), 'length:', timezone.length, 'trimmed:', timezone.trim());
  }

  // Handle special "FLOATING" timezone - treat as system local timezone
  // Also handle variations like "FLOATING " (with space) or "floating"
  const normalizedTz = timezone?.toString().trim().toUpperCase();
  if (!timezone || normalizedTz === 'FLOATING') {
    console.log('[icalTimeToTemporal] Converting FLOATING timezone to system timezone:', Temporal.Now.timeZoneId());
    timezone = Temporal.Now.timeZoneId();
  }

  // Convert to JS Date first, then to Temporal
  const jsDate = icalTime.toJSDate();

  // Create PlainDateTime from the date components
  const instant = Temporal.Instant.fromEpochMilliseconds(jsDate.getTime());

  // Convert to ZonedDateTime in the appropriate timezone
  return instant.toZonedDateTimeISO(timezone);
}

function parseRecurrence(recur: ICAL.Recur): RecurrenceRule {
  const freqMap = {
    DAILY: "DAILY",
    WEEKLY: "WEEKLY",
    MONTHLY: "MONTHLY",
    YEARLY: "YEARLY",
  } as const;
  const freq = freqMap[recur.freq as keyof typeof freqMap] || undefined;

  const byday = recur.parts.BYDAY
    ? recur.parts.BYDAY.map((day: string) => day)
    : undefined;
  const bymonthday = recur.parts.BYMONTHDAY
    ? recur.parts.BYMONTHDAY.map((day: number) => day)
    : undefined;
  const bymonth = recur.parts.BYMONTH
    ? recur.parts.BYMONTH.map((month: number) => month)
    : undefined;
  const wkst = recur.wkst ? recur.wkst.toString() : undefined;

  return {
    freq,
    interval: recur.interval,
    count: recur.count ? recur.count : undefined,
    until: recur.until ? icalTimeToTemporal(recur.until) : undefined,
    wkst,
    byday,
    bymonthday,
    bymonth,
  };
}

const toArray = <T>(value: T | T[] | undefined): T[] =>
  Array.isArray(value) ? value : value ? [value] : [];

export const parseCalendars = async (
  responseData: string,
  baseUrl?: string
): Promise<Calendar[]> => {
  const calendars: Calendar[] = [];

  const parser = new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: false,
    attributeNamePrefix: "",
  });

  const jsonData = parser.parse(responseData);
  const responses = toArray(jsonData?.multistatus?.response);

  for (const res of responses) {
    const propstats = toArray(res?.propstat);

    const okPropstat = propstats.find(
      (p) =>
        typeof p?.status === "string" &&
        p.status.toLowerCase().includes("200 ok")
    );
    if (!okPropstat) continue;

    const prop = okPropstat.prop;
    const compArray = toArray(prop?.["supported-calendar-component-set"]?.comp);

    const supportedComponents = compArray
      .map((c) => c.name)
      .filter((name): name is SupportedComponent =>
        [
          "VEVENT",
          "VTODO",
          "VJOURNAL",
          "VFREEBUSY",
          "VTIMEZONE",
          "VAVAILABILITY",
        ].includes(name)
      );

    if (
      !supportedComponents.includes("VEVENT") &&
      !supportedComponents.includes("VTODO")
    )
      continue;

    calendars.push({
      displayName: prop?.displayname ?? "",
      url: baseUrl ? new URL(res.href, baseUrl).toString() : res.href,
      ctag: prop?.getctag,
      supportedComponents,
      color: prop?.["calendar-color"],
    });
  }

  return calendars;
};

export const parseEvents = async (
  responseData: string,
  baseUrl?: string
): Promise<Event[]> => {
  const events: Event[] = [];
  const parser = new XMLParser({ removeNSPrefix: true });
  const jsonData = parser.parse(responseData);
  let response = jsonData["multistatus"]?.["response"];
  if (!response) return events;

  if (!Array.isArray(response)) response = [response];

  for (const obj of response) {
    const eventData = obj["propstat"]?.["prop"];
    if (!eventData) continue;

    const rawCalendarData = eventData["calendar-data"];
    if (!rawCalendarData) continue;

    const cleanedCalendarData = rawCalendarData.replace(/&#13;/g, "\r");

    try {
      const jcalData = ICAL.parse(cleanedCalendarData);
      const vcalendar = new ICAL.Component(jcalData);

      const vevents = vcalendar.getAllSubcomponents("vevent");
      for (const vevent of vevents) {
        const icalEvent = new ICAL.Event(vevent);

        const dtStartProp = vevent.getFirstProperty("dtstart");
        const dtEndProp = vevent.getFirstProperty("dtend");

        const isWholeDay = icalEvent.startDate.isDate;

        const startTzid = normalizeParam(dtStartProp?.getParameter("tzid"));
        const endTzid = normalizeParam(dtEndProp?.getParameter("tzid"));

        const startDate = icalTimeToTemporal(icalEvent.startDate, startTzid);
        const endDate = icalEvent.endDate
          ? icalTimeToTemporal(icalEvent.endDate, endTzid)
          : startDate;

        const adjustedEnd = endDate;

        const rruleProp = vevent.getFirstProperty("rrule");
        let recurrenceRule: RecurrenceRule | undefined;
        if (rruleProp) {
          const rruleValue = rruleProp.getFirstValue();
          if (rruleValue) {
            const recur = ICAL.Recur.fromString(rruleValue.toString());
            recurrenceRule = parseRecurrence(recur);
          }
        }

        // Parse EXDATE property (exception dates)
        const exdateProps = vevent.getAllProperties("exdate");
        if (exdateProps && exdateProps.length > 0 && recurrenceRule) {
          const exdates: string[] = [];
          console.log('[ts-caldav parser] Found EXDATE properties:', exdateProps.length, 'for event:', icalEvent.summary);
          for (const exdateProp of exdateProps) {
            const exdateValues = exdateProp.getValues();
            if (exdateValues && Array.isArray(exdateValues)) {
              for (const exdateValue of exdateValues) {
                if (exdateValue) {
                  // Convert ICAL.Time to Temporal
                  const exdateTime = exdateValue as ICAL.Time;
                  const exdateTemporal = icalTimeToTemporal(exdateTime);
                  const pad = (n: number): string => n.toString().padStart(2, '0');

                  // Format as YYYYMMDD or YYYYMMDDTHHmmssZ depending on whether it's a date or datetime
                  if (exdateTime.isDate) {
                    // DATE format: YYYYMMDD
                    const year = exdateTemporal.year;
                    const month = pad(exdateTemporal.month);
                    const day = pad(exdateTemporal.day);
                    exdates.push(`${year}${month}${day}`);
                  } else {
                    // DATE-TIME format: YYYYMMDDTHHmmssZ (in UTC)
                    const utc = exdateTemporal.toInstant().toZonedDateTimeISO('UTC');
                    const year = utc.year;
                    const month = pad(utc.month);
                    const day = pad(utc.day);
                    const hour = pad(utc.hour);
                    const minute = pad(utc.minute);
                    const second = pad(utc.second);
                    exdates.push(`${year}${month}${day}T${hour}${minute}${second}Z`);
                  }
                }
              }
            }
          }
          if (exdates.length > 0) {
            recurrenceRule.exdate = exdates;
            console.log('[ts-caldav parser] Parsed EXDATE values:', exdates, 'for event:', icalEvent.summary);
          }
        }

        // Parse RECURRENCE-ID property
        let recurrenceId: Temporal.ZonedDateTime | undefined;
        const recurrenceIdProp = vevent.getFirstProperty("recurrence-id");
        if (recurrenceIdProp) {
          const recurrenceIdValue = recurrenceIdProp.getFirstValue() as ICAL.Time;
          if (recurrenceIdValue) {
            recurrenceId = icalTimeToTemporal(recurrenceIdValue, startTzid);
          }
        }

        const alarms: Alarm[] = [];
        const valarms = vevent.getAllSubcomponents("valarm") || [];

        for (const valarm of valarms) {
          const action = valarm.getFirstPropertyValue("action");
          const trigger = valarm.getFirstPropertyValue("trigger")?.toString();

          if (!action || !trigger) continue;

          if (action === "DISPLAY") {
            alarms.push({
              action: "DISPLAY",
              trigger,
              description: valarm
                .getFirstPropertyValue("description")
                ?.toString(),
            });
          } else if (action === "EMAIL") {
            const attendees =
              valarm
                .getAllProperties("attendee")
                ?.map((p) => p.getFirstValue())
                .filter((v): v is string => typeof v === "string") || [];

            alarms.push({
              action: "EMAIL",
              trigger,
              description: valarm
                .getFirstPropertyValue("description")
                ?.toString(),
              summary: valarm.getFirstPropertyValue("summary")?.toString(),
              attendees,
            });
          } else if (action === "AUDIO") {
            alarms.push({ action: "AUDIO", trigger });
          }
        }

        const rawStatus = vevent.getFirstPropertyValue("status")?.toString();
        const status = EVENT_STATUSES.includes(rawStatus as EventStatus)
          ? (rawStatus as EventStatus)
          : undefined;

        // Parse ATTENDEE properties
        const attendees: any[] = [];
        let userPartstat: string | undefined;
        const attendeeProps = vevent.getAllProperties("attendee") || [];

        for (const attendeeProp of attendeeProps) {
          const email = attendeeProp.getFirstValue()?.toString();
          if (email) {
            const cn = normalizeParam(attendeeProp.getParameter("cn"));
            const partstat = normalizeParam(attendeeProp.getParameter("partstat"));
            const role = normalizeParam(attendeeProp.getParameter("role"));
            const cutype = normalizeParam(attendeeProp.getParameter("cutype"));
            const rsvp = normalizeParam(attendeeProp.getParameter("rsvp"));

            attendees.push({
              email: email.replace(/^mailto:/i, ""),
              cn: cn || undefined,
              partstat: partstat || undefined,
              role: role || undefined,
              cutype: cutype || undefined,
              rsvp: rsvp === "TRUE" ? true : undefined,
            });

            // For now, use the first PARTSTAT we find as the user's status
            // In a full implementation, we'd match against the current user's email
            if (partstat && !userPartstat) {
              userPartstat = partstat;
            }
          }
        }

        events.push({
          uid: icalEvent.uid,
          summary: icalEvent.summary || "Untitled Event",
          start: startDate,
          end: adjustedEnd,
          description: icalEvent.description || undefined,
          location: icalEvent.location || undefined,
          status: status || undefined,
          etag: eventData["getetag"] || "",
          href: baseUrl
            ? new URL(obj["href"], baseUrl).toString()
            : obj["href"],
          wholeDay: isWholeDay,
          recurrenceRule,
          recurrenceId,
          startTzid,
          endTzid,
          alarms,
          attendees: attendees.length > 0 ? attendees : undefined,
          partstat: userPartstat as any,
        });
      }
    } catch (error) {
      console.error("Error parsing event data:", error);
    }
  }

  return events;
};

export const parseTodos = async (
  responseData: string,
  baseUrl?: string
): Promise<Todo[]> => {
  const todos: Todo[] = [];
  const parser = new XMLParser({ removeNSPrefix: true });
  const jsonData = parser.parse(responseData);
  let response = jsonData["multistatus"]?.["response"];
  if (!response) return todos;

  if (!Array.isArray(response)) response = [response];

  for (const obj of response) {
    const todoData = obj["propstat"]?.["prop"];
    if (!todoData) continue;

    const rawCalendarData = todoData["calendar-data"];
    if (!rawCalendarData) continue;

    const cleanedCalendarData = rawCalendarData.replace(/&#13;/g, "\r\n");

    try {
      const jcalData = ICAL.parse(cleanedCalendarData);
      const vcalendar = new ICAL.Component(jcalData);

      const vtodos = vcalendar.getAllSubcomponents("vtodo");
      for (const vtodo of vtodos) {
        const uid = vtodo.getFirstPropertyValue("uid") as string;
        const summary =
          (vtodo.getFirstPropertyValue("summary") as string) || "Untitled Todo";
        const description = vtodo.getFirstPropertyValue("description") as
          | string
          | undefined;
        const location = vtodo.getFirstPropertyValue("location") as
          | string
          | undefined;

        const rawStatus = vtodo.getFirstPropertyValue("status") as
          | string
          | undefined;
        const status = TODO_STATUSES.includes(rawStatus as TodoStatus)
          ? (rawStatus as TodoStatus)
          : undefined;

        const sortOrderRaw = vtodo.getFirstPropertyValue(
          "x-apple-sort-order"
        ) as string | number | null | undefined;
        const sortOrder =
          sortOrderRaw !== undefined && sortOrderRaw !== null
            ? Number(sortOrderRaw)
            : undefined;

        const dtStartProp = vtodo.getFirstProperty("dtstart");
        const dueProp = vtodo.getFirstProperty("due");
        const completedProp = vtodo.getFirstProperty("completed");

        const start = dtStartProp
          ? icalTimeToTemporal(dtStartProp.getFirstValue() as ICAL.Time)
          : undefined;
        const due = dueProp
          ? icalTimeToTemporal(dueProp.getFirstValue() as ICAL.Time)
          : undefined;
        const completed = completedProp
          ? icalTimeToTemporal(completedProp.getFirstValue() as ICAL.Time)
          : undefined;

        const alarms: Alarm[] = [];
        const valarms = vtodo.getAllSubcomponents("valarm") || [];

        for (const valarm of valarms) {
          const action = valarm.getFirstPropertyValue("action");
          const trigger = valarm.getFirstPropertyValue("trigger")?.toString();

          if (!action || !trigger) continue;

          if (action === "DISPLAY") {
            alarms.push({
              action: "DISPLAY",
              trigger,
              description: valarm
                .getFirstPropertyValue("description")
                ?.toString(),
            });
          } else if (action === "EMAIL") {
            const attendees =
              valarm
                .getAllProperties("attendee")
                ?.map((p) => p.getFirstValue())
                .filter((v): v is string => typeof v === "string") || [];

            alarms.push({
              action: "EMAIL",
              trigger,
              description: valarm
                .getFirstPropertyValue("description")
                ?.toString(),
              summary: valarm.getFirstPropertyValue("summary")?.toString(),
              attendees,
            });
          } else if (action === "AUDIO") {
            alarms.push({ action: "AUDIO", trigger });
          }
        }

        todos.push({
          uid,
          summary,
          start,
          due,
          completed,
          status,
          description,
          location,
          etag: todoData["getetag"] || "",
          href: baseUrl
            ? new URL(obj["href"], baseUrl).toString()
            : obj["href"],
          alarms,
          sortOrder,
        });
      }
    } catch (error) {
      console.error("Error parsing todo data:", error);
    }
  }

  return todos;
};
