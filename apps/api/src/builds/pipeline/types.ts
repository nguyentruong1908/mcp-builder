import type { EffectiveGeneration, Impact, QaLayer, QaStatus, StageName, StageState, ToolParam } from '@mcp-factory/shared';

/** Tool definition frozen into a Version at export time; also written to factory/tools.json. */
export interface ToolSnapshot {
  name: string;
  description: string;
  method: string;
  path: string;
  tag: string;
  impact: Impact;
  requireConfirm: boolean;
  params: ToolParam[];
  inputSchema: Record<string, unknown>;
  bodyWhole: boolean;
  responseSchema: unknown | null;
}

export interface QaRow { layer: QaLayer; tool: string | null; name: string; status: QaStatus; detail: string; evidence?: unknown }

export interface ConnectionSnapshot { name: string; baseUrl: string; authType: 'none' | 'api_key' | 'bearer'; authHeader: string; secretRef: string; allowWrite: boolean; agentAccess: 'read_only' | 'write' | 'write_destructive' }

export interface BuildCtx {
  buildId: string;
  label: string;
  project: { id: string; name: string; slug: string; description: string; outputs: { mcp: boolean; cli: boolean } };
  version: { id: string; number: string };
  tools: ToolSnapshot[];
  contextMd: string;
  specRaw: string;
  specSha: string;
  qaConnection: ConnectionSnapshot | null;
  runIntegration: boolean;
  runAgentEval: boolean;
  sampleTasks: { text: string; expected: string[]; answerContains?: string[]; label?: string }[];
  toolCases: CustomToolCase[];
  qaOnly: { sourceLabel: string; sourceWs: string } | null;
  limits: { maxRepairRounds: number; maxQaRepairRounds?: number; maxCostUsd: number; timeoutMin: number };
  generation: EffectiveGeneration | null; // null for QA runs (no code generation)
  dir: string;          // data/builds/<label>
  ws: string;           // dir/workspace
  outDir: string;       // dir/artifacts
  packageName: string;
  cliBin: string;
  mcpBin: string;
  signal: AbortSignal;
  knownSecrets: string[];
  checks: { tsc?: boolean; tscDetail?: string; secretScan?: boolean; secretDetail?: string };
  tgzPath?: string;
  log(level: 'info' | 'warn' | 'error' | 'success', stage: StageName | 'job', message: string): Promise<void>;
  setStage(stage: StageName, state: StageState): Promise<void>;
  addUsage(u: { input_tokens: number; cached_input_tokens: number; output_tokens: number }): Promise<number>; // returns total cost
}

export class BuildAbort extends Error {}

/** User-defined tool_call test case, frozen at run start. */
export interface CustomToolCase {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  target: 'mock' | 'live';
  mockResponse: { status: number; body?: unknown } | null;
  expect: { isError?: boolean; category?: string; contains?: string[] };
  steps?: { tool: string; args: Record<string, unknown>; expect: { isError?: boolean; category?: string; contains?: string[] }; cleanup: boolean }[];
}
