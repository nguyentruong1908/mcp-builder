type Obj = Record<string, any>;

/** Deterministic sample value for a JSON schema: examples → default → enum → type-based. */
export function sampleFor(schema: Obj | undefined, depth = 0): unknown {
  if (!schema || depth > 5) return 'sample';
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const variants = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(variants) && variants.length) return sampleFor(variants[0], depth + 1);
  if (Array.isArray(schema.allOf)) return Object.assign({}, ...schema.allOf.map((s: Obj) => sampleFor(s, depth + 1)));
  const type = schema.type ?? (schema.properties ? 'object' : schema.items ? 'array' : 'string');
  switch (type) {
    case 'integer': return Math.max(1, Math.ceil(schema.minimum ?? 1));
    case 'number': return schema.minimum ?? 1;
    case 'boolean': return true;
    case 'array': return [sampleFor(schema.items, depth + 1)];
    case 'object': {
      const out: Obj = {};
      for (const [k, v] of Object.entries<Obj>(schema.properties ?? {})) out[k] = sampleFor(v, depth + 1);
      return out;
    }
    default:
      if (schema.format === 'date-time') return '2026-01-01T00:00:00Z';
      if (schema.format === 'date') return '2026-01-01';
      if (schema.format === 'email') return 'qa@example.com';
      if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
      return 'sample';
  }
}

/** Sample arguments for a tool: all required params plus optional ones that have an example. */
export function sampleArgs(inputSchema: Obj): Record<string, unknown> {
  const req = new Set<string>(inputSchema.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries<Obj>(inputSchema.properties ?? {})) {
    if (req.has(k) || v.examples || v.example !== undefined) out[k] = sampleFor(v);
  }
  return out;
}
