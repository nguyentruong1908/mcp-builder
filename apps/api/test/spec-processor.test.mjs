// Runs against the compiled output: pnpm build && pnpm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { diffOperations, processSpec, SpecError, toToolName } from '../dist/spec/spec-processor.js';
import { sampleArgs } from '../dist/builds/pipeline/samples.js';
import { redact } from '../dist/core/util.js';

const raw = readFileSync(new URL('./fixtures/erp.openapi.yaml', import.meta.url), 'utf8');

test('normalizes the sample ERP spec', async () => {
  const s = await processSpec(raw);
  assert.equal(s.oasVersion, '3.0.3');
  assert.equal(s.operations.length, 12);
  const byKey = Object.fromEntries(s.operations.map((o) => [`${o.method} ${o.path}`, o]));
  assert.match(byKey['POST /invoices/{id}/attachments'].unsupportedReason, /multipart/);
  assert.match(byKey['GET /reports/export'].unsupportedReason, /binary|streaming/i);
  const create = byKey['POST /sales-orders'];
  assert.equal(create.toolName, 'create_sales_order');
  assert.deepEqual(create.params.map((p) => `${p.in}:${p.name}:${p.required}`), ['body:customerCode:true', 'body:lines:true']);
  assert.equal(create.defaultImpact, 'write');
  assert.equal(byKey['DELETE /sales-orders/{id}'].defaultImpact, 'destructive');
  assert.deepEqual(byKey['GET /products/{sku}/stock'].inputSchema.required, ['sku']);
  assert.equal(s.issues.filter((i) => i.level === 'error').length, 0);
});

test('rejects Swagger 2.0 and external refs', async () => {
  await assert.rejects(processSpec('swagger: "2.0"\ninfo: {title: x, version: "1"}\npaths: {}'), SpecError);
  await assert.rejects(processSpec(JSON.stringify({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: { '/a': { get: { responses: { 200: { $ref: 'http://evil/x.yaml' } } } } } })), /blocked/);
});

test('flags unsupported auth (oauth2)', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'x', version: '1' }, components: { securitySchemes: { o: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://x/t', scopes: {} } } } } }, security: [{ o: [] }], paths: { '/a': { get: { responses: { 200: { description: 'ok' } } } } } };
  const s = await processSpec(JSON.stringify(doc));
  assert.match(s.operations[0].unsupportedReason, /oauth2/);
});

test('diff detects removed endpoints and new required params as breaking', async () => {
  const a = await processSpec(raw);
  const b = await processSpec(raw.replace(/  \/products:\n[\s\S]*?(?=  \/products\/\{sku\}\/stock:)/, '').replace('- { name: warehouse, in: query, schema: { type: string }, description: warehouseCode e.g. HN01 }', '- { name: warehouse, in: query, required: true, schema: { type: string } }'));
  const d = diffOperations(a.operations, b.operations, 'a', 'b', new Map([['GET /products', 'search_products']]));
  assert.deepEqual(d.removed, [{ method: 'GET', path: '/products' }]);
  assert.ok(d.changed.some((c) => c.path === '/products/{sku}/stock' && c.changes.some((x) => x.includes('required'))));
  assert.equal(d.breaking, true);
  assert.equal(d.suggestedBump, 'major');
  assert.deepEqual(d.affectedTools.map((t) => t.name), ['search_products']);
});

test('helpers', () => {
  assert.equal(toToolName('getProductStock', 'get', '/x'), 'get_product_stock');
  assert.equal(toToolName(undefined, 'get', '/products/{sku}/stock'), 'get_products_sku_stock');
  assert.deepEqual(sampleArgs({ type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer', examples: [5] }, opt: { type: 'string' } }, required: ['id'] }), { id: 'sample', n: 5 });
  assert.equal(redact('Authorization: Bearer abc.def.ghi123456 and s3cretvalue', ['s3cretvalue']), 'Authorization: Bearer ****** and ******');
});

test('parses sample tasks with optional expected tools', async () => {
  const { parseSampleTasks } = await import('../dist/builds/pipeline/agent-eval.js');
  assert.deepEqual(parseSampleTasks('- List Draft orders of customer C0042 => search_sales_orders\n\n2. Stock of SKU-1002 → get_product_stock, search_products\n* Say hello'), [
    { text: 'List Draft orders of customer C0042', expected: ['search_sales_orders'] },
    { text: 'Stock of SKU-1002', expected: ['get_product_stock', 'search_products'] },
    { text: 'Say hello', expected: [] },
  ]);
});

test('generation profile: project overrides model/reasoning, rules are additive', async () => {
  const { effectiveOf } = await import('../dist/generation/generation.module.js');
  const ws = { model: 'gpt-6-sol', reasoningEffort: 'medium', rules: 'Write error messages in plain English.', version: 3, updatedAt: null };
  const pj = { model: null, reasoningEffort: 'high', rules: 'Keep nextCursor.', version: 1, updatedAt: null };
  const e = effectiveOf(ws, pj);
  assert.equal(e.model, 'gpt-6-sol');
  assert.equal(e.reasoningEffort, 'high');
  assert.deepEqual(e.source, { model: 'workspace', reasoningEffort: 'project' });
  assert.ok(e.rules.indexOf('Workspace conventions (v3)') < e.rules.indexOf('Project conventions (v1)'));
  assert.match(e.rules, /never override the task rules/);
  assert.equal(effectiveOf({ ...ws, rules: '' }, null).rules, '');
  assert.equal(effectiveOf({ model: null, reasoningEffort: null, rules: '', version: 0, updatedAt: null }, null).source.model, 'env');
});

test('QA repair prompt lists failures and forbids gaming the tests', async () => {
  const { qaRepairPrompt } = await import('../dist/builds/pipeline/codex.js');
  const p = qaRepairPrompt([{ layer: 'custom', tool: 'get_customer', name: 'C9999 → not_found', detail: 'Error category [server] ≠ [not_found]', evidence: { args: { code: 'C9999' } } }]);
  assert.match(p, /\[custom\] get_customer · C9999 → not_found/);
  assert.match(p, /Do not special-case test inputs/);
  assert.match(p, /only edit src\/adapters\//);
});

test('QA repair only targets adapter-fixable failures', async () => {
  const { isQaFixable } = await import('../dist/builds/pipeline/codex.js');
  const f = (layer, tool, detail, status = 'fail') => isQaFixable({ layer, tool, detail, status });
  assert.equal(f('custom', 'get_customer', 'Result does not contain "x"'), true);
  assert.equal(f('error', 'get_customer', 'Expected isError'), true);
  assert.equal(f('install', null, 'npm pack failed'), false);
  assert.equal(f('agent', null, 'Tool errors: approve_sales_order [mcp]'), false);
  assert.equal(f('agent', 'approve_sales_order', 'Used by the agent'), false);
  assert.equal(f('agent', null, 'Expected tools not called: get_customer'), true);
  assert.equal(f('custom', 'x', 'y', 'blocked'), false);
});

test('step placeholders resolve from earlier results and keep types', async () => {
  const { resolveArgs, PlaceholderError } = await import('../dist/builds/pipeline/steps.js');
  const results = [{ id: 'SO-1003', total: 150000, items: [{ code: 'C1' }] }, undefined];
  assert.deepEqual(resolveArgs({ id: '{{step1.id}}', n: '{{step1.total}}', note: 'Order {{ step1.id }} / {{step1.items.0.code}}', list: ['{{step1.id}}'] }, results),
    { id: 'SO-1003', n: 150000, note: 'Order SO-1003 / C1', list: ['SO-1003'] });
  assert.throws(() => resolveArgs({ id: '{{step2.id}}' }, results), PlaceholderError);
  assert.throws(() => resolveArgs({ id: '{{step1.missing}}' }, results), /no "missing"/);
  assert.deepEqual(resolveArgs({ plain: 'no placeholders', x: 1 }, results), { plain: 'no placeholders', x: 1 });
});


test('deployment instructions and token check', async () => {
  const { buildInstructions } = await import('../dist/deployments/instructions.js');
  const { tokenMatches } = await import('../dist/deployments/deployments.module.js');
  const { sha256 } = await import('../dist/core/util.js');
  const ins = buildInstructions({ url: 'https://f.example/mcp/erp-sales', slug: 'erp-sales', projectName: 'ERP', description: 'Sales tools.', tools: [{ name: 'approve_order', description: 'Approve\nmore', impact: 'side_effect', requireConfirm: true }] });
  assert.deepEqual(ins.map((i) => i.id), ['claude-code', 'codex', 'json', 'curl', 'agent-prompt']);
  assert.ok(ins.every((i) => i.id === 'agent-prompt' || i.content.includes('{{TOKEN}}')));
  assert.match(ins.find((i) => i.id === 'codex').content, /\[mcp_servers\.erp_sales\][\s\S]*bearer_token_env_var = "ERP_SALES_TOKEN"/);
  assert.equal(JSON.parse(ins.find((i) => i.id === 'json').content).mcpServers['erp-sales'].url, 'https://f.example/mcp/erp-sales');
  assert.match(ins.find((i) => i.id === 'agent-prompt').content, /`approve_order` \(side_effect, ask the user first\): Approve$/m);
  assert.equal(tokenMatches('mcpf_abc', sha256('mcpf_abc')), true);
  assert.equal(tokenMatches('mcpf_abd', sha256('mcpf_abc')), false);
  assert.equal(tokenMatches('', sha256('mcpf_abc')), false);
});
