import { Decoder, Profile, Stream } from "@garmin/fitsdk";

/**
 * Garmin's download endpoint returns the original activity as a ZIP holding one .fit file.
 * Workers have no unzip library built in, so we read the ZIP's central directory ourselves
 * and inflate the entry with the built-in DecompressionStream.
 */
export async function extractFit(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return bytes; // not a ZIP: assume a bare .fit
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Garmin download: ZIP end record not found");
  let p = view.getUint32(eocd + 16, true); // central directory offset
  const entries = view.getUint16(eocd + 10, true);
  for (let n = 0; n < entries; n++) {
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.toLowerCase().endsWith(".fit")) continue;
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const data = bytes.subarray(start, start + compSize);
    if (method === 0) return data;
    if (method !== 8) throw new Error(`Garmin download: unsupported ZIP compression ${method}`);
    const out = new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")));
    return new Uint8Array(await out.arrayBuffer());
  }
  throw new Error("Garmin download: no .fit file in the ZIP");
}

const types = Profile.types as Record<string, Record<number, string>>;

/** Turns FIT "set" messages into readable lifts. Rest sets are dropped. */
export function strengthSets(fit: Uint8Array) {
  const decoder = new Decoder(Stream.fromByteArray(Array.from(fit)));
  const { messages, errors } = decoder.read();
  if (errors.length) throw new Error(`FIT decode: ${errors[0]}`);
  const sets = ((messages.setMesgs ?? []) as any[]).filter((s) => s.setType !== "rest");
  return sets.map((s, i) => {
    const category: string | undefined = Array.isArray(s.category) ? s.category[0] : s.category;
    const subtype: number | undefined = Array.isArray(s.categorySubtype) ? s.categorySubtype[0] : s.categorySubtype;
    const exercise = category && subtype != null ? types[`${category}ExerciseName`]?.[subtype] : undefined;
    return {
      set: i + 1,
      exercise: exercise ?? category ?? "unknown",
      category,
      reps: s.repetitions ?? null,
      weight_kg: typeof s.weight === "number" ? Math.round(s.weight * 10) / 10 : null, // SDK already applies the 1/16 kg scale
      duration_s: typeof s.duration === "number" ? Math.round(s.duration) : null,
      start: s.startTime,
    };
  });
}
