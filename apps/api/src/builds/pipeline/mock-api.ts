import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sampleFor } from './samples.js';
import type { ToolSnapshot } from './types.js';

export interface RecordedRequest { method: string; path: string; query: Record<string, string | string[]>; headers: Record<string, string | string[] | undefined>; body: unknown }
export interface MockResponse { status: number; body?: unknown; raw?: string; delayMs?: number; headers?: Record<string, string> }

/** Factory-owned stand-in for the upstream API, derived from the tool definitions (not from Codex output). */
export class MockApi {
  readonly requests: RecordedRequest[] = [];
  private queue: MockResponse[] = [];
  private server!: Server;
  url = '';

  constructor(private readonly tools: ToolSnapshot[]) {}

  /** Responses served (in order) for the next requests; afterwards the default sample response is used. */
  next(...responses: MockResponse[]) { this.queue = responses; this.requests.length = 0; }

  private defaultFor(method: string, path: string): MockResponse {
    const tool = this.tools.find((t) => t.method === method && new RegExp(`^${t.path.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path));
    return { status: 200, body: tool?.responseSchema ? sampleFor(tool.responseSchema as Record<string, unknown>) : {} };
  }

  start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://mock');
      let raw = '';
      for await (const c of req) raw += c;
      let body: unknown = raw;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { /* keep raw text */ }
      const query: Record<string, string | string[]> = {};
      for (const k of new Set(url.searchParams.keys())) {
        const all = url.searchParams.getAll(k);
        query[k] = all.length > 1 ? all : all[0];
      }
      this.requests.push({ method: req.method ?? 'GET', path: url.pathname, query, headers: req.headers, body });
      const r = this.queue.shift() ?? this.defaultFor(req.method ?? 'GET', url.pathname);
      if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
      if (res.destroyed) return;
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
      res.end(r.raw ?? (r.body === undefined ? undefined : JSON.stringify(r.body)));
    });
    return new Promise((ok) => this.server.listen(0, '127.0.0.1', () => {
      this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
      ok();
    }));
  }

  close(): Promise<void> {
    return new Promise((ok) => { this.server.closeAllConnections?.(); this.server.close(() => ok()); });
  }
}
