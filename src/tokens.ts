import { readSecret, writeSecret } from "./secret-storage.js";

export type StoredToken = {
  env: "sandbox" | "prod";
  oauth_token: string;
  oauth_token_secret: string;
  obtained_at: string;
  expires_at_midnight_et: string;
};

export function writeToken(filePath: string, token: StoredToken, encryptionKey?: string): void {
  writeSecret(filePath, token, encryptionKey);
}

export function readToken(filePath: string, encryptionKey?: string): StoredToken | null {
  try {
    const token = readSecret(filePath, encryptionKey) as StoredToken;
    if (!token || (token.env !== "sandbox" && token.env !== "prod") ||
        typeof token.oauth_token !== "string" || !token.oauth_token ||
        typeof token.oauth_token_secret !== "string" || !token.oauth_token_secret ||
        typeof token.obtained_at !== "string" || !Number.isFinite(Date.parse(token.obtained_at)) ||
        typeof token.expires_at_midnight_et !== "string" || !Number.isFinite(Date.parse(token.expires_at_midnight_et))) return null;
    return token;
  } catch { return null; }
}

export function isTokenExpired(token: StoredToken, now: Date = new Date()): boolean {
  const expiry = Date.parse(token.expires_at_midnight_et);
  return !Number.isFinite(expiry) || now.getTime() >= expiry;
}

/**
 * Returns an ISO-8601 string representing the next midnight in America/New_York,
 * with a correct -04:00 (EDT) or -05:00 (EST) offset.
 */
export function computeEtMidnightExpiry(now: Date = new Date()): string {
  // Format the CURRENT instant as it appears in NY to figure out which calendar day we're on there.
  const nyParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = nyParts.find((p) => p.type === "year")!.value;
  const m = nyParts.find((p) => p.type === "month")!.value;
  const d = nyParts.find((p) => p.type === "day")!.value;

  // Advance the ET calendar day; a DST transition day can have 23 or 25 hours.
  const tomorrow = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + 1)).toISOString().slice(0, 10);
  const tomorrowNyMidnightUtc = zonedDateToUtc(`${tomorrow}T00:00:00`, "America/New_York");

  // Compute the offset that applies at tomorrow-midnight-NY.
  const offset = getTzOffsetString(tomorrowNyMidnightUtc, "America/New_York");
  const tomorrowParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(tomorrowNyMidnightUtc);
  const ty = tomorrowParts.find((p) => p.type === "year")!.value;
  const tm = tomorrowParts.find((p) => p.type === "month")!.value;
  const td = tomorrowParts.find((p) => p.type === "day")!.value;

  return `${ty}-${tm}-${td}T00:00:00${offset}`;
}

function zonedDateToUtc(isoLocal: string, timeZone: string): Date {
  // Interpret the string as local-to-timeZone. We construct a UTC date, then correct by the zone offset.
  const asIfUtc = new Date(`${isoLocal}Z`);
  let instant = asIfUtc;
  for (let i = 0; i < 3; i++) instant = new Date(asIfUtc.getTime() - getTzOffsetMinutes(instant, timeZone) * 60 * 1000);
  return instant;
}

function getTzOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number.parseInt(parts.find((p) => p.type === t)!.value, 10);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return (asUtc - date.getTime()) / 60000;
}

function getTzOffsetString(date: Date, timeZone: string): string {
  const mins = getTzOffsetMinutes(date, timeZone);
  const sign = mins >= 0 ? "+" : "-";
  const abs = Math.abs(mins);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}
