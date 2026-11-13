// Tiny in-memory implementation of openapi.yaml, used as a real target for integration QA and demos.
// Run: node examples/sample-erp/server.mjs   (PORT=4010, SAMPLE_ERP_TOKEN=dev-token)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 4010);
const TOKEN = process.env.SAMPLE_ERP_TOKEN ?? 'dev-token';

const customers = [
  { code: 'C0042', name: 'Công ty An Phát', phone: '0901000042' },
  { code: 'C0043', name: 'Siêu thị Bình Minh', phone: '0901000043' },
  { code: 'C0050', name: 'Nhà hàng Cửu Long', phone: '0901000050' },
];
const products = [
  { sku: 'SKU-1001', name: 'Nước suối 500ml (thùng 24)', unit: 'thùng' },
  { sku: 'SKU-1002', name: 'Trà xanh 350ml (thùng 24)', unit: 'thùng' },
];
const stock = { 'SKU-1001': [{ warehouse: 'HN01', qty: 120 }, { warehouse: 'HCM02', qty: 80 }], 'SKU-1002': [{ warehouse: 'HN01', qty: 35 }, { warehouse: 'HCM02', qty: 0 }] };
const orders = new Map([
  ['SO-1001', { id: 'SO-1001', customerCode: 'C0042', status: 'Draft', lines: [{ sku: 'SKU-1002', qty: 10, price: 150000 }], total: 1500000 }],
  ['SO-1002', { id: 'SO-1002', customerCode: 'C0042', status: 'Confirmed', lines: [{ sku: 'SKU-1001', qty: 5, price: 90000 }], total: 450000 }],
]);
let nextId = 1003;

const send = (res, status, body) => {
  res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};
const total = (lines) => lines.reduce((s, l) => s + (l.price ?? 0) * l.qty, 0);
const validLines = (lines) => Array.isArray(lines) && lines.length > 0 && lines.every((l) => typeof l.sku === 'string' && Number.isInteger(l.qty) && l.qty > 0);

async function readJson(req) {
  let raw = '';
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const q = url.searchParams;
  if (p === '/' ) return send(res, 200, { name: 'sample-erp', ok: true });
  if (p === '/openapi.yaml') { res.writeHead(200, { 'content-type': 'application/yaml' }); return res.end(readFileSync(new URL('./openapi.yaml', import.meta.url))); }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { message: 'Missing or invalid token' });

  try {
    let m;
    if (req.method === 'GET' && p === '/customers') {
      const s = (q.get('q') ?? '').toLowerCase();
      return send(res, 200, { items: customers.filter((c) => !s || c.name.toLowerCase().includes(s) || c.code.toLowerCase().includes(s)).slice(0, Number(q.get('limit') ?? 20)) });
    }
    if (req.method === 'GET' && (m = p.match(/^\/customers\/([^/]+)$/))) {
      const c = customers.find((x) => x.code === decodeURIComponent(m[1]));
      return c ? send(res, 200, c) : send(res, 404, { message: 'Customer not found' });
    }
    if (req.method === 'GET' && p === '/sales-orders') {
      let items = [...orders.values()];
      if (q.get('customer')) items = items.filter((o) => o.customerCode === q.get('customer'));
      if (q.get('status')) items = items.filter((o) => o.status === q.get('status'));
      const start = Number(q.get('cursor') ?? 0), limit = Number(q.get('limit') ?? 20);
      return send(res, 200, { items: items.slice(start, start + limit), nextCursor: start + limit < items.length ? String(start + limit) : null });
    }
    if (req.method === 'POST' && p === '/sales-orders') {
      const b = await readJson(req);
      if (typeof b.customerCode !== 'string' || !validLines(b.lines)) return send(res, 400, { message: 'customerCode and lines[] (sku, qty>0) are required' });
      if (!customers.some((c) => c.code === b.customerCode)) return send(res, 400, { message: `Unknown customer ${b.customerCode}` });
      const o = { id: `SO-${nextId++}`, customerCode: b.customerCode, status: 'Draft', lines: b.lines, total: total(b.lines) };
      orders.set(o.id, o);
      return send(res, 201, o);
    }
    if ((m = p.match(/^\/sales-orders\/([^/]+)$/))) {
      const o = orders.get(decodeURIComponent(m[1]));
      if (!o) return send(res, 404, { message: 'Order not found' });
      if (req.method === 'GET') return send(res, 200, o);
      if (req.method === 'PATCH') {
        if (o.status !== 'Draft') return send(res, 409, { code: 'ORDER_NOT_DRAFT', message: `Order ${o.id} is ${o.status}; only Draft orders can be edited` });
        const b = await readJson(req);
        if (b.lines !== undefined && !validLines(b.lines)) return send(res, 400, { message: 'Invalid lines' });
        if (b.lines) { o.lines = b.lines; o.total = total(b.lines); }
        return send(res, 200, o);
      }
      if (req.method === 'DELETE') { orders.delete(o.id); return send(res, 204); }
    }
    if (req.method === 'POST' && (m = p.match(/^\/sales-orders\/([^/]+)\/approve$/))) {
      const o = orders.get(decodeURIComponent(m[1]));
      if (!o) return send(res, 404, { message: 'Order not found' });
      if (o.status !== 'Draft') return send(res, 409, { code: 'ORDER_NOT_DRAFT', message: `Order ${o.id} is already ${o.status}` });
      o.status = 'Confirmed';
      return send(res, 200, o);
    }
    if (req.method === 'GET' && p === '/products') {
      const s = (q.get('q') ?? '').toLowerCase();
      return send(res, 200, { items: products.filter((x) => !s || x.name.toLowerCase().includes(s) || x.sku.toLowerCase().includes(s)) });
    }
    if (req.method === 'GET' && (m = p.match(/^\/products\/([^/]+)\/stock$/))) {
      const sku = decodeURIComponent(m[1]);
      if (!stock[sku]) return send(res, 404, { message: 'SKU not found' });
      const w = q.get('warehouse');
      return send(res, 200, { sku, levels: stock[sku].filter((l) => !w || l.warehouse === w) });
    }
    return send(res, 404, { message: 'Not found' });
  } catch (err) {
    return send(res, 400, { message: `Bad request: ${err.message}` });
  }
}).listen(PORT, () => console.log(`Sample ERP listening on http://localhost:${PORT} (token: ${TOKEN === 'dev-token' ? 'dev-token' : '***'})`));
