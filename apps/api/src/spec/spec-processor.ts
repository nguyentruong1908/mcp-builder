import SwaggerParser from '@apidevtools/swagger-parser';
import YAML from 'yaml';
import type { Impact, OpRef, SpecDiff, SpecIssue, ToolParam } from '@mcp-builder/shared';
import { sha256 } from '../core/util.js';

type Obj = Record<string, any>;

export interface NormalizedOperation {
  method: string;
  path: string;
  operationId: string | null;
  tag: string;
  toolName: string;
  description: string;
  params: ToolParam[];
  inputSchema: Obj;
  bodyWhole: boolean;
  responseSchema: unknown | null;
  successStatus: string | null;
  unsupportedReason: string | null;
  defaultImpact: Impact;
  signature: string;
}

export interface ProcessedSpec {
  oasVersion: string;
  apiVersion: string;
  title: string;
  operations: NormalizedOperation[];
  issues: SpecIssue[];
  securitySchemes: string[];
  servers: string[];
}

export class SpecError extends Error {}

const METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options'] as const;

function findExternalRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => findExternalRefs(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string' && !v.startsWith('#')) out.push(v);
      else findExternalRefs(v, out);
    }
  }
  return out;
}

export function toToolName(operationId: string | undefined, method: string, path: string): string {
  const base = operationId
    ? operationId.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    : `${method}_${path.replace(/[{}]/g, '').replace(/\//g, '_')}`;
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || `${method}_root`;
}

function typeOf(schema: Obj | undefined): string {
  if (!schema) return 'string';
  if (typeof schema.type === 'string') return schema.type;
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return 'string';
}

function propSchema(schema: Obj | undefined, description: string | undefined, example: unknown): Obj {
  const s: Obj = { ...(schema ?? { type: 'string' }) };
  delete s.nullable;
  delete s.xml;
  if (description && !s.description) s.description = description;
  if (example !== undefined) s.examples = [example];
  return s;
}

function securityReason(op: Obj, doc: Obj): string | null {
  const reqs: Obj[] = op.security ?? doc.security ?? [];
  if (!reqs.length) return null;
  const schemes: Obj = doc.components?.securitySchemes ?? {};
  const supported = (name: string) => {
    const s = schemes[name];
    if (!s) return false;
    if (s.type === 'http') return String(s.scheme).toLowerCase() === 'bearer';
    if (s.type === 'apiKey') return s.in === 'header';
    return false;
  };
  if (reqs.some((alt) => Object.keys(alt).length === 0 || Object.keys(alt).every(supported))) return null;
  const names = [...new Set(reqs.flatMap((alt) => Object.keys(alt)))];
  const kinds = names.map((n) => (schemes[n]?.type === 'apiKey' ? `apiKey in ${schemes[n].in}` : schemes[n]?.type === 'http' ? `http ${schemes[n].scheme}` : schemes[n]?.type ?? n));
  return `Unsupported authentication: ${kinds.join(', ')} (the MVP supports header API keys and bearer tokens)`;
}

function normalizeOperation(doc: Obj, path: string, method: string, item: Obj, op: Obj, issues: SpecIssue[]): Omit<NormalizedOperation, 'toolName'> {
  const opLabel = `${method.toUpperCase()} ${path}`;
  const reasons: string[] = [];
  const params: ToolParam[] = [];
  const properties: Obj = {};
  const required: string[] = [];
  let bodyWhole = false;

  const merged = new Map<string, Obj>();
  for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) merged.set(`${p.in}:${p.name}`, p);
  for (const p of merged.values()) {
    if (p.in === 'cookie') {
      if (p.required) reasons.push(`Required cookie parameter "${p.name}"`);
      else issues.push({ level: 'warning', operation: opLabel, message: `Ignored cookie parameter "${p.name}"` });
      continue;
    }
    const schema = p.schema ?? (p.content ? (Object.values(p.content)[0] as Obj)?.schema : undefined);
    params.push({ name: p.name, in: p.in, type: typeOf(schema), required: !!p.required || p.in === 'path', description: p.description ?? '' });
    properties[p.name] = propSchema(schema, p.description, p.example ?? schema?.example);
    if (p.required || p.in === 'path') required.push(p.name);
  }

  const rb: Obj | undefined = op.requestBody;
  if (rb) {
    const types = Object.keys(rb.content ?? {});
    const jsonKey = types.find((t) => /json/i.test(t));
    if (!jsonKey) {
      if (types.some((t) => t.startsWith('multipart/'))) reasons.push('multipart/form-data (file upload)');
      else if (types.some((t) => t.includes('octet-stream'))) reasons.push('Binary request body (application/octet-stream)');
      else reasons.push(`Unsupported Content-Type: ${types.join(', ') || '(empty)'}`);
    } else {
      const schema: Obj = rb.content[jsonKey].schema ?? {};
      const props: Obj | undefined = schema.properties;
      const clash = props && Object.keys(props).some((k) => properties[k]);
      if (props && !clash) {
        const req = new Set<string>(schema.required ?? []);
        for (const [name, s] of Object.entries(props)) {
          params.push({ name, in: 'body', type: typeOf(s as Obj), required: req.has(name), description: (s as Obj).description ?? '' });
          properties[name] = propSchema(s as Obj, undefined, (s as Obj).example);
          if (req.has(name)) required.push(name);
        }
      } else {
        bodyWhole = true;
        params.push({ name: 'body', in: 'body', type: typeOf(schema), required: !!rb.required, description: 'Request body' });
        properties.body = propSchema(schema, 'Request body', schema.example);
        if (rb.required) required.push('body');
      }
    }
  }

  const codes = Object.keys(op.responses ?? {});
  const successStatus = codes.find((c) => /^2/.test(c)) ?? (codes.includes('default') ? 'default' : null);
  let responseSchema: unknown = null;
  if (!successStatus) issues.push({ level: 'warning', operation: opLabel, message: 'No 2xx response declared' });
  else {
    const content: Obj | undefined = op.responses[successStatus]?.content;
    const types = Object.keys(content ?? {});
    const jsonKey = types.find((t) => /json/i.test(t));
    if (types.length && !jsonKey) reasons.push(`File streaming / binary response (${types.join(', ')})`);
    else if (jsonKey) {
      responseSchema = content![jsonKey].schema ?? null;
      if (!responseSchema) issues.push({ level: 'warning', operation: opLabel, message: `Response ${successStatus} has no schema; the tool output will be undescribed` });
    }
  }

  const sec = securityReason(op, doc);
  if (sec) reasons.push(sec);
  const unsupportedReason = reasons.length ? reasons.join('; ') : null;
  if (unsupportedReason) issues.push({ level: 'unsupported', operation: opLabel, message: unsupportedReason });

  const description = [op.summary, op.description].filter(Boolean).join('\n\n') || opLabel;
  const m = method.toUpperCase();
  const inputSchema = { type: 'object', properties, required: [...new Set(required)], additionalProperties: false };
  return {
    method: m,
    path,
    operationId: op.operationId ?? null,
    tag: op.tags?.[0] ?? 'default',
    description,
    params,
    inputSchema,
    bodyWhole,
    responseSchema,
    successStatus,
    unsupportedReason,
    // Only a suggestion shown to the user, who must confirm the impact in the tool designer.
    defaultImpact: m === 'GET' || m === 'HEAD' ? 'read' : m === 'DELETE' ? 'destructive' : 'write',
    signature: sha256(JSON.stringify({ params, bodyWhole, responseSchema })),
  };
}

export async function processSpec(raw: string): Promise<ProcessedSpec> {
  let doc: Obj;
  try {
    doc = YAML.parse(raw, { maxAliasCount: 100 });
  } catch (err) {
    throw new SpecError(`Cannot parse JSON/YAML: ${(err as Error).message}`);
  }
  if (!doc || typeof doc !== 'object') throw new SpecError('Content is not an OpenAPI document');
  if (doc.swagger) throw new SpecError('Swagger 2.0 is not supported. Convert it to OpenAPI 3.0.x');
  const oasVersion = String(doc.openapi ?? '');
  if (!oasVersion) throw new SpecError('Missing "openapi" field');
  const issues: SpecIssue[] = [];
  if (oasVersion.startsWith('3.1.')) issues.push({ level: 'warning', message: 'OpenAPI 3.1 is outside the support matrix (the MVP targets 3.0.x); results may be inaccurate' });
  else if (!oasVersion.startsWith('3.0.')) throw new SpecError(`OpenAPI version ${oasVersion} is not supported`);

  const external = findExternalRefs(doc);
  if (external.length) throw new SpecError(`External $ref blocked for security reasons: ${[...new Set(external)].slice(0, 5).join(', ')}`);

  const opts = { resolve: { external: false }, dereference: { circular: 'ignore' as const } };
  try {
    await SwaggerParser.validate(structuredClone(doc) as any, opts as any);
  } catch (err) {
    issues.push({ level: 'error', message: `Invalid spec: ${(err as Error).message.split('\n')[0]}` });
  }
  let deref: Obj;
  try {
    deref = (await SwaggerParser.dereference(structuredClone(doc) as any, opts as any)) as unknown as Obj;
  } catch (err) {
    throw new SpecError(`Cannot resolve $ref: ${(err as Error).message}`);
  }

  const operations: NormalizedOperation[] = [];
  const used = new Set<string>();
  for (const [path, item] of Object.entries<Obj>(deref.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op) continue;
      const n = normalizeOperation(deref, path, method, item, op, issues);
      let name = toToolName(op.operationId, method, path);
      for (let i = 2; used.has(name); i++) name = `${toToolName(op.operationId, method, path).slice(0, 60)}_${i}`;
      used.add(name);
      operations.push({ ...n, toolName: name });
    }
  }
  if (!operations.length) issues.push({ level: 'error', message: 'The spec has no operations' });

  return {
    oasVersion,
    apiVersion: String(doc.info?.version ?? ''),
    title: String(doc.info?.title ?? 'Untitled API'),
    operations,
    issues,
    securitySchemes: Object.keys(doc.components?.securitySchemes ?? {}),
    servers: (doc.servers ?? []).map((s: Obj) => String(s.url)),
  };
}

const key = (o: OpRef) => `${o.method} ${o.path}`;

export function diffOperations(from: NormalizedOperation[], to: NormalizedOperation[], fromId: string, toId: string, toolNames: Map<string, string>): SpecDiff {
  const a = new Map(from.map((o) => [key(o), o]));
  const b = new Map(to.map((o) => [key(o), o]));
  const added = to.filter((o) => !a.has(key(o))).map(({ method, path }) => ({ method, path }));
  const removed = from.filter((o) => !b.has(key(o))).map(({ method, path }) => ({ method, path }));
  const changed: SpecDiff['changed'] = [];
  let breaking = removed.length > 0;

  for (const [k, next] of b) {
    const prev = a.get(k);
    if (!prev || prev.signature === next.signature) continue;
    const changes: string[] = [];
    const pm = new Map(prev.params.map((p) => [`${p.in}:${p.name}`, p]));
    const nm = new Map(next.params.map((p) => [`${p.in}:${p.name}`, p]));
    for (const [pk, p] of nm) {
      const old = pm.get(pk);
      if (!old) { changes.push(`Added ${p.in} parameter "${p.name}"${p.required ? ' (required)' : ''}`); if (p.required) breaking = true; }
      else {
        if (old.type !== p.type) { changes.push(`"${p.name}": ${old.type} → ${p.type}`); breaking = true; }
        if (!old.required && p.required) { changes.push(`"${p.name}" became required`); breaking = true; }
      }
    }
    for (const [pk, p] of pm) if (!nm.has(pk)) { changes.push(`Removed ${p.in} parameter "${p.name}"`); breaking = true; }
    if (JSON.stringify(prev.responseSchema) !== JSON.stringify(next.responseSchema)) changes.push('Response schema changed');
    changed.push({ method: next.method, path: next.path, changes: changes.length ? changes : ['Definition changed'] });
  }

  const affectedTools = [
    ...removed.map((o) => ({ op: o, reason: 'Endpoint removed' })),
    ...changed.map((c) => ({ op: c, reason: c.changes.join('; ') })),
  ].flatMap(({ op, reason }) => {
    const name = toolNames.get(key(op));
    return name ? [{ name, reason }] : [];
  });

  return { from: fromId, to: toId, added, removed, changed, affectedTools, breaking, suggestedBump: breaking ? 'major' : added.length ? 'minor' : 'patch' };
}
