// Runs against the compiled output: pnpm build && pnpm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { diffOperations, processSpec, SpecError, toToolName } from '../dist/spec/spec-processor.js';
import { sampleArgs } from '../dist/builds/pipeline/samples.js';
import { redact } from '../dist/core/util.js';

const raw = readFileSync(new URL('../../../examples/sample-erp/openapi.yaml', import.meta.url), 'utf8');

test('normalizes the sample ERP spec', async () => {
  const s = await processSpec(raw);
  assert.equal(s.oasVersion, '3.0.3');
  assert.equal(s.operations.length, 12);
  const byKey = Object.fromEntries(s.operations.map((o) => [`${o.method} ${o.path}`, o]));
  assert.match(byKey['POST /invoices/{id}/attachments'].unsupportedReason, /multipart/);
  assert.match(byKey['GET /reports/export'].unsupportedReason, /nhị phân|streaming/i);
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
  await assert.rejects(processSpec(JSON.stringify({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: { '/a': { get: { responses: { 200: { $ref: 'http://evil/x.yaml' } } } } } })), /bị chặn/);
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
  assert.ok(d.changed.some((c) => c.path === '/products/{sku}/stock' && c.changes.some((x) => x.includes('bắt buộc'))));
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
  assert.deepEqual(parseSampleTasks('- Tra các đơn Draft của khách C0042 => search_sales_orders\n\n2. Tồn kho SKU-1002 → get_product_stock, search_products\n* Chào hỏi'), [
    { text: 'Tra các đơn Draft của khách C0042', expected: ['search_sales_orders'] },
    { text: 'Tồn kho SKU-1002', expected: ['get_product_stock', 'search_products'] },
    { text: 'Chào hỏi', expected: [] },
  ]);
});

test('generation profile: project overrides model/reasoning, rules are additive', async () => {
  const { effectiveOf } = await import('../dist/generation/generation.module.js');
  const ws = { model: 'gpt-6-sol', reasoningEffort: 'medium', rules: 'Thông báo lỗi bằng tiếng Việt.', version: 3, updatedAt: null };
  const pj = { model: null, reasoningEffort: 'high', rules: 'Giữ nguyên nextCursor.', version: 1, updatedAt: null };
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
  const p = qaRepairPrompt([{ layer: 'custom', tool: 'get_customer', name: 'C9999 → not_found', detail: 'Loại lỗi [server] ≠ [not_found]', evidence: { args: { code: 'C9999' } } }]);
  assert.match(p, /\[custom\] get_customer · C9999 → not_found/);
  assert.match(p, /Do not special-case test inputs/);
  assert.match(p, /only edit src\/adapters\//);
});

test('QA repair only targets adapter-fixable failures', async () => {
  const { isQaFixable } = await import('../dist/builds/pipeline/codex.js');
  const f = (layer, tool, detail, status = 'fail') => isQaFixable({ layer, tool, detail, status });
  assert.equal(f('custom', 'get_customer', 'Kết quả không chứa "x"'), true);
  assert.equal(f('error', 'get_customer', 'Kỳ vọng isError'), true);
  assert.equal(f('install', null, 'npm pack lỗi'), false);
  assert.equal(f('agent', null, 'Tool lỗi: approve_sales_order [mcp]'), false);
  assert.equal(f('agent', 'approve_sales_order', 'Được agent dùng'), false);
  assert.equal(f('agent', null, 'Không gọi tool mong đợi: get_customer'), true);
  assert.equal(f('custom', 'x', 'y', 'blocked'), false);
});
