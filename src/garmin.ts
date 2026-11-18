import type { Env } from "./env";

const BASE = "https://personal.connectapi.garmin.com";
const TOKEN_URL = `${BASE}/personalapitoken-service/personal-api/personal-api-key/token`;
const CACHE_KEY = "garmin:access-token";

/**
 * Garmin Personal API: the long-lived key is swapped for a 24h access token.
 * We cache that token in KV so we don't hit the token endpoint on every call.
 */
async function garminToken(env: Env): Promise<string> {
  const cached = await env.OAUTH_KV.get(CACHE_KEY);
  if (cached) return cached;
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { Authorization: `ApiKey ${env.GARMIN_API_KEY}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Garmin token exchange ${res.status}: ${text.slice(0, 300)}`);
  // Garmin returns the access token as a bare JWT string (not JSON). Handle both shapes.
  const trimmed = text.trim().replace(/^"|"$/g, "");
  let token: string | undefined;
  let ttl = 86400;
  if (trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed);
    token = json.access_token ?? json.accessToken ?? json.token;
    ttl = Number(json.expires_in ?? json.expiresIn ?? ttl);
  } else {
    token = trimmed;
    ttl = jwtSecondsLeft(trimmed) ?? ttl;
  }
  if (!token) throw new Error("Garmin token response had no token");
  await env.OAUTH_KV.put(CACHE_KEY, token, { expirationTtl: Math.max(60, ttl - 600) });
  return token;
}

/** Seconds until a JWT's exp claim, or undefined if it can't be read. */
function jwtSecondsLeft(jwt: string): number | undefined {
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.exp === "number" ? Math.floor(payload.exp - Date.now() / 1000) : undefined;
  } catch {
    return undefined;
  }
}

async function garminRequest(env: Env, path: string, accept: string): Promise<Response> {
  let token = await garminToken(env);
  let res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: accept } });
  if (res.status === 401) {
    // Cached token went stale (key regenerated?): drop it and try once more.
    await env.OAUTH_KV.delete(CACHE_KEY);
    token = await garminToken(env);
    res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: accept } });
  }
  return res;
}

/** Binary download (e.g. the original FIT file, which Garmin wraps in a ZIP). */
export async function garminFetchBytes(env: Env, path: string): Promise<Uint8Array> {
  const res = await garminRequest(env, path, "application/octet-stream, application/zip, */*");
  if (!res.ok) throw new Error(`Garmin ${res.status} on ${path}: ${(await res.text()).slice(0, 300)}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function garminFetch(env: Env, path: string): Promise<any> {
  const res = await garminRequest(env, path, "application/json");
  const text = await res.text();
  if (!res.ok) throw new Error(`Garmin ${res.status} on ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** The activity fields worth handing to an AI agent (the full DTO has ~250). */
const ACTIVITY_FIELDS = [
  "activityId", "activityName", "startTimeLocal", "activityType", "eventType", "distance", "duration", "movingDuration",
  "elevationGain", "averageSpeed", "avgGradeAdjustedSpeed", "calories", "averageHR", "maxHR", "avgPower", "normPower",
  "averageRunningCadenceInStepsPerMinute", "aerobicTrainingEffect", "anaerobicTrainingEffect", "trainingEffectLabel",
  "activityTrainingLoad", "vO2MaxValue", "lactateThresholdBpm", "hrTimeInZone_1", "hrTimeInZone_2", "hrTimeInZone_3",
  "hrTimeInZone_4", "hrTimeInZone_5", "moderateIntensityMinutes", "vigorousIntensityMinutes", "differenceBodyBattery",
  "totalSets", "totalReps", "lapCount",
] as const;

export function trimActivity(a: Record<string, any>) {
  const out: Record<string, unknown> = {};
  for (const f of ACTIVITY_FIELDS) if (a[f] !== undefined && a[f] !== null) out[f] = a[f];
  if (a.activityType?.typeKey) out.activityType = a.activityType.typeKey;
  if (a.eventType?.typeKey) out.eventType = a.eventType.typeKey;
  return out;
}
