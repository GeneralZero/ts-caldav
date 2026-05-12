import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import { encode } from "base-64";
import { XMLParser } from "fast-xml-parser";
import ICAL from "ical.js";
import { v4 as uuidv4 } from "uuid";
import { Temporal } from 'temporal-polyfill';
import {
  CalDAVClientCache,
  CalDAVOptions,
  Calendar,
  Event,
  EventRef,
  SyncChangesResult,
  SyncTodosResult,
  Todo,
  TodoRef,
} from "./models";
import { formatDate } from "./utils/encode";
import { parseCalendars, parseEvents, parseTodos } from "./utils/parser";
import { first, normalizeSlashEnd } from "./utils/common";

type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;
type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

const XML_CT = "application/xml; charset=utf-8";
const ICS_CT = "text/calendar; charset=utf-8";

export class CalDAVClient {
  private httpClient: AxiosInstance;
  private prodId: string;
  private parser = new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: false,
  });

  public calendarHome: string | null;
  public userPrincipal: string | null;
  public requestTimeout: number;
  public baseUrl: string;

  private constructor(private options: CalDAVOptions) {
    this.httpClient = axios.create({
      baseURL: options.baseUrl,
      headers: {
        Authorization:
          options.auth.type === "basic"
            ? `Basic ${encode(
                `${options.auth.username}:${options.auth.password}`
              )}`
            : `Bearer ${options.auth.accessToken}`,
        "Content-Type": XML_CT,
      },
      timeout: options.requestTimeout || 5000,
    });

    this.prodId = options.prodId || "-//ts-caldav.//CalDAV Client//EN";
    this.calendarHome = null;
    this.userPrincipal = null;
    this.requestTimeout = options.requestTimeout || 5000;
    this.baseUrl = options.baseUrl;

    if (options.logRequests) {
      this.httpClient.interceptors.request.use((request) => {
        const base = this.baseUrl.replace(/\/+$/, "");
        const path = (request.url || "").replace(/^\/+/, "");
        console.log(
          `Request: ${request.method?.toUpperCase()} ${base}/${path}`
        );
        return request;
      });
    }
  }

  /**
   * Creates a new CalDAVClient instance and validates the provided credentials.
   * @param options - The CalDAV client options.
   * @returns A new CalDAVClient instance.
   * @throws An error if the provided credentials are invalid.
   * @example
   * ```typescript
   * const client = await CalDAVClient.create({
   *  baseUrl: "https://caldav.example.com",
   *  username: "user",
   *  password: "password",
   * });
   * ```
   */
  static async create(options: CalDAVOptions): Promise<CalDAVClient> {
    const client = new CalDAVClient(options);
    await client.discover();
    return client;
  }

  /**
   * Creates a CalDAVClient instance from a cache object.
   * This is useful for restoring a client state without re-fetching the calendar home.
   * @param options - The CalDAV client options.
   * @param cache - The cached client state.
   * @return A new CalDAVClient instance initialized with the cached state.
   * @throws An error if the cache is invalid or incomplete.
   */
  static createFromCache(
    options: CalDAVOptions,
    cache: CalDAVClientCache
  ): CalDAVClient {
    const client = new CalDAVClient(options);
    client.userPrincipal = client.resolveUrl(cache.userPrincipal);
    client.calendarHome = client.resolveUrl(cache.calendarHome);
    if (cache.prodId) client.prodId = cache.prodId;
    return client;
  }

  public getCalendarHome(): string | null {
    return this.calendarHome;
  }

  /**
   * Exports the current client state to a cache object.
   * This can be used to restore the client state later without re-fetching the calendar home.
   * @returns A CalDAVClientCache object containing the current client state.
   */
  public exportCache(): CalDAVClientCache {
    return {
      userPrincipal: this.userPrincipal!,
      calendarHome: this.calendarHome!,
      prodId: this.prodId,
    };
  }

  /*
   * Discovery
   */

  private async tryDiscoveryRoots(): Promise<string> {
	// Skip .well-known/caldav check to avoid CORS redirect issues in browsers
	// Browsers block CORS requests that result in redirects to different paths
	// try {
	// 	const wk = this.absolutize("/.well-known/caldav");
	// 	return await this.followRedirectOnce(wk);
	// } catch {
	// 	/* fall through */
	// }
    // Try candidates in order
    const candidates = [
      "/",
      "/dav",
      "/caldav",
      "/caldav.php",
      "/remote.php/dav",
    ];
	
    for (const p of candidates) {
      try {
        const abs = this.absolutize(p);
        const res = await this.httpClient.request({
          method: "OPTIONS",
          url: abs,
          validateStatus: () => true,
        });
        const allow = String(res.headers["allow"] || "").toUpperCase();
        const dav = String(res.headers["dav"] || "").toLowerCase();
        const looksDav = allow.includes("PROPFIND") || dav.includes("1");
        if (res.status < 500 && looksDav) return abs;
      } catch {
        /* try next */
      }
    }

    // Fallback to baseUrl
    return this.baseUrl;
  }

  private async discover(): Promise<void> {
    const discoveryRoot = await this.tryDiscoveryRoots();

    const cupXml = `
      <d:propfind xmlns:d="DAV:">
        <d:prop><d:current-user-principal/></d:prop>
      </d:propfind>`;
    const cup = await this.propfind(discoveryRoot, "0", cupXml);

    const principalHref = this.getHrefFromProp(cup, "current-user-principal");
    if (!principalHref) {
      throw new Error(
        "User principal not found: credentials rejected or server misconfigured."
      );
    }
    const principalUrl = this.absolutize(this.resolveUrl(principalHref));
    this.userPrincipal = principalUrl;

    const chsXml = `
      <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop><c:calendar-home-set/></d:prop>
      </d:propfind>`;
    const chs = await this.propfind(principalUrl, "0", chsXml);

    const homeHref = this.getHrefFromProp(chs, "calendar-home-set");
    if (!homeHref)
      throw new Error("calendar-home-set not found for principal.");
    const homeUrl = this.absolutize(this.resolveUrl(homeHref));
    this.calendarHome = homeUrl;

    try {
      await this.propfind(
        homeUrl,
        "0",
        `<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`
      );
    } catch (e) {
      throw new Error(
        `Authenticated but failed to access calendar home at ${homeUrl}: ${e}`
      );
    }
  }

  /*
   * Calendars
   */

  public async getCalendars(): Promise<Calendar[]> {
    if (!this.calendarHome) throw new Error("Calendar home not found.");

    const requestBody = `
      <d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:apple="http://apple.com/ns/ical/">
        <d:prop>
          <d:resourcetype/>
          <d:displayname/>
          <cs:getctag/>
          <c:supported-calendar-component-set/>
          <apple:calendar-color/>
        </d:prop>
      </d:propfind>`;

    const response = await this.httpClient.request({
      method: "PROPFIND",
      url: this.calendarHome,
      data: requestBody,
      headers: { Depth: "1", "Content-Type": XML_CT },
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const calendars = await parseCalendars(response.data);
    return calendars.map((cal) => ({
      ...cal,
      url: this.resolveUrl(cal.url),
    }));
  }

  /*
   * Event CRUD Operations
   */

  /**
   * Fetches all events from a specific calendar.
   * @param calendarUrl - The URL of the calendar to fetch events from.
   * @param options - Optional parameters for fetching events.
   * @returns An array of Event objects.
   */
  public async getEvents(
    calendarUrl: string,
    options?: { start?: Date | Temporal.ZonedDateTime; end?: Date | Temporal.ZonedDateTime; all?: boolean }
  ): Promise<Event[]> {
    return this.getComponents<Event>(
      calendarUrl,
      "VEVENT",
      parseEvents,
      options
    );
  }

  /**
   * Creates a new event in the specified calendar.
   * @param calendarUrl - The URL of the calendar to create the event in.
   * @param eventData - The data for the event to create.
   * @returns The created event's metadata.
   */
  public async createEvent(
    calendarUrl: string,
    eventData: PartialBy<Event, "uid" | "href" | "etag">
  ): Promise<{ uid: string; href: string; etag: string; newCtag: string }> {
    return this.createItem<Event>(
      calendarUrl,
      eventData,
      this.buildICSData.bind(this),
      "event"
    );
  }

  /**
   * Creates an event with a custom href (for RECURRENCE-ID events).
   * This is used when creating single instance modifications of recurring events.
   * @param calendarUrl - The URL of the calendar to create the event in.
   * @param eventData - The event data with uid, href, and recurrenceId set.
   * @returns The created event's metadata.
   */
  public async createEventWithCustomHref(
    calendarUrl: string,
    eventData: Event
  ): Promise<{ uid: string; href: string; etag: string; newCtag: string }> {
    if (!eventData.uid || !eventData.href) {
      throw new Error("Both 'uid' and 'href' are required for custom href event creation.");
    }

    const base = normalizeSlashEnd(calendarUrl);
    const ics = this.buildICSData(eventData, eventData.uid);

    try {
      // Use PUT without If-None-Match to create or update the event
      // Accept 409 in case of conflicts and let the caller handle it
      const response = await this.mkIcsPut(
        eventData.href,
        ics,
        {},
        (s) => s === 201 || s === 204 || s === 409
      );

      // If we got a 409, the server is rejecting due to a conflict
      // This might mean we need to delete existing recurrence overrides first
      if (response.status === 409) {
        throw new Error("Event conflict (409): The server rejected this recurrence modification. There may be an existing override that needs to be deleted first.");
      }

      const etag = response.headers["etag"] || "";
      const newCtag = await this.getCtag(base);
      return { uid: eventData.uid, href: eventData.href, etag, newCtag };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        // Get the response body for more details
        const details = error.response?.data || "No details available";
        throw new Error(`Event conflict (409): ${details}`);
      }
      throw new Error(`Failed to create event: ${error}`);
    }
  }

  /**
   * Updates an existing event in the specified calendar.
   * @param calendarUrl - The URL of the calendar containing the event.
   * @param event - The event object with updated data.
   * @returns The updated event's metadata.
   */
  public async updateEvent(
    calendarUrl: string,
    event: Event
  ): Promise<{ uid: string; href: string; etag: string; newCtag: string }> {
    return this.updateItem<Event>(
      calendarUrl,
      event,
      this.buildICSData.bind(this),
      "event"
    );
  }

  public async deleteEvent(
    calendarUrl: string,
    eventUid: string,
    etag?: string
  ): Promise<void> {
    return this.deleteItem(calendarUrl, eventUid, "event", etag);
  }

  /**
   * Adds a RECURRENCE-ID exception to an existing recurring event.
   * This modifies the parent event's .ics file to include a new VEVENT component
   * with the RECURRENCE-ID property, which is the proper way to handle single instance modifications.
   * @param parentEvent - The parent recurring event
   * @param exceptionEvent - The modified instance data with recurrenceId set
   * @returns The updated event's metadata
   */
  public async addRecurrenceException(
    parentEvent: Event,
    exceptionEvent: Event
  ): Promise<{ uid: string; href: string; etag: string; newCtag: string }> {
    if (!parentEvent.href || !exceptionEvent.recurrenceId) {
      throw new Error("Parent event must have href and exception must have recurrenceId");
    }

    // Fetch the raw ICS data for the parent event
    const response = await this.httpClient.get(parentEvent.href, {
      headers: { "Content-Type": "text/calendar" },
    });

    const icsData = response.data;

    // Parse the ICS data
    const jcalData = ICAL.parse(icsData);
    const comp = new ICAL.Component(jcalData);
    const vcalendar = comp.getFirstSubcomponent("vcalendar") || comp;

    // Build the exception VEVENT component
    const exceptionICS = this.buildICSData(exceptionEvent, exceptionEvent.uid);
    const exceptionJcal = ICAL.parse(exceptionICS);
    const exceptionComp = new ICAL.Component(exceptionJcal);
    const exceptionVcal = exceptionComp.getFirstSubcomponent("vcalendar") || exceptionComp;
    const exceptionVevent = exceptionVcal.getFirstSubcomponent("vevent");

    if (!exceptionVevent) {
      throw new Error("Failed to create exception VEVENT component");
    }

    // Add the exception VEVENT to the parent VCALENDAR
    vcalendar.addSubcomponent(exceptionVevent);

    // Convert back to ICS string
    const updatedICS = vcalendar.toString();

    // Update the parent event file with the modified ICS data
    const base = normalizeSlashEnd(parentEvent.calendarId || "");
    const putResponse = await this.mkIcsPut(
      parentEvent.href,
      updatedICS,
      { "If-Match": parentEvent.etag },
      (s) => s === 201 || s === 204
    );

    const etag = putResponse.headers["etag"] || "";
    const newCtag = await this.getCtag(base);

    return {
      uid: parentEvent.uid,
      href: parentEvent.href,
      etag,
      newCtag
    };
  }

  /*
   * Todo CRUD Operations
   */

  /**
   * Fetches all todos from a specific calendar.
   * @param calendarUrl - The URL of the calendar to fetch todos from.
   * @param options - Optional parameters for fetching todos.
   * @returns An array of Todo objects.
   */
  public async getTodos(
    calendarUrl: string,
    options?: { start?: Date | Temporal.ZonedDateTime; end?: Date | Temporal.ZonedDateTime; all?: boolean }
  ): Promise<Todo[]> {
    return this.getComponents<Todo>(calendarUrl, "VTODO", parseTodos, {
      all: true,
      ...options,
    });
  }

  /**
   * Creates a new todo in the specified calendar.
   * @param calendarUrl - The URL of the calendar to create the todo in.
   * @param todoData - The data for the todo to create.
   * @returns The created todo's metadata.
   */
  public async createTodo(
    calendarUrl: string,
    todoData: PartialBy<Todo, "uid" | "href" | "etag">
  ): Promise<{ uid: string; href: string; etag: string; newCtag: string }> {
    return this.createItem<Todo>(
      calendarUrl,
      todoData,
      this.buildTodoICSData.bind(this),
      "todo"
    );
  }

  /**
   * Updates an existing todo in the specified calendar.
   * @param calendarUrl - The URL of the calendar containing the todo.
   * @param todo - The todo object with updated data.
   * @returns The updated todo's metadata.
   */
  public async updateTodo(
    calendarUrl: string,
    todo: Todo
  ): Promise<{ uid: string; href: string; etag: string; newCtag: string }> {
    return this.updateItem<Todo>(
      calendarUrl,
      todo,
      this.buildTodoICSData.bind(this),
      "todo"
    );
  }

  /**
   * Deletes a todo from the specified calendar.
   * @param calendarUrl - The URL of the calendar containing the todo.
   * @param todoUid - The UID of the todo to delete.
   * @param etag - Optional ETag for concurrency control.
   */
  public async deleteTodo(
    calendarUrl: string,
    todoUid: string,
    etag?: string
  ): Promise<void> {
    return this.deleteItem(calendarUrl, todoUid, "todo", etag);
  }

  /*
   * Synchronization
   */

  /**
   * Fetches the current ETag for a given event href.
   * Useful when the server does not return an ETag on creation (e.g. Yahoo).
   * @param href - The full CalDAV event URL (ending in .ics).
   * @returns The ETag string, or throws an error if not found.
   */
  public async getETag(href: string): Promise<string> {
    try {
      const data = await this.propfind(
        href,
        "0",
        `<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>`
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed: any = data;
      const etagRaw =
        parsed?.multistatus?.response?.propstat?.prop?.getetag ??
        parsed?.multistatus?.response?.[0]?.propstat?.prop?.getetag;
      if (!etagRaw) throw new Error("ETag not found in PROPFIND response.");
      return String(etagRaw).replace(/^W\//, "");
    } catch (error) {
      throw new Error(`Failed to retrieve ETag for ${href}: ${error}`);
    }
  }

  /**
   * Fetches the current CTag for a given calendar URL.
   * @param calendarUrl - The URL of the calendar.
   * @returns The CTag string.
   */
  public async getCtag(calendarUrl: string): Promise<string> {
    const requestBody = `
      <d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
        <d:prop><cs:getctag/></d:prop>
      </d:propfind>`;

    const res = await this.httpClient.request({
      method: "PROPFIND",
      url: calendarUrl,
      data: requestBody,
      headers: { Depth: "0", "Content-Type": XML_CT },
      validateStatus: (s) => s === 207,
    });

    const json = this.parser.parse(res.data);
    return json?.multistatus?.response?.propstat?.prop?.getctag;
  }

  private diffRefs(
    remoteRefs: { href: string; etag: string }[],
    localRefs: { href: string; etag: string }[]
  ): { newItems: string[]; updatedItems: string[]; deletedItems: string[] } {
    const localMap = new Map(localRefs.map((i) => [i.href, i.etag]));
    const remoteMap = new Map(remoteRefs.map((i) => [i.href, i.etag]));

    const newItems: string[] = [];
    const updatedItems: string[] = [];
    const deletedItems: string[] = [];

    for (const { href, etag } of remoteRefs) {
      if (!localMap.has(href)) newItems.push(href);
      else if (localMap.get(href) !== etag) updatedItems.push(href);
    }
    for (const { href } of localRefs) {
      if (!remoteMap.has(href)) deletedItems.push(href);
    }
    return { newItems, updatedItems, deletedItems };
  }

  /**
   * Synchronizes changes between local events and remote calendar.
   * @param calendarUrl - The URL of the calendar to sync with.
   * @param ctag - The current CTag of the calendar.
   * @param localEvents - The local events to compare against remote.
   * @returns An object containing the sync results.
   */
  public async syncChanges(
    calendarUrl: string,
    ctag: string,
    localEvents: EventRef[]
  ): Promise<SyncChangesResult> {
    const remoteCtag = await this.getCtag(calendarUrl);
    if (ctag === remoteCtag) {
      return {
        changed: false,
        newCtag: remoteCtag,
        newEvents: [],
        updatedEvents: [],
        deletedEvents: [],
      };
    }

    const remoteRefs = await this.getItemRefs(calendarUrl, "VEVENT");
    const { newItems, updatedItems, deletedItems } = this.diffRefs(
      remoteRefs,
      localEvents
    );

    return {
      changed: true,
      newCtag: remoteCtag,
      newEvents: newItems,
      updatedEvents: updatedItems,
      deletedEvents: deletedItems,
    };
  }

  /**
   * Synchronizes changes between local todos and remote calendar.
   * @param calendarUrl - The URL of the calendar to sync with.
   * @param ctag - The current CTag of the calendar.
   * @param localTodos - The local todos to compare against remote.
   * @returns An object containing the sync results.
   */
  public async syncTodoChanges(
    calendarUrl: string,
    ctag: string,
    localTodos: TodoRef[]
  ): Promise<SyncTodosResult> {
    const remoteCtag = await this.getCtag(calendarUrl);
    if (ctag === remoteCtag) {
      return {
        changed: false,
        newCtag: remoteCtag,
        newTodos: [],
        updatedTodos: [],
        deletedTodos: [],
      };
    }

    const remoteRefs = await this.getItemRefs(calendarUrl, "VTODO");
    const { newItems, updatedItems, deletedItems } = this.diffRefs(
      remoteRefs,
      localTodos
    );

    return {
      changed: true,
      newCtag: remoteCtag,
      newTodos: newItems,
      updatedTodos: updatedItems,
      deletedTodos: deletedItems,
    };
  }

  /*
   * Internal Methods
   */

  private async getComponents<T>(
    calendarUrl: string,
    component: "VEVENT" | "VTODO",
    parseFn: (xml: string) => Promise<T[]>,
    options?: { start?: Date | Temporal.ZonedDateTime; end?: Date | Temporal.ZonedDateTime; all?: boolean }
  ): Promise<T[]> {
    const now = Temporal.Now.zonedDateTimeISO();
    const defaultEnd = now.add({ weeks: 3 });
    let { start = now, end = defaultEnd, all } = options || {};

    // Convert Date objects to Temporal for consistency (backward compatibility)
    if (start instanceof Date) {
      const instant = Temporal.Instant.fromEpochMilliseconds(start.getTime());
      start = instant.toZonedDateTimeISO(Temporal.Now.timeZoneId());
    }
    if (end instanceof Date) {
      const instant = Temporal.Instant.fromEpochMilliseconds(end.getTime());
      end = instant.toZonedDateTimeISO(Temporal.Now.timeZoneId());
    }

    const timeRangeFilter =
      start && end && !all
        ? `<c:comp-filter name="${component}">
             <c:time-range start="${formatDate(start)}" end="${formatDate(
            end
          )}"/>
           </c:comp-filter>`
        : `<c:comp-filter name="${component}"/>`;

    const requestBody = `
      <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
          <d:getetag/>
          <c:calendar-data/>
        </d:prop>
        <c:filter>
          <c:comp-filter name="VCALENDAR">
            ${timeRangeFilter}
          </c:comp-filter>
        </c:filter>
      </c:calendar-query>`;

    console.log('[ts-caldav] getComponents request:', {
      component,
      start: start?.toString(),
      end: end?.toString(),
      formattedStart: start ? formatDate(start) : 'N/A',
      formattedEnd: end ? formatDate(end) : 'N/A',
      timeRangeFilter,
      requestBody, // Log the full XML request
    });

    try {
      const xml = await this.report(calendarUrl, requestBody, "1");
      return await parseFn(xml);
    } catch (error: any) {
      console.error('[ts-caldav] getComponents error:', {
        error,
        responseData: error?.response?.data,
        responseDataType: typeof error?.response?.data,
        status: error?.response?.status,
        statusText: error?.response?.statusText,
        config: error?.config,
      });

      // Try to log the full error response if it's XML
      if (error?.response?.data) {
        console.error('[ts-caldav] Full response data:', error.response.data);
      }

      throw new Error(
        `Failed to retrieve ${component.toLowerCase()}s from the CalDAV server. ${error}`
      );
    }
  }

  private buildICSData(
    event: PartialBy<Event, "uid" | "etag" | "href">,
    uid: string
  ): string {
    const vcalendar = new ICAL.Component(["vcalendar", [], []]);
    vcalendar.addPropertyWithValue("version", "2.0");
    vcalendar.addPropertyWithValue("prodid", this.prodId);

    const vevent = new ICAL.Component("vevent");
    const e = new ICAL.Event(vevent);
    e.uid = uid;
    vevent.addPropertyWithValue(
      "dtstamp",
      ICAL.Time.fromJSDate(new Date(), true)
    );

    if (event.wholeDay) {
      const pad = (n: number): string => n.toString().padStart(2, '0');
      const startDateStr = `${event.start.year}-${pad(event.start.month)}-${pad(event.start.day)}`;
      const endDateStr = event.end
        ? `${event.end.year}-${pad(event.end.month)}-${pad(event.end.day)}`
        : startDateStr;

      // For whole-day events, the end date is exclusive, so add 1 day
      const endTemporal = event.end.add({ days: 1 });
      const endDateExclusiveStr = `${endTemporal.year}-${pad(endTemporal.month)}-${pad(endTemporal.day)}`;

      e.startDate = ICAL.Time.fromDateString(startDateStr);
      e.endDate = ICAL.Time.fromDateString(endDateExclusiveStr);
    } else {
      // Convert Temporal to JS Date for ICAL.js
      const startInstant = event.start.toInstant();
      const endInstant = event.end.toInstant();
      const start = ICAL.Time.fromJSDate(new Date(startInstant.epochMilliseconds), true);
      const end = ICAL.Time.fromJSDate(new Date(endInstant.epochMilliseconds), true);

      if (event.startTzid) {
        const prop = vevent.addPropertyWithValue("dtstart", start);
        prop.setParameter("tzid", event.startTzid);
      } else {
        e.startDate = start;
      }

      if (event.endTzid) {
        const prop = vevent.addPropertyWithValue("dtend", end);
        prop.setParameter("tzid", event.endTzid);
      } else {
        e.endDate = end;
      }
    }

    e.summary = event.summary;
    e.description = event.description || "";
    e.location = event.location || "";

    // Add RECURRENCE-ID for exception events
    if (event.recurrenceId) {
      if (event.wholeDay) {
        // For whole-day events, use DATE format (no time component)
        const pad = (n: number): string => n.toString().padStart(2, '0');
        const recurrenceIdStr = `${event.recurrenceId.year}-${pad(event.recurrenceId.month)}-${pad(event.recurrenceId.day)}`;
        const recurrenceIdDate = ICAL.Time.fromDateString(recurrenceIdStr);
        vevent.addPropertyWithValue("recurrence-id", recurrenceIdDate);
      } else {
        // For timed events, use DATE-TIME format with UTC
        const recurrenceIdInstant = event.recurrenceId.toInstant();
        const recurrenceIdTime = ICAL.Time.fromJSDate(new Date(recurrenceIdInstant.epochMilliseconds), true);

        // Check if we have timezone info
        if (event.startTzid) {
          // Add RECURRENCE-ID with TZID parameter to match DTSTART
          const prop = vevent.addPropertyWithValue("recurrence-id", recurrenceIdTime);
          prop.setParameter("tzid", event.startTzid);
        } else {
          // No timezone, use UTC
          vevent.addPropertyWithValue("recurrence-id", recurrenceIdTime);
        }
      }
    }

    if (event.recurrenceRule) {
      const r = event.recurrenceRule;
      const rruleProps: Record<string, string | number> = {};
      if (r.freq) rruleProps.FREQ = r.freq;
      if (r.interval) rruleProps.INTERVAL = r.interval;
      if (r.count) rruleProps.COUNT = r.count;
      if (event.wholeDay && r.until) {
        const pad = (n: number): string => n.toString().padStart(2, '0');
        const untilDateStr = `${r.until.year}-${pad(r.until.month)}-${pad(r.until.day)}`;
        rruleProps.UNTIL = ICAL.Time.fromDateString(untilDateStr).toString();
      } else if (r.until) {
        const untilInstant = r.until.toInstant();
        rruleProps.UNTIL = ICAL.Time.fromJSDate(new Date(untilInstant.epochMilliseconds), true).toString();
      }

      if (r.byday) rruleProps.BYDAY = r.byday.join(",");
      if (r.bymonthday) rruleProps.BYMONTHDAY = r.bymonthday.join(",");
      if (r.bymonth) rruleProps.BYMONTH = r.bymonth.join(",");
      vevent.addPropertyWithValue("rrule", rruleProps);

      // Add EXDATE if present
      if (r.exdate && r.exdate.length > 0) {
        console.log('[ts-caldav client] Adding EXDATE to event:', r.exdate);
        for (const exdateStr of r.exdate) {
          // Parse the EXDATE string to determine if it's DATE or DATE-TIME
          if (exdateStr.includes('T')) {
            // DATE-TIME format: YYYYMMDDTHHmmssZ
            const year = parseInt(exdateStr.substring(0, 4));
            const month = parseInt(exdateStr.substring(4, 6));
            const day = parseInt(exdateStr.substring(6, 8));
            const hour = parseInt(exdateStr.substring(9, 11));
            const minute = parseInt(exdateStr.substring(11, 13));
            const second = parseInt(exdateStr.substring(13, 15));

            const exdateTime = ICAL.Time.fromData({
              year, month, day, hour, minute, second,
              isDate: false
            });
            exdateTime.zone = ICAL.Timezone.utcTimezone;
            vevent.addPropertyWithValue("exdate", exdateTime);
          } else {
            // DATE format: YYYYMMDD
            const year = parseInt(exdateStr.substring(0, 4));
            const month = parseInt(exdateStr.substring(4, 6));
            const day = parseInt(exdateStr.substring(6, 8));

            const exdateTime = ICAL.Time.fromData({
              year, month, day,
              isDate: true
            });
            vevent.addPropertyWithValue("exdate", exdateTime);
          }
        }
      }
    }

    if (event.alarms) {
      for (const alarm of event.alarms) {
        const valarm = new ICAL.Component("valarm");
        valarm.addPropertyWithValue("trigger", alarm.trigger);
        valarm.addPropertyWithValue("action", alarm.action);

        if (alarm.action === "DISPLAY" && alarm.description) {
          valarm.addPropertyWithValue("description", alarm.description);
        } else if (alarm.action === "EMAIL") {
          if (alarm.summary)
            valarm.addPropertyWithValue("summary", alarm.summary);
          if (alarm.description)
            valarm.addPropertyWithValue("description", alarm.description);
          for (const attendee of alarm.attendees) {
            valarm.addPropertyWithValue("attendee", attendee);
          }
        }
        vevent.addSubcomponent(valarm);
      }
    }

    // Encode ATTENDEE properties
    if (event.attendees && event.attendees.length > 0) {
      for (const attendee of event.attendees) {
        const email = attendee.email.startsWith("mailto:")
          ? attendee.email
          : `mailto:${attendee.email}`;
        const attendeeProp = vevent.addPropertyWithValue("attendee", email);

        if (attendee.cn) {
          attendeeProp.setParameter("cn", attendee.cn);
        }
        if (attendee.partstat) {
          attendeeProp.setParameter("partstat", attendee.partstat);
        }
        if (attendee.role) {
          attendeeProp.setParameter("role", attendee.role);
        }
        if (attendee.cutype) {
          attendeeProp.setParameter("cutype", attendee.cutype);
        }
        if (attendee.rsvp !== undefined) {
          attendeeProp.setParameter("rsvp", attendee.rsvp ? "TRUE" : "FALSE");
        }
      }
    }

    vcalendar.addSubcomponent(vevent);
    const icsData = vcalendar.toString();

    // Debug: Log the ICS data if it contains EXDATE
    if (icsData.includes('EXDATE')) {
      console.log('[ts-caldav buildICSData] Generated ICS with EXDATE:', icsData);
    }

    return icsData;
  }

  private buildTodoICSData(
    todo: PartialBy<Todo, "uid" | "etag" | "href">,
    uid: string
  ): string {
    const vcalendar = new ICAL.Component(["vcalendar", [], []]);
    vcalendar.addPropertyWithValue("version", "2.0");
    vcalendar.addPropertyWithValue("prodid", this.prodId);

    const vtodo = new ICAL.Component("vtodo");
    vtodo.addPropertyWithValue("uid", uid);
    vtodo.addPropertyWithValue(
      "dtstamp",
      ICAL.Time.fromJSDate(new Date(), true)
    );

    if (todo.start) {
      const startInstant = todo.start.toInstant();
      vtodo.addPropertyWithValue(
        "dtstart",
        ICAL.Time.fromJSDate(new Date(startInstant.epochMilliseconds), true)
      );
    }
    if (todo.due) {
      const dueInstant = todo.due.toInstant();
      vtodo.addPropertyWithValue("due", ICAL.Time.fromJSDate(new Date(dueInstant.epochMilliseconds), true));
    }
    if (todo.completed) {
      const completedInstant = todo.completed.toInstant();
      vtodo.addPropertyWithValue(
        "completed",
        ICAL.Time.fromJSDate(new Date(completedInstant.epochMilliseconds), true)
      );
    }
    vtodo.addPropertyWithValue("summary", todo.summary);
    if (todo.description)
      vtodo.addPropertyWithValue("description", todo.description);
    if (todo.location) vtodo.addPropertyWithValue("location", todo.location);
    if (todo.status) vtodo.addPropertyWithValue("status", todo.status);
    if (todo.sortOrder !== undefined)
      vtodo.addPropertyWithValue("X-APPLE-SORT-ORDER", todo.sortOrder);

    if (todo.alarms) {
      for (const alarm of todo.alarms) {
        const valarm = new ICAL.Component("valarm");
        valarm.addPropertyWithValue("trigger", alarm.trigger);
        valarm.addPropertyWithValue("action", alarm.action);
        if (alarm.action === "DISPLAY" && alarm.description) {
          valarm.addPropertyWithValue("description", alarm.description);
        } else if (alarm.action === "EMAIL") {
          if (alarm.summary)
            valarm.addPropertyWithValue("summary", alarm.summary);
          if (alarm.description)
            valarm.addPropertyWithValue("description", alarm.description);
          for (const attendee of alarm.attendees) {
            valarm.addPropertyWithValue("attendee", attendee);
          }
        }
        vtodo.addSubcomponent(valarm);
      }
    }

    vcalendar.addSubcomponent(vtodo);
    return vcalendar.toString();
  }

  private async createItem<
    T extends { uid?: string; href?: string; etag?: string }
  >(
    calendarUrl: string,
    data: PartialBy<T, "uid" | "href" | "etag">,
    buildFn: (
      data: PartialBy<T, "uid" | "href" | "etag">,
      uid: string
    ) => string,
    itemType: "event" | "todo"
  ): Promise<{ uid: string; href: string; etag: string; newCtag: string }> {
    if (!calendarUrl)
      throw new Error(`Calendar URL is required to create a ${itemType}.`);

    const base = normalizeSlashEnd(calendarUrl);
    const uid = data.uid || uuidv4();
    const href = `${base}/${uid}.ics`;
    const ics = buildFn(data, uid);

    try {
      const response = await this.mkIcsPut(
        href,
        ics,
        { "If-None-Match": "*" },
        (s) => s === 201 || s === 204
      );
      const etag = response.headers["etag"] || "";
      const newCtag = await this.getCtag(base);
      return { uid, href: `${base}/${uid}.ics`, etag, newCtag };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 412) {
        throw new Error(
          `${
            itemType[0].toUpperCase() + itemType.slice(1)
          } with the specified uid already exists.`
        );
      }
      throw new Error(`Failed to create ${itemType}: ${error}`);
    }
  }

  private async updateItem<
    T extends { uid: string; href: string; etag?: string }
  >(
    calendarUrl: string,
    item: T,
    buildFn: (item: T, uid: string) => string,
    itemType: "event" | "todo"
  ): Promise<{ uid: string; href: string; etag: string; newCtag: string }> {
    if (!item.uid || !item.href) {
      throw new Error(
        `Both 'uid' and 'href' are required to update a ${itemType}.`
      );
    }

    const base = normalizeSlashEnd(calendarUrl);
    const ics = buildFn(item, item.uid);

    const ifMatch = this.cleanEtag(item.etag);
    const extraHeaders: Record<string, string> = {};
    if (ifMatch && !this.isWeak(ifMatch)) {
      extraHeaders["If-Match"] = ifMatch;
    }

    try {
      const response = await this.mkIcsPut(item.href, ics, extraHeaders);
      const newEtag = response.headers["etag"] || "";
      const newCtag = await this.getCtag(base);
      return { uid: item.uid, href: item.href, etag: newEtag, newCtag };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 412) {
        throw new Error(
          `${
            itemType[0].toUpperCase() + itemType.slice(1)
          } with the specified uid does not match.`
        );
      }
      throw new Error(`Failed to update ${itemType}: ${error}`);
    }
  }

  private async deleteItem(
    calendarUrl: string,
    uid: string,
    itemType: "event" | "todo",
    etag?: string
  ): Promise<void> {
    const base = normalizeSlashEnd(calendarUrl);
    const href = `${base}/${uid}.ics`;
    try {
      await this.httpClient.delete(href, {
        headers: { "If-Match": etag ?? "*" },
        validateStatus: (s) => s === 200 || s === 204,
      });
    } catch (error) {
      throw new Error(`Failed to delete ${itemType}: ${error}`);
    }
  }

  private async getItemRefs(
    calendarUrl: string,
    component: "VEVENT" | "VTODO"
  ): Promise<{ href: string; etag: string }[]> {
    const requestBody = `
      <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop><d:getetag/></d:prop>
        <c:filter>
          <c:comp-filter name="VCALENDAR">
            <c:comp-filter name="${component}"/>
          </c:comp-filter>
        </c:filter>
      </c:calendar-query>`;

    const data = await this.report(calendarUrl, requestBody, "1");
    const jsonData = this.parser.parse(data);

    const raw = jsonData?.multistatus?.response;
    const responses = Array.isArray(raw) ? raw : raw ? [raw] : [];

    const refs: { href: string; etag: string }[] = [];
    for (const obj of responses) {
      if (!obj || typeof obj !== "object") continue;
      const href = obj["href"];
      const etag = obj?.propstat?.prop?.getetag;
      if (href && etag) refs.push({ href, etag });
    }
    return refs;
  }

  public async getEventsByHref(
    calendarUrl: string,
    hrefs: string[]
  ): Promise<Event[]> {
    return this.getItemsByHref<Event>(calendarUrl, hrefs, parseEvents);
  }

  public async getTodosByHref(
    calendarUrl: string,
    hrefs: string[]
  ): Promise<Todo[]> {
    return this.getItemsByHref<Todo>(calendarUrl, hrefs, parseTodos);
  }

  private async getItemsByHref<T>(
    calendarUrl: string,
    hrefs: string[],
    parseFn: (xml: string) => Promise<T[]>
  ): Promise<T[]> {
    if (!hrefs.length) return [];

    const filtered = hrefs.filter((h) => h.endsWith(".ics"));
    if (!filtered.length) return [];

    const requestBody = `
      <c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
          <d:getetag/>
          <c:calendar-data/>
        </d:prop>
        ${filtered.map((h) => `<d:href>${h}</d:href>`).join("")}
      </c:calendar-multiget>`;

    const xml = await this.report(calendarUrl, requestBody, "1");
    return await parseFn(xml);
  }

  /*
   * Utility Methods
   */

  private absolutize(urlOrPath: string): string {
    try {
      // If it's already an absolute URL, extract just the path
      const parsed = new URL(urlOrPath);
      return parsed.pathname + parsed.search + parsed.hash;
    } catch {
      // It's a relative path, resolve it against baseUrl
      const resolved = new URL(urlOrPath, this.baseUrl);
      const fullPath = resolved.pathname + resolved.search + resolved.hash;

      // If baseUrl has a path component and the resolved path starts with it,
      // we may need to deduplicate (e.g., if baseUrl is https://example.com/dav
      // and urlOrPath is /dav/.well-known, we don't want /dav/dav/.well-known)
      const basePath = new URL(this.baseUrl).pathname;
      if (basePath !== '/' && fullPath.startsWith(basePath + basePath)) {
        // Remove the duplicate basePath
        return fullPath.substring(basePath.length);
      }

      return fullPath;
    }
  }

  private resolveUrl(path: string): string {
    const basePath = new URL(this.baseUrl).pathname;
    if (path.startsWith(basePath) && basePath !== "/") {
      const stripped = path.substring(basePath.length);
      return stripped.startsWith("/") ? stripped : "/" + stripped;
    }
    return path;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getHrefFromProp(parsed: any, propName: string): string | null {
    const ms = parsed?.multistatus;
    const resp = first(ms?.response);
    const pstat = first(resp?.propstat);
    const prop = pstat?.prop;
    const node = prop?.[propName];
    if (!node) return null;

    if (typeof node === "string") return node;
    if (typeof node?.href === "string") return node.href;

    const maybe = first(node);
    if (typeof maybe === "string") return maybe;
    if (maybe && typeof maybe.href === "string") return maybe.href;

    return null;
  }

  private isWeak(etag?: string): boolean {
    return !!etag && (etag.startsWith('W/"') || etag.startsWith("W/"));
  }

  private cleanEtag(etag?: string): string | undefined {
    if (!etag) return undefined;
    return etag.replace(/^W\//, "").trim();
  }

  /*
   * HTTP Methods
   */

  private async propfind(
    url: string,
    depth: "0" | "1",
    body: string,
    extra?: AxiosRequestConfig
  ): Promise<unknown> {
    const res = await this.httpClient.request({
      method: "PROPFIND",
      url,
      data: body,
      headers: {
        Depth: depth,
        Prefer: "return=minimal",
        "Content-Type": XML_CT,
      },
      validateStatus: (s) => s === 207 || s === 200,
      ...extra,
    });
    return this.parser.parse(res.data);
  }

  private async report(
    url: string,
    body: string,
    depth: "0" | "1" = "1",
    extra?: AxiosRequestConfig
  ): Promise<string> {
    const res = await this.httpClient.request({
      method: "REPORT",
      url,
      data: body,
      headers: { Depth: depth, "Content-Type": XML_CT },
      validateStatus: (s) => s >= 200 && s < 300,
      ...extra,
    });
    return res.data as string;
  }

  private async mkIcsPut(
    href: string,
    ics: string,
    headers?: Record<string, string>,
    validate?: (status: number) => boolean
  ) {
    return this.httpClient.put(href, ics, {
      headers: { "Content-Type": ICS_CT, ...(headers || {}) },
      validateStatus: validate ?? ((s) => s >= 200 && s < 300),
    });
  }

  private async followRedirectOnce(url: string): Promise<string> {
    try {
      const res = await this.httpClient.request({
        method: "GET",
        url,
        maxRedirects: 0,
        validateStatus: (s) => (s >= 200 && s < 300) || (s >= 300 && s < 400),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers["location"];
        if (!loc) throw new Error(`Redirect without Location from ${url}`);
        return this.absolutize(loc);
      }
      return url;
    } catch {
      return url;
    }
  }
}
