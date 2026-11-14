// API contract shared by apps/web and apps/api. Types only: import with `import type`.

export type Impact = 'read' | 'write' | 'side_effect' | 'destructive';
export type BuildStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type StageName = 'spec' | 'codex' | 'build' | 'qa' | 'package';
export type StageState = 'idle' | 'running' | 'ok' | 'failed' | 'skipped';
export type QaLayer = 'input' | 'build' | 'interface' | 'contract' | 'error' | 'runtime' | 'integration' | 'agent' | 'custom' | 'install';
export type QaStatus = 'pass' | 'fail' | 'blocked' | 'not_run';
export type IntegrationVerdict = 'yes' | 'partial' | 'no' | 'not_run';
export type VersionStatus = 'draft' | 'released' | 'deprecated';
export type AuthType = 'none' | 'api_key' | 'bearer';
export type JsonSchema = Record<string, unknown>;

export interface Outputs { mcp: boolean; cli: boolean }

// ---------- projects ----------
export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  owner: string;
  outputs: Outputs;
  archivedAt: string | null;
  createdAt: string;
  specSource: string | null; // url or filename of current snapshot
  toolCount: number;         // supported operations
  selectedCount: number;
  currentRelease: VersionSummary | null;
  latestDraft: VersionSummary | null;
  latestBuild: BuildSummary | null;
}

export type StepState = 'done' | 'warn' | 'fail' | 'todo';
export interface ProjectStep { key: string; label: string; state: StepState; detail?: string }
export interface ProjectDetail extends ProjectSummary { steps: ProjectStep[] }

export interface CreateProjectInput { name: string; description?: string; owner?: string; outputs?: Outputs }
export type UpdateProjectInput = Partial<CreateProjectInput>;

// ---------- spec ----------
export interface SpecIssue { level: 'warning' | 'unsupported' | 'error'; operation?: string; message: string }
export interface SpecSnapshotDto {
  id: string;
  createdAt: string;
  source: 'url' | 'upload';
  sourceUrl: string | null;
  filename: string | null;
  sha256: string;
  oasVersion: string;
  apiVersion: string;
  title: string;
  operationCount: number;
  supportedCount: number;
  issues: SpecIssue[];
  securitySchemes: string[];
  servers: string[];
}
export interface SpecResponse { current: SpecSnapshotDto | null; history: SpecSnapshotDto[] }
export interface ImportSpecInput { url?: string; content?: string; filename?: string }

export interface OpRef { method: string; path: string }
export interface SpecDiff {
  from: string;
  to: string;
  added: OpRef[];
  removed: OpRef[];
  changed: (OpRef & { changes: string[] })[];
  affectedTools: { name: string; reason: string }[];
  breaking: boolean;
  suggestedBump: 'major' | 'minor' | 'patch';
}

// ---------- context ----------
export interface GlossaryEntry { term: string; meaning: string; mapping: string }
export interface ContextDto {
  purpose: string;
  sampleTasks: string;     // one task per line
  businessRules: string;
  dataFormats: string;
  accessScope: string;
  impacts: string[];
  expectedResults: string;
  freeform: string;
  glossary: GlossaryEntry[];
  updatedAt: string | null;
}
export type UpdateContextInput = Omit<ContextDto, 'updatedAt'>;
export interface ConflictDto { id: string; severity: 'warning' | 'info'; title: string; detail: string }

// ---------- tools ----------
export interface ToolParam { name: string; in: 'path' | 'query' | 'header' | 'body'; type: string; required: boolean; description: string }
export interface ToolDto {
  id: string;
  method: string;
  path: string;
  tag: string;
  operationId: string | null;
  name: string;
  description: string;
  impact: Impact;
  requireConfirm: boolean;
  selected: boolean;
  unsupportedReason: string | null;
  inputSchema: JsonSchema;
  params: ToolParam[];
}
export type UpdateToolInput = Partial<Pick<ToolDto, 'name' | 'description' | 'impact' | 'requireConfirm' | 'selected'>>;

// ---------- connections ----------
export type AgentAccess = 'read_only' | 'write' | 'write_destructive';
export interface ConnectionCheck { ok: boolean; status?: number; latencyMs?: number; message?: string; at: string }
export interface ConnectionDto {
  id: string;
  name: string;
  baseUrl: string;
  authType: AuthType;
  authHeader: string;      // header name for api_key, e.g. X-Api-Key
  secretRef: string;       // env://VAR_NAME, never the secret itself
  allowWrite: boolean;
  /** Which tools the agent-eval agent may call on this env. Data-changing levels require allowWrite. */
  agentAccess: AgentAccess;
  useForQa: boolean;
  secretResolvable: boolean;
  lastCheck: ConnectionCheck | null;
}
export type UpsertConnectionInput = Omit<ConnectionDto, 'id' | 'secretResolvable' | 'lastCheck'>;

// ---------- versions ----------
export interface VersionSummary { id: string; number: string; status: VersionStatus; apiVersion: string; createdAt: string; releasedAt: string | null }
export interface VersionDto extends VersionSummary { changelog: string; toolCount: number; latestBuild: BuildSummary | null }

// ---------- builds ----------
export interface TokenUsage { input: number; cachedInput: number; output: number }
export type BuildKind = 'export' | 'qa';
export interface BuildSummary {
  id: string;
  kind: BuildKind;                 // 'qa' = standalone QA run on the code of sourceBuildLabel (Codex step skipped)
  sourceBuildId: string | null;
  sourceBuildLabel: string | null;
  seq: number;
  label: string;           // b-0007
  projectId: string;
  projectName: string;
  versionId: string;
  versionNumber: string;
  status: BuildStatus;
  stage: StageName | null;
  stages: Record<StageName, StageState>;
  packageVerified: boolean | null;
  integrationVerified: IntegrationVerdict | null;
  repairRounds: number;      // Codex rounds fixing TypeScript build errors
  qaRepairRounds: number;    // Codex rounds fixing failed QA results
  tokens: TokenUsage;
  costUsd: number;
  durationMs: number | null;
  triggeredBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
export interface ArtifactDto { id: string; kind: 'mcp_package' | 'qa_report' | 'provenance'; filename: string; sha256: string; size: number; downloadUrl: string }
export interface BuildDetail extends BuildSummary {
  provenance: Record<string, string>;
  artifacts: ArtifactDto[];
  limits: { maxRepairRounds: number; maxQaRepairRounds?: number; maxCostUsd: number; timeoutMin: number };
  generation: EffectiveGeneration | null;   // profile frozen at build start (null for QA runs / old builds)
}
export interface BuildLogDto { id: number; ts: string; level: 'info' | 'warn' | 'error' | 'success'; stage: StageName | 'job'; message: string }
export type BuildEvent = { type: 'log'; log: BuildLogDto } | { type: 'build'; build: BuildSummary };
export interface CreateBuildInput { runIntegration: boolean; runAgentEval?: boolean }
/** POST /builds/:id/qa-run: re-runs QA (incl. custom test cases) on that build's generated code. */
export interface CreateQaRunInput { runIntegration: boolean; runAgentEval?: boolean }

// ---------- custom test cases ----------
export type TestCaseKind = 'tool_call' | 'tool_steps' | 'agent_task';
/**
 * One step of a tool_steps test case. String args may reference earlier results:
 * "{{step1.id}}" (whole value, keeps type) or "Order {{step1.id}}" (interpolated). Paths: a.b.0.c
 */
export interface TestStep {
  tool: string;
  args: Record<string, unknown>;
  expect: TestCaseExpect;
  cleanup: boolean;   // runs at the end even if earlier steps failed (e.g. delete created data)
}
export interface TestStepResult { index: number; tool: string; cleanup: boolean; status: 'pass' | 'fail' | 'skipped'; args: unknown; result: string; detail: string }
export interface TestCaseExpect {
  isError?: boolean;      // tool_call: expected isError (default false)
  category?: string;      // tool_call: expected error category, e.g. conflict, not_found, auth
  contains?: string[];    // tool_call: strings that must appear in the tool result text
}
export interface TestCaseDto {
  id: string;
  kind: TestCaseKind;
  name: string;
  enabled: boolean;
  // tool_call
  tool: string | null;
  args: Record<string, unknown> | null;
  target: 'mock' | 'live';                               // mock = built-in mock API, live = QA connection
  mockResponse: { status: number; body?: unknown } | null; // tool_call + mock: simulated upstream response
  expect: TestCaseExpect;
  // tool_steps
  steps: TestStep[];
  // agent_task
  task: string | null;
  expectedTools: string[];
  answerContains: string[];
  createdAt: string;
  updatedAt: string;
}
export type UpsertTestCaseInput = Omit<TestCaseDto, 'id' | 'createdAt' | 'updatedAt'>;

// ---------- QA ----------
export interface QaResultDto { id: string; layer: QaLayer; tool: string | null; name: string; status: QaStatus; detail: string; evidence?: unknown }
export interface QaLayerSummary { layer: QaLayer; pass: number; fail: number; blocked: number; notRun: number }
export interface QaReport {
  build: BuildSummary;
  layers: QaLayerSummary[];
  matrix: { tool: string; cells: Partial<Record<QaLayer, QaStatus>> }[];
  failures: QaResultDto[];
  results: QaResultDto[];
}

// ---------- dashboard / audit / settings ----------
export interface AuditDto { id: string; at: string; actor: string; action: string; target: string; meta: Record<string, unknown> | null }
export interface DashboardDto {
  stats: { projects: number; releasedProjects: number; runningBuilds: number; failedQa7d: number; newVersions7d: number; integrationVerified7d: number };
  projects: ProjectSummary[];
  running: BuildSummary[];
  activity: AuditDto[];
  budget: { costUsdMonth: number; budgetUsdMonth: number };
}
export interface SettingsDto { maxCostUsdPerBuild: number; maxRepairRounds: number; maxQaRepairRounds: number; monthlyBudgetUsd: number; buildTimeoutMin: number; codexModel: string }
export type UpdateSettingsInput = Partial<Omit<SettingsDto, 'codexModel'>>;

// ---------- generation profile ----------
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
/** How Codex generates code. Workspace default; a project may override model/reasoning and add rules. */
export interface GenerationProfile {
  model: string | null;                    // null = inherit (workspace) / CODEX_MODEL env (workspace level)
  reasoningEffort: ReasoningEffort | null; // null = inherit / model default
  rules: string;                           // markdown, written to AGENTS.md in the build workspace (additive)
}
export interface GenerationProfileDto extends GenerationProfile { version: number; updatedAt: string | null }
export interface EffectiveGeneration {
  model: string;
  reasoningEffort: ReasoningEffort | null;
  rules: string;                           // workspace rules + project rules, as written to AGENTS.md
  rulesSha256: string;
  workspaceVersion: number;
  projectVersion: number | null;
  source: { model: 'project' | 'workspace' | 'env'; reasoningEffort: 'project' | 'workspace' | 'default' };
}
export interface ProjectGenerationDto {
  workspace: GenerationProfileDto;
  override: GenerationProfileDto | null;   // null = project uses the workspace profile as is
  effective: EffectiveGeneration;
}
export type UpdateGenerationInput = GenerationProfile;
export interface CodexModelOption { slug: string; displayName: string; defaultReasoning: ReasoningEffort | null; reasoningEfforts: ReasoningEffort[] }
export interface ModelCheckResult { ok: boolean; model: string; message: string }

// ---------- deployments (optional managed hosting) ----------
export type DeploymentStatus = 'starting' | 'running' | 'stopped' | 'failed';
/** Copyable snippet for an MCP client or agent. `{{TOKEN}}` is replaced in the UI when the token is known. */
export interface DeployInstruction { id: string; title: string; language: 'bash' | 'toml' | 'json' | 'markdown'; content: string }
export interface DeploymentDto {
  id: string;
  projectId: string;
  slug: string;                 // public path: /mcp/<slug>
  url: string;                  // full MCP endpoint (Streamable HTTP)
  status: DeploymentStatus;
  buildId: string;
  buildLabel: string;
  versionNumber: string;
  packageName: string;
  connectionId: string;
  connectionName: string;       // environment whose credentials the server uses upstream
  tokenHint: string;            // last characters of the bearer token; the token itself is shown once
  lastError: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
  tools: { name: string; description: string; impact: Impact; requireConfirm: boolean }[];
  instructions: DeployInstruction[];
}
export interface DeployInput { connectionId: string }
/**
 * Returned by deploy and token rotation: the only time a token is visible.
 * token is null when redeploying an existing deployment, which keeps its URL and token so connected agents keep working.
 */
export interface DeployResult { deployment: DeploymentDto; token: string | null }

// ---------- codex auth ----------
export type DeviceLoginState = 'idle' | 'pending' | 'success' | 'failed' | 'cancelled';
export interface CodexAuthStatus {
  configured: boolean;
  source: 'auth_file' | 'env_api_key' | null;
  mode: 'chatgpt' | 'api_key' | null;
  email: string | null;
  plan: string | null;
  lastRefresh: string | null;
  codexVersion: string;
  model: string;
  sandbox: string;
  sandboxError: string | null; // null when the Codex sandbox works (or is disabled)
  device: { state: DeviceLoginState; url: string | null; code: string | null; expiresAt: string | null; error: string | null };
}
export interface UploadAuthInput { content: string }
export interface ApiKeyLoginInput { apiKey: string }

export interface ApiError { statusCode: number; message: string | string[] }
