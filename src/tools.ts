import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { env as workerEnv } from "cloudflare:workers";
import { z } from "zod";
import type { Env, Props } from "./env";
import { garminFetch, trimActivity } from "./garmin";
import { DATA_TYPES, type DataType, dailyRollup, findUnit, foodUnits, healthFetch, listPoints, unitName } from "./google";

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

  // ---------- Food log (Google Health nutrition-log) ----------

  server.registerTool(
    "log_food",
    {
      description:
        "Log a food or meal to Google Health. Give your best estimate of calories and macros. " +
        "Entries can't be edited later, only deleted and re-logged.",
      inputSchema: {
        name: z.string().min(1).max(200),
        meal_type: z.enum(["BREAKFAST", "LUNCH", "DINNER", "SNACK"]).optional(),
        calories_kcal: z.number().min(0).max(10000),
        protein_g: z.number().min(0).optional(),
        carbs_g: z.number().min(0).optional(),
        fat_g: z.number().min(0).optional(),
        fiber_g: z.number().min(0).optional(),
        amount: z.number().positive().default(1).describe("How many units, e.g. 120 with unit gram, or 1 with unit serving"),
        unit: z.string().default("serving").describe("Unit word, e.g. serving, gram, piece, cup. See list_food_units."),
        eaten_at: z.string().datetime({ offset: true }).optional().describe("ISO time with offset, e.g. 2026-11-18T12:30:00+01:00. Defaults to now."),
      },
      annotations: { destructiveHint: false, readOnlyHint: false },
    },
    async (a) => {
      const p = props();
      const units = await foodUnits(env, p);
      const unit = findUnit(units, a.unit) ?? (a.unit === "serving" ? findUnit(units, "gram") : undefined);
      if (!unit) throw new Error(`No food unit matches "${a.unit}" (${units.length} units known). Call list_food_units to see the options.`);
      const start = a.eaten_at ? new Date(a.eaten_at) : new Date();
      const end = new Date(start.getTime() + 15 * 60_000);
      const nutrients = [
        a.protein_g !== undefined && { nutrient: "PROTEIN", quantity: { grams: a.protein_g } },
        a.fiber_g !== undefined && { nutrient: "DIETARY_FIBER", quantity: { grams: a.fiber_g } },
      ].filter(Boolean);
      const body = {
        nutritionLog: {
          interval: { startTime: start.toISOString(), endTime: end.toISOString() },
          foodDisplayName: a.name,
          ...(a.meal_type && { mealType: a.meal_type }),
          energy: { kcal: a.calories_kcal },
          ...(a.carbs_g !== undefined && { totalCarbohydrate: { grams: a.carbs_g } }),
          ...(a.fat_g !== undefined && { totalFat: { grams: a.fat_g } }),
          ...(nutrients.length && { nutrients }),
          serving: { amount: a.amount, foodMeasurementUnit: unitName(unit) },
        },
      };
      const res = await healthFetch(env, p, "/dataTypes/nutrition-log/dataPoints", { method: "POST", body: JSON.stringify(body) });
      return json({ logged: res.response?.name ?? res.name ?? res });
    },
  );

  server.registerTool(
    "list_food_units",
    {
      description: "List the measurement units Google Health accepts for food logs (serving, gram, cup, ...). Optionally filter by a word.",
      inputSchema: { contains: z.string().optional() },
    },
    async ({ contains }) => {
      const units = await foodUnits(env, props());
      const hits = contains ? units.filter((u) => JSON.stringify(u).toLowerCase().includes(contains.toLowerCase())) : units;
      return json({ count: hits.length, units: hits.slice(0, 100) });
    },
  );

  server.registerTool(
    "delete_food_logs",
    {
      description: "Delete food log entries by their name (the 'name' field from get_health_data with data_type nutrition-log, or from log_food).",
      inputSchema: { names: z.array(z.string().startsWith("users/")).min(1).max(50) },
      annotations: { destructiveHint: true },
    },
    async ({ names }) => {
      if (!names.every((n) => n.includes("/dataTypes/nutrition-log/"))) throw new Error("Only nutrition-log entries can be deleted here.");
      await healthFetch(env, props(), "/dataTypes/nutrition-log/dataPoints:batchDelete", { method: "POST", body: JSON.stringify({ names }) });
      return json({ deleted: names.length });
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
