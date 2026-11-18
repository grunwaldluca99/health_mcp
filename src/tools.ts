import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { env as workerEnv } from "cloudflare:workers";
import { z } from "zod";
import type { Env, Props } from "./env";
import { garminFetch, trimActivity } from "./garmin";
import { DATA_TYPES, type DataType, dailyRollup, listPoints } from "./google";

const env = workerEnv as unknown as Env;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD, your local date");

function props(): Props {
  const p = getMcpAuthContext()?.props as Props | undefined;
  if (!p?.googleRefreshToken) throw new Error("Not signed in with Google. Reconnect the server.");
  return p;
}

function days(start: string, end: string) {
  return (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
}
function checkRange(start: string, end: string, max: number) {
  const n = days(start, end);
  if (!(n >= 1)) throw new Error("end_date must be on or after start_date");
  if (n > max) throw new Error(`Range too long: ${n} days, max ${max}. Split it into smaller requests.`);
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/** Drops bookkeeping fields (createTime, updateTime, ...) that only cost the agent tokens. */
function slim(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(slim);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "createTime" || k === "updateTime" || k === "startUtcOffset" || k === "endUtcOffset" || k === "shortAwakenings") continue;
      out[k] = slim(v);
    }
    return out;
  }
  return value;
}

export function createServer() {
  const server = new McpServer({ name: "health-mcp", version: "0.1.0" });

  // ---------- Google Health (Fitbit): everyday health ----------

  server.registerTool(
    "get_health_data",
    {
      description:
        "Read raw Google Health (Fitbit) data points for a date range, de-duplicated across sources. " +
        "Use daily-* types for daily values (resting HR, HRV, SpO2, breathing rate). Sleep includes stages and a summary. " +
        "Raw heart-rate is per-second: keep that range to 1 day or use get_daily_totals.",
      inputSchema: {
        data_type: z.enum(Object.keys(DATA_TYPES) as [DataType, ...DataType[]]),
        start_date: date,
        end_date: date,
        max_points: z.number().int().min(1).max(2000).default(500),
      },
    },
    async ({ data_type, start_date, end_date, max_points }) => {
      checkRange(start_date, end_date, data_type === "heart-rate" ? 1 : 90);
      const res = await listPoints(env, props(), data_type, start_date, end_date, max_points);
      return json({ ...res, points: res.points.map(slim) });
    },
  );

  server.registerTool(
    "get_daily_totals",
    {
      description: "Per-day totals or averages from Google Health, in local time (e.g. steps per day, distance, active zone minutes, heart rate min/avg/max).",
      inputSchema: {
        data_type: z.enum(["steps", "distance", "active-zone-minutes", "heart-rate", "weight"]),
        start_date: date,
        end_date: date,
      },
    },
    async ({ data_type, start_date, end_date }) => {
      checkRange(start_date, end_date, ["heart-rate", "active-zone-minutes"].includes(data_type) ? 14 : 90);
      return json(await dailyRollup(env, props(), data_type, start_date, end_date));
    },
  );

  // ---------- Garmin: workouts and VO2max ----------

  server.registerTool(
    "get_workouts",
    {
      description: "List Garmin workouts (activities) in a date range, newest first, with the key metrics: distance, duration, HR, power, training effect, load, HR zones.",
      inputSchema: {
        start_date: date,
        end_date: date,
        activity_type: z.string().optional().describe("Parent type key, e.g. running, cycling, strength_training"),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async ({ start_date, end_date, activity_type, limit }) => {
      checkRange(start_date, end_date, 366);
      const q = new URLSearchParams({ startDate: start_date, endDate: end_date, limit: String(limit) });
      if (activity_type) q.set("activityType", activity_type);
      const list = (await garminFetch(env, `/activitylist-service/activities/search/activities?${q}`)) as any[];
      return json(list.map(trimActivity));
    },
  );

  server.registerTool(
    "get_workout",
    {
      description: "Full Garmin summary for one workout by activityId (from get_workouts), including splits.",
      inputSchema: { activity_id: z.number().int().positive() },
    },
    async ({ activity_id }) => json(await garminFetch(env, `/activity-service/activity/${activity_id}`)),
  );

  server.registerTool(
    "get_vo2max",
    {
      description: "Garmin VO2max per day (running/generic and cycling) for a date range.",
      inputSchema: { start_date: date, end_date: date },
    },
    async ({ start_date, end_date }) => {
      checkRange(start_date, end_date, 366);
      const rows = (await garminFetch(env, `/metrics-service/metrics/maxmet/daily/${start_date}/${end_date}`)) as any[];
      return json(
        (rows ?? []).map((r) => ({
          date: r.generic?.calendarDate ?? r.cycling?.calendarDate,
          running: r.generic?.vo2MaxPreciseValue ?? r.generic?.vo2MaxValue,
          cycling: r.cycling?.vo2MaxPreciseValue ?? r.cycling?.vo2MaxValue,
        })),
      );
    },
  );

  return server;
}
