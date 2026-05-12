import { Temporal } from 'temporal-polyfill';

/**
 * Helper function to format dates for iCalendar.
 * @param date - The Date or Temporal.ZonedDateTime to format.
 * @param utc - Whether to format in UTC (default: true)
 * @returns A formatted date string.
 */
export const formatDate = (date: Date | Temporal.ZonedDateTime, utc: boolean = true): string => {
  const pad = (n: number): string => n.toString().padStart(2, "0");

  // Handle Date objects (backward compatibility)
  if (date instanceof Date) {
    if (utc) {
      return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    } else {
      return (
        date.getFullYear().toString() +
        pad(date.getMonth() + 1) +
        pad(date.getDate()) +
        "T" +
        pad(date.getHours()) +
        pad(date.getMinutes()) +
        pad(date.getSeconds())
      );
    }
  }

  // Handle Temporal.ZonedDateTime
  if (utc) {
    // Convert to UTC/Instant and format
    const instant = date.toInstant();
    const utcDateTime = instant.toZonedDateTimeISO('UTC');
    return (
      utcDateTime.year.toString() +
      pad(utcDateTime.month) +
      pad(utcDateTime.day) +
      "T" +
      pad(utcDateTime.hour) +
      pad(utcDateTime.minute) +
      pad(utcDateTime.second) +
      "Z"
    );
  } else {
    // Format in local timezone
    return (
      date.year.toString() +
      pad(date.month) +
      pad(date.day) +
      "T" +
      pad(date.hour) +
      pad(date.minute) +
      pad(date.second)
    );
  }
};

/**
 * Helper function to format dates for all-day iCalendar events.
 * @param date - The Date or Temporal.ZonedDateTime to format.
 * @returns A formatted date-only string (YYYYMMDD).
 */
export const formatDateOnly = (date: Date | Temporal.ZonedDateTime): string => {
  const pad = (n: number): string => n.toString().padStart(2, "0");

  // Handle Date objects (backward compatibility)
  if (date instanceof Date) {
    return date.toISOString().split("T")[0].replace(/-/g, "");
  }

  // Handle Temporal.ZonedDateTime
  return date.year.toString() + pad(date.month) + pad(date.day);
};
