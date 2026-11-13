import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ToolAdapter, ToolDef, ToolsFile } from './types.js';

const toolsPath = fileURLToPath(new URL('../../factory/tools.json', import.meta.url));

export const toolsFile: ToolsFile = JSON.parse(readFileSync(toolsPath, 'utf8'));
export const tools: ToolDef[] = toolsFile.tools;

const adapters = new Map<string, ToolAdapter | null>();

/** Loads src/adapters/<name>.ts (compiled to dist/adapters/<name>.js) if Codex generated one. */
export async function adapterFor(name: string): Promise<ToolAdapter | undefined> {
  if (!adapters.has(name)) {
    try {
      const mod = await import(`../adapters/${name}.js`);
      adapters.set(name, (mod.default ?? mod.adapter ?? null) as ToolAdapter | null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw err;
      adapters.set(name, null);
    }
  }
  return adapters.get(name) ?? undefined;
}

export function findTool(name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}
