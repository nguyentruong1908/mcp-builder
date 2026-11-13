/** Placeholder resolution for multi-step test cases: "{{step1.id}}", "{{step2.items.0.code}}". */

const WHOLE = /^\{\{\s*step(\d+)((?:\.[A-Za-z0-9_-]+)*)\s*\}\}$/;
const ANY = /\{\{\s*step(\d+)((?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;

export class PlaceholderError extends Error {}

function lookup(results: unknown[], stepNo: string, path: string): unknown {
  const i = Number(stepNo) - 1;
  // Cleanup steps run last, so they may reference any step that has already produced a result.
  if (i < 0 || i >= results.length || results[i] === undefined) throw new PlaceholderError(`{{step${stepNo}${path}}}: step ${stepNo} has not run or has no result`);
  let v: unknown = results[i];
  for (const key of path.split('.').filter(Boolean)) {
    if (v === null || typeof v !== 'object' || !(key in (v as object))) throw new PlaceholderError(`{{step${stepNo}${path}}}: no "${key}" in the result of step ${stepNo}`);
    v = (v as Record<string, unknown>)[key];
  }
  if (v === undefined) throw new PlaceholderError(`{{step${stepNo}${path}}}: no value`);
  return v;
}

/** Deep-resolves placeholders in args. `results[i]` is the parsed result of step i+1 (undefined = not run). */
export function resolveArgs(value: unknown, results: unknown[]): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) return lookup(results, whole[1], whole[2]); // keeps the original type (number, object…)
    return value.replace(ANY, (_m, n: string, p: string) => {
      const v = lookup(results, n, p);
      return typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveArgs(v, results));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveArgs(v, results)]));
  return value;
}

/** Tool results are JSON text when successful; keep raw text otherwise. */
export function parseResult(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}
