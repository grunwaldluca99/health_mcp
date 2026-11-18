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
  const json = JSON.parse(text);
  // Field names aren't documented; accept the common spellings.
  const token: string | undefined = json.access_token ?? json.accessToken ?? json.token;
  if (!token) throw new Error(`Garmin token response had no token field. Keys: ${Object.keys(json).join(", ")}`);
  const ttl = Number(json.expires_in ?? json.expiresIn ?? 86400);
  await env.OAUTH_KV.put(CACHE_KEY, token, { expirationTtl: Math.max(60, ttl - 600) });
  return token;
}

export async function garminFetch(env: Env, path: string): Promise<any> {
  let token = await garminToken(env);
  let res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (res.status === 401) {
    // Cached token went stale (key regenerated?): drop it and try once more.
    await env.OAUTH_KV.delete(CACHE_KEY);
    token = await garminToken(env);
    res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  }
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
