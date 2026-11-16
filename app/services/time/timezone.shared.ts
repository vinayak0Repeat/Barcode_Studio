/**
 * Pure shop-timezone day/month boundaries (client-safe, unit tested).
 *
 * The Shop model has NO cached timezone column today (no ianaTimezone), so
 * callers pass null and get UTC. When the column is added, pass the IANA
 * name and every filter/stat moves to shop-local time without further
 * changes — one helper, one behavior.
 */

export interface DayMonthBoundaries {
  todayStart: Date;
  tomorrowStart: Date;
  monthStart: Date;
  nextMonthStart: Date;
}

/** Offset of `timeZone` at the given instant, in minutes (east positive). */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUTC - instant.getTime()) / 60000;
}

/** Wall-clock Y/M/D/H/M/S of `instant` in `timeZone`, as UTC components. */
function wallClock(instant: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: parts.hour === "24" ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function wallClockToDate(
  wall: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // Two-step correction handles DST boundaries where the offset shifts.
  let offset = zoneOffsetMinutes(new Date(guess), timeZone);
  let result = new Date(guess - offset * 60000);
  offset = zoneOffsetMinutes(result, timeZone);
  result = new Date(guess - offset * 60000);
  return result;
}

/**
 * UTC instants of the shop-local start-of-day (today & tomorrow) and
 * start-of-month (this & next). `timeZone = null` → UTC.
 */
export function dayMonthBoundaries(
  now: Date,
  timeZone: string | null | undefined,
): DayMonthBoundaries {
  const zone = timeZone ?? "UTC";
  const wall = wallClock(now, zone);

  const todayStart = wallClockToDate(
    { year: wall.year, month: wall.month, day: wall.day, hour: 0, minute: 0, second: 0 },
    zone,
  );
  const tomorrowWallDate = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + 1));
  const tomorrowStart = wallClockToDate({
    year: tomorrowWallDate.getUTCFullYear(), month: tomorrowWallDate.getUTCMonth() + 1,
    day: tomorrowWallDate.getUTCDate(), hour: 0, minute: 0, second: 0,
  }, zone);
  const monthStart = wallClockToDate(
    { year: wall.year, month: wall.month, day: 1, hour: 0, minute: 0, second: 0 },
    zone,
  );
  const nextMonthStart = wall.month === 12
    ? wallClockToDate({ year: wall.year + 1, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, zone)
    : wallClockToDate({ year: wall.year, month: wall.month + 1, day: 1, hour: 0, minute: 0, second: 0 }, zone);

  return { todayStart, tomorrowStart, monthStart, nextMonthStart };
}
