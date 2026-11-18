import type { Env, Props } from "./env";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const HEALTH_BASE = "https://health.googleapis.com/v4/users/me";

const G = "https://www.googleapis.com/auth/googlehealth.";
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  `${G}activity_and_fitness.readonly`,
  `${G}health_metrics_and_measurements.readonly`,
  `${G}sleep.readonly`,
  `${G}nutrition.readonly`,
  `${G}nutrition.writeonly`,
];

export interface GoogleTokens {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
}

export class GoogleAuthRevoked extends Error {}

async function tokenRequest(body: Record<string, string>): Promise<GoogleTokens> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json()) as GoogleTokens & { error?: string; error_description?: string };
  if (!res.ok) {
    if (json.error === "invalid_grant") throw new GoogleAuthRevoked(json.error_description ?? "invalid_grant");
    throw new Error(`Google token endpoint ${res.status}: ${json.error} ${json.error_description ?? ""}`);
  }
  return json;
}

export function exchangeCode(env: Env, code: string, verifier: string, redirectUri: string) {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  });
}

export function refreshGoogle(env: Env, refreshToken: string) {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  });
}

/** Reads the email out of the id_token. Safe without signature check: it came straight from Google's token endpoint over TLS (OIDC Core 3.1.3.7). */
export function emailFromIdToken(idToken: string): { email: string; verified: boolean } {
  const payload = JSON.parse(atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  return { email: String(payload.email ?? "").toLowerCase(), verified: payload.email_verified === true };
}

/** Access token for this request. Normally fresh from props; refreshed here only if it already expired. */
async function accessToken(env: Env, props: Props): Promise<string> {
  if (Date.now() < props.googleExpiresAt - 60_000) return props.googleAccessToken;
  const t = await refreshGoogle(env, props.googleRefreshToken);
  return t.access_token;
}

export async function healthFetch(env: Env, props: Props, path: string, init: RequestInit = {}): Promise<any> {
  const token = await accessToken(env, props);
  const res = await fetch(`${HEALTH_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Health ${res.status} on ${path}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

/** How each data type is filtered by date (filter identifiers are snake_case). */
export const DATA_TYPES = {
  steps: "interval",
  distance: "interval",
  "active-zone-minutes": "interval",
  "heart-rate": "sample",
  "heart-rate-variability": "sample",
  "oxygen-saturation": "sample",
  weight: "sample",
  "body-fat": "sample",
  "daily-resting-heart-rate": "daily",
  "daily-heart-rate-variability": "daily",
  "daily-oxygen-saturation": "daily",
  "daily-respiratory-rate": "daily",
  sleep: "sleep",
  exercise: "exercise",
  "nutrition-log": "interval",
  "hydration-log": "interval",
} as const;
export type DataType = keyof typeof DATA_TYPES;

/** Builds a civil-time (your local time) filter for [startDate, endDateInclusive]. */
export function dateFilter(type: DataType, startDate: string, endDateInclusive: string): string {
  const id = type.replace(/-/g, "_");
  const end = nextDay(endDateInclusive);
  const field = {
    interval: `${id}.interval.civil_start_time`,
    sample: `${id}.sample_time.civil_time`,
    daily: `${id}.date`,
    sleep: `sleep.interval.civil_end_time`, // sleep only filters on end time
    exercise: `exercise.interval.civil_start_time`,
  }[DATA_TYPES[type]];
  return `${field} >= "${startDate}" AND ${field} < "${end}"`;
}

export function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Lists de-duplicated data points (reconcile), following pages up to maxPoints. */
export async function listPoints(env: Env, props: Props, type: DataType, startDate: string, endDate: string, maxPoints = 500) {
  const points: unknown[] = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ filter: dateFilter(type, startDate, endDate), pageSize: String(Math.min(maxPoints, 1000)) });
    if (pageToken) q.set("pageToken", pageToken);
    const res = await healthFetch(env, props, `/dataTypes/${type}/dataPoints:reconcile?${q}`);
    points.push(...(res.dataPoints ?? []));
    pageToken = res.nextPageToken ?? "";
  } while (pageToken && points.length < maxPoints);
  return { points: points.slice(0, maxPoints), truncated: Boolean(pageToken) || points.length > maxPoints };
}

/** Daily totals in your local time, e.g. steps per day. */
export async function dailyRollup(env: Env, props: Props, type: DataType, startDate: string, endDate: string) {
  const civil = (date: string) => {
    const [year, month, day] = date.split("-").map(Number);
    return { date: { year, month, day }, time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 } };
  };
  return healthFetch(env, props, `/dataTypes/${type}/dataPoints:dailyRollUp`, {
    method: "POST",
    body: JSON.stringify({ range: { start: civil(startDate), end: civil(nextDay(endDate)) }, windowSizeDays: 1 }),
  });
}

/**
 * Google requires every food log to name a measurement unit (a resource like
 * users/me/dataTypes/food-measurement-unit/dataPoints/123). The list is per-account
 * and undocumented in shape, so we fetch it once, cache it in KV for a day, and
 * match units by the words in their JSON.
 */
export async function foodUnits(env: Env, props: Props): Promise<any[]> {
  const cached = await env.OAUTH_KV.get("google:food-units", "json");
  if (cached) return cached as any[];
  const units: any[] = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ pageSize: "1000" });
    if (pageToken) q.set("pageToken", pageToken);
    const res = await healthFetch(env, props, `/dataTypes/food-measurement-unit/dataPoints?${q}`);
    units.push(...(res.dataPoints ?? []));
    pageToken = res.nextPageToken ?? "";
  } while (pageToken && units.length < 5000);
  if (units.length) await env.OAUTH_KV.put("google:food-units", JSON.stringify(units), { expirationTtl: 86400 });
  return units;
}

/** Text describing a unit, without its id, for matching (e.g. "serving", "gram"). */
function unitText(u: any): string {
  const { name, dataPointName, ...rest } = u ?? {};
  return JSON.stringify(rest).toLowerCase();
}

/** The unit's resource name. Searches the whole object, since the response shape is undocumented. */
export function unitName(u: any): string {
  const RE = /dataTypes\/food-measurement-unit\/dataPoints\/[^/"]+$/;
  const walk = (v: any): string | undefined => {
    if (typeof v === "string") return RE.test(v) ? v : undefined;
    if (v && typeof v === "object") for (const x of Object.values(v)) { const hit = walk(x); if (hit) return hit; }
    return undefined;
  };
  const found = walk(u);
  if (found) return found.replace(/^users\/[^/]+\//, "users/me/");
  const id = u?.id ?? u?.dataPointId;
  if (id) return `users/me/dataTypes/food-measurement-unit/dataPoints/${id}`;
  throw new Error(`Can't find the resource name of food unit: ${JSON.stringify(u).slice(0, 400)}`);
}

/** Finds the unit matching a word like "serving", "gram" or "piece"; exact display-name match first. */
export function findUnit(units: any[], word: string): any | undefined {
  const w = word.toLowerCase().trim();
  const exact = units.find((u) => new RegExp(`"${w}s?"`).test(unitText(u)));
  return exact ?? units.find((u) => unitText(u).includes(w));
}
