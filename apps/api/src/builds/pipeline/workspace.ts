import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { config } from '../../config.js';
import type { BuildCtx } from './types.js';

const SKIP = new Set(['node_modules', 'dist', '.git']);

export async function walk(root: string, dir = root, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(root, p, out);
    else if (e.isFile()) out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

/** Codex may only write here; everything else is restored after the Codex stage. */
export const isCodexWritable = (rel: string) => rel.startsWith('src/adapters/') || rel === 'README.md' || rel === 'package-lock.json';

export async function prepareWorkspace(ctx: BuildCtx) {
  await rm(ctx.dir, { recursive: true, force: true });
  await mkdir(ctx.outDir, { recursive: true });
  await cp(config.templateDir, ctx.ws, { recursive: true, filter: (src) => !src.split(sep).some((p) => SKIP.has(p)) });

  const pkg = JSON.parse(await readFile(join(ctx.ws, 'package.json'), 'utf8'));
  pkg.name = ctx.packageName;
  pkg.version = ctx.version.number;
  pkg.description = ctx.project.description || `${ctx.project.name} tools for AI agents (MCP + CLI)`;
  pkg.bin = {
    ...(ctx.project.outputs.cli ? { [ctx.cliBin]: 'dist/cli.js' } : {}),
    ...(ctx.project.outputs.mcp ? { [ctx.mcpBin]: 'dist/mcp.js' } : {}),
  };
  await writeFile(join(ctx.ws, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  const toolsFile = {
    package: { name: ctx.packageName, version: ctx.version.number, description: pkg.description, cliName: ctx.cliBin },
    tools: ctx.tools.map(({ name, description, method, path, impact, requireConfirm, params, inputSchema, bodyWhole }) => ({ name, description, method, path, impact, requireConfirm, params, inputSchema, bodyWhole })),
  };
  await writeFile(join(ctx.ws, 'factory/tools.json'), JSON.stringify(toolsFile, null, 2) + '\n');
  await writeFile(join(ctx.ws, 'factory/context.md'), ctx.contextMd);
  await writeFile(join(ctx.ws, ctx.specRaw.trimStart().startsWith('{') ? 'factory/openapi.json' : 'factory/openapi.yaml'), ctx.specRaw);
  await writeFile(join(ctx.ws, 'README.md'), `# ${ctx.packageName}\n\n(README is generated during the build.)\n`);
  // Team/project conventions for Codex (read automatically from the working directory). Protected: Codex cannot edit it.
  if (ctx.generation?.rules) await writeFile(join(ctx.ws, 'AGENTS.md'), ctx.generation.rules);
}

/** Snapshot of files Codex must not change. */
export async function snapshotProtected(ws: string): Promise<Map<string, Buffer>> {
  const snap = new Map<string, Buffer>();
  for (const rel of await walk(ws)) if (!isCodexWritable(rel)) snap.set(rel, await readFile(join(ws, rel)));
  return snap;
}

/** Restores protected files and removes files Codex created outside its allowed area. Returns what was reverted. */
export async function enforceProtected(ws: string, snap: Map<string, Buffer>): Promise<string[]> {
  const reverted: string[] = [];
  const now = await walk(ws);
  for (const rel of now) {
    if (isCodexWritable(rel)) continue;
    const orig = snap.get(rel);
    if (!orig) { await rm(join(ws, rel)); reverted.push(`${rel} (removed)`); continue; }
    if (!orig.equals(await readFile(join(ws, rel)))) { await writeFile(join(ws, rel), orig); reverted.push(`${rel} (restored)`); }
  }
  for (const [rel, buf] of snap) {
    if (!now.includes(rel)) {
      await mkdir(join(ws, rel, '..'), { recursive: true });
      await writeFile(join(ws, rel), buf);
      reverted.push(`${rel} (recreated)`);
    }
  }
  return reverted;
}

export function renderContextMd(project: { name: string; description: string }, c: Record<string, any> | null): string {
  if (!c) return `# ${project.name}\n\n${project.description}\n\n(No business context provided.)\n`;
  const section = (title: string, body: string) => (body?.trim() ? `## ${title}\n\n${body.trim()}\n\n` : '');
  const glossary = (c.glossary ?? []) as { term: string; meaning: string; mapping: string }[];
  return [
    `# ${project.name}\n\n${project.description}\n\n`,
    section('Purpose', c.purpose),
    section('Sample tasks', c.sampleTasks),
    section('Business rules', c.businessRules),
    section('Data formats', c.dataFormats),
    section('Access scope', c.accessScope),
    section('Impacts', (c.impacts ?? []).join(', ')),
    section('Expected results', c.expectedResults),
    section('Notes', c.freeform),
    glossary.length ? `## Glossary\n\n| Term | Meaning | Spec mapping |\n|---|---|---|\n${glossary.map((g) => `| ${g.term} | ${g.meaning} | ${g.mapping} |`).join('\n')}\n` : '',
  ].join('');
}
