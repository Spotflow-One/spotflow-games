/**
 * JSON with Maps, Sets and Dates, so session and game state can be stored and moved between
 * server instances without each engine writing its own serializer.
 */
const TAG = "__sg";

type Tagged = { [TAG]: "map"; v: [unknown, unknown][] } | { [TAG]: "set"; v: unknown[] } | { [TAG]: "date"; v: string };

export function encode(value: unknown): string {
  return JSON.stringify(value, function (key, v: unknown) {
    // `this[key]` is the raw value: Dates have already been turned into strings by toJSON.
    const raw = (this as Record<string, unknown>)[key];
    if (raw instanceof Map) return { [TAG]: "map", v: [...raw.entries()] };
    if (raw instanceof Set) return { [TAG]: "set", v: [...raw.values()] };
    if (raw instanceof Date) return { [TAG]: "date", v: raw.toISOString() };
    return v;
  });
}

export function decode<T = unknown>(text: string): T {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v && typeof v === "object" && TAG in v) {
      const t = v as Tagged;
      if (t[TAG] === "map") return new Map(t.v);
      if (t[TAG] === "set") return new Set(t.v);
      if (t[TAG] === "date") return new Date(t.v);
    }
    return v;
  }) as T;
}
