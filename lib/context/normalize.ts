export function normalizeNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => normalizeNulls(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === null) continue;
      out[key] = normalizeNulls(item);
    }
    return out as T;
  }
  return value;
}
