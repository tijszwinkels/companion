/**
 * The time on a message's heading line (the shell README, "Message
 * timestamps"), without DOM access.
 *
 * Rule:
 * 1. Only a message with `createdAt` (epoch milliseconds on the listener's
 *    clock, set once when the listener created it) shows a time; nothing
 *    is invented for one without, and none is shown while the Message
 *    timestamps switch is off.
 * 2. The time is the reader's: `createdAt - offset` (./listener-clock.ts),
 *    in this browser's time zone, compared with this browser's today.
 * 3. Written today: `HH:MM` (24-hour). Yesterday: `Yesterday HH:MM`. Any
 *    other day: day, month and time, `18 Nov 14:02`, with the year added
 *    for another year than this one (`3 Dec 2025 09:15`). Days are calendar
 *    days in the reader's time zone, so a message from 23:59 is
 *    "Yesterday" one minute later.
 * 4. Updates of a message (streaming text, a queued message starting)
 *    keep its `createdAt`, so its time does not change.
 *
 * The calendar is a parameter so tests can use any time zone; the page
 * uses this browser's (`browserCalendar`).
 */

/** A moment as a calendar shows it in one time zone. */
export interface CalendarTime {
  year: number;
  /** 1 to 12. */
  month: number;
  /** 1 to 31. */
  day: number;
  /** 0 to 23. */
  hour: number;
  /** 0 to 59. */
  minute: number;
}

/** Converts epoch milliseconds to the calendar of one time zone. */
export type LocalCalendar = (epochMilliseconds: number) => CalendarTime;

/** This browser's time zone. */
export const browserCalendar: LocalCalendar = (epochMilliseconds) => {
  const date = new Date(epochMilliseconds);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
};

/** The calendar of a named time zone (`Europe/Amsterdam`), for tests and checks. */
export function zoneCalendar(timeZone: string): LocalCalendar {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });
  return (epochMilliseconds) => {
    const parts: Record<string, number> = {};
    for (const part of format.formatToParts(new Date(epochMilliseconds))) {
      if (part.type !== 'literal') {
        parts[part.type] = Number(part.value);
      }
    }
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
    };
  };
}

const monthNames = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/** Whether two calendar times fall on the same calendar day. */
function sameDay(first: CalendarTime, second: CalendarTime): boolean {
  return first.year === second.year && first.month === second.month && first.day === second.day;
}

/**
 * Whether `earlier` falls on the calendar day before `later`'s. Computed on
 * the calendar dates themselves, so days of 23 or 25 hours (daylight saving
 * changes) make no difference.
 */
function dayBefore(earlier: CalendarTime, later: CalendarTime): boolean {
  const oneDay = 24 * 60 * 60 * 1000;
  const laterDate = Date.UTC(later.year, later.month - 1, later.day);
  const earlierDate = Date.UTC(earlier.year, earlier.month - 1, earlier.day);
  return laterDate - earlierDate === oneDay;
}

/**
 * The heading's time for a message, or '' when it shows none.
 *
 * `createdAt` is the message's field as the listener sent it (anything);
 * `offset` the listener's clock minus this browser's; `readerNow` this
 * browser's clock now.
 */
export function messageTimeText(
  createdAt: unknown,
  offset: number,
  readerNow: number,
  calendar: LocalCalendar = browserCalendar,
): string {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) {
    return '';
  }
  // A moment a JavaScript date can hold (±8.64e15 ms), else no time.
  const readerMoment = createdAt - offset;
  if (Math.abs(readerMoment) > 8.64e15) {
    return '';
  }
  const written = calendar(readerMoment);
  const today = calendar(readerNow);
  const clock = `${twoDigits(written.hour)}:${twoDigits(written.minute)}`;

  if (sameDay(written, today)) {
    return clock;
  }
  if (dayBefore(written, today)) {
    return `Yesterday ${clock}`;
  }
  const month = monthNames[written.month - 1];
  if (written.year !== today.year) {
    return `${written.day} ${month} ${written.year} ${clock}`;
  }
  return `${written.day} ${month} ${clock}`;
}

/**
 * Milliseconds from `readerNow` until the next calendar day starts in the
 * calendar's time zone (when "today" becomes "yesterday"), at least 1.
 *
 * Found on the calendar itself, not only by counting the wall clock's
 * minutes, so a daylight saving change around midnight (a skipped or a
 * repeated hour) is no error: the wall clock gives an estimate (the
 * minutes left in today), and the first whole minute after `readerNow` on
 * another date is looked for in order, from an hour and a minute before
 * that estimate to as long after it (a change moves midnight by at most an
 * hour). Time zones differ from UTC by whole minutes, so days start on
 * whole minutes. Should none be found there, the estimate is used; the
 * caller checks again after waiting.
 */
export function untilNextDay(readerNow: number, calendar: LocalCalendar = browserCalendar): number {
  const minute = 60 * 1000;
  const today = calendar(readerNow);
  const nowMinute = Math.floor(readerNow / minute);

  const minutesLeft = (23 - today.hour) * 60 + (59 - today.minute);
  const estimate = nowMinute + minutesLeft + 1;
  const first = Math.max(nowMinute + 1, estimate - 61);
  const last = estimate + 61;

  for (let candidate = first; candidate <= last; candidate++) {
    if (!sameDay(calendar(candidate * minute), today)) {
      return Math.max(1, candidate * minute - readerNow);
    }
  }
  return Math.max(1, estimate * minute - readerNow);
}
