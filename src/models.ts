import { Temporal } from 'temporal-polyfill';

export interface CalDAVOptions {
  baseUrl: string;
  auth: AuthOptions;
  requestTimeout?: number;
  logRequests?: boolean;
  prodId?: string;
}

export type AuthOptions =
  | { type: "basic"; username: string; password: string }
  | { type: "oauth"; accessToken: string };

export type SupportedComponent =
  | "VEVENT"
  | "VTODO"
  | "VJOURNAL"
  | "VFREEBUSY"
  | "VTIMEZONE";

export type RecurrenceRule = {
  freq?: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval?: number;
  count?: number;
  until?: Temporal.ZonedDateTime;
  wkst?: string;
  byday?: string[];
  bymonthday?: number[];
  bymonth?: number[];
  exdate?: string[]; // EXDATE property - exception dates to exclude from recurrence
};

export type Alarm =
  | {
      action: "DISPLAY";
      trigger: string;
      description?: string;
    }
  | {
      action: "EMAIL";
      trigger: string;
      description?: string;
      summary?: string;
      attendees: string[];
    }
  | {
      action: "AUDIO";
      trigger: string;
    };

export interface EventRef {
  href: string;
  etag: string;
}

export interface SyncChangesResult {
  changed: boolean;
  newCtag: string;
  newEvents: string[];
  updatedEvents: string[];
  deletedEvents: string[];
}

export interface Calendar {
  displayName: string;
  url: string;
  ctag?: string;
  supportedComponents: SupportedComponent[];
  color?: string;
}

export const EVENT_STATUSES = ["TENTATIVE", "CONFIRMED", "CANCELLED"] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface Attendee {
  email: string;
  cn?: string; // Common Name
  partstat?: "NEEDS-ACTION" | "ACCEPTED" | "DECLINED" | "TENTATIVE" | "DELEGATED";
  role?: "CHAIR" | "REQ-PARTICIPANT" | "OPT-PARTICIPANT" | "NON-PARTICIPANT";
  cutype?: "INDIVIDUAL" | "GROUP" | "RESOURCE" | "ROOM" | "UNKNOWN";
  rsvp?: boolean;
}

export interface Event {
  uid: string;
  summary: string;
  start: Temporal.ZonedDateTime;
  end: Temporal.ZonedDateTime;
  description?: string;
  location?: string;
  status?: EventStatus;
  etag: string;
  href: string;
  wholeDay?: boolean;
  recurrenceRule?: RecurrenceRule;
  recurrenceId?: Temporal.ZonedDateTime; // For RECURRENCE-ID property (single instance modifications)
  startTzid?: string;
  endTzid?: string;
  alarms?: Alarm[];
  attendees?: Attendee[];
  partstat?: "NEEDS-ACTION" | "ACCEPTED" | "DECLINED" | "TENTATIVE"; // Current user's participation status
  calendarId?: string; // Added for convenience, not part of iCalendar spec
}

export type TodoRef = EventRef;

export interface VTimezone {
  tzid: string;
  raw: string;
}

export interface SyncTodosResult {
  changed: boolean;
  newCtag: string;
  newTodos: string[];
  updatedTodos: string[];
  deletedTodos: string[];
}

export const TODO_STATUSES = [
  "NEEDS-ACTION",
  "COMPLETED",
  "IN-PROCESS",
  "CANCELLED",
] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface Todo {
  uid: string;
  summary: string;
  start?: Temporal.ZonedDateTime;
  due?: Temporal.ZonedDateTime;
  completed?: Temporal.ZonedDateTime;
  status?: TodoStatus;
  description?: string;
  location?: string;
  etag: string;
  href: string;
  alarms?: Alarm[];
  sortOrder?: number;
}

export interface CalDAVClientCache {
  userPrincipal: string;
  calendarHome: string;
  prodId?: string;
}
