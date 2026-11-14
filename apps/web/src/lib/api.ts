import type * as T from '@mcp-builder/shared';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
/** Thrown when the API is unreachable (server down, CORS, DNS). */
export class NetworkError extends Error {}

type Init = Omit<RequestInit, 'body'> & { json?: unknown };

async function req<R>(path: string, init: Init = {}): Promise<R> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      ...rest,
      cache: 'no-store',
      headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
  } catch {
    throw new NetworkError(`Cannot reach the API at ${API_URL}`);
  }
  const text = await res.text();
  let body: unknown = undefined;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  if (!res.ok) {
    const m = (body as Partial<T.ApiError> | undefined)?.message;
    throw new ApiError(Array.isArray(m) ? m.join('; ') : m || (typeof body === 'string' && body) || `${res.status} ${res.statusText}`, res.status);
  }
  return body as R;
}

const e = encodeURIComponent;

export const api = {
  dashboard: () => req<T.DashboardDto>('/dashboard'),

  projects: () => req<T.ProjectSummary[]>('/projects'),
  project: (id: string) => req<T.ProjectDetail>(`/projects/${e(id)}`),
  createProject: (input: T.CreateProjectInput) => req<T.ProjectDetail>('/projects', { method: 'POST', json: input }),
  updateProject: (id: string, input: T.UpdateProjectInput) => req<T.ProjectDetail>(`/projects/${e(id)}`, { method: 'PATCH', json: input }),
  archiveProject: (id: string) => req<unknown>(`/projects/${e(id)}/archive`, { method: 'POST' }),

  spec: (id: string) => req<T.SpecResponse>(`/projects/${e(id)}/spec`),
  importSpec: (id: string, input: T.ImportSpecInput) => req<T.SpecSnapshotDto>(`/projects/${e(id)}/spec`, { method: 'POST', json: input }),
  specDiff: (id: string, from: string, to: string) => req<T.SpecDiff>(`/projects/${e(id)}/spec/diff?from=${e(from)}&to=${e(to)}`),

  context: (id: string) => req<T.ContextDto>(`/projects/${e(id)}/context`),
  saveContext: (id: string, input: T.UpdateContextInput) => req<T.ContextDto>(`/projects/${e(id)}/context`, { method: 'PUT', json: input }),
  conflicts: (id: string) => req<T.ConflictDto[]>(`/projects/${e(id)}/conflicts`),

  tools: (id: string) => req<T.ToolDto[]>(`/projects/${e(id)}/tools`),
  updateTool: (toolId: string, input: T.UpdateToolInput) => req<T.ToolDto>(`/tools/${e(toolId)}`, { method: 'PATCH', json: input }),

  connections: (id: string) => req<T.ConnectionDto[]>(`/projects/${e(id)}/connections`),
  createConnection: (id: string, input: T.UpsertConnectionInput) => req<T.ConnectionDto>(`/projects/${e(id)}/connections`, { method: 'POST', json: input }),
  updateConnection: (cid: string, input: Partial<T.UpsertConnectionInput>) => req<T.ConnectionDto>(`/connections/${e(cid)}`, { method: 'PATCH', json: input }),
  deleteConnection: (cid: string) => req<unknown>(`/connections/${e(cid)}`, { method: 'DELETE' }),
  testConnection: (cid: string) => req<unknown>(`/connections/${e(cid)}/test`, { method: 'POST' }),

  versions: (id: string) => req<T.VersionDto[]>(`/projects/${e(id)}/versions`),
  releaseVersion: (vid: string) => req<unknown>(`/versions/${e(vid)}/release`, { method: 'POST' }),
  deprecateVersion: (vid: string) => req<unknown>(`/versions/${e(vid)}/deprecate`, { method: 'POST' }),

  createBuild: (id: string, input: T.CreateBuildInput) => req<T.BuildSummary>(`/projects/${e(id)}/builds`, { method: 'POST', json: input }),
  builds: (id: string) => req<T.BuildSummary[]>(`/projects/${e(id)}/builds`),
  build: (bid: string) => req<T.BuildDetail>(`/builds/${e(bid)}`),
  buildLogs: (bid: string, after = 0) => req<T.BuildLogDto[]>(`/builds/${e(bid)}/logs?after=${after}`),
  cancelBuild: (bid: string) => req<unknown>(`/builds/${e(bid)}/cancel`, { method: 'POST' }),
  qa: (bid: string) => req<T.QaReport>(`/builds/${e(bid)}/qa`),
  qaRun: (bid: string, input: T.CreateQaRunInput) => req<T.BuildSummary>(`/builds/${e(bid)}/qa-run`, { method: 'POST', json: input }),

  deployment: (id: string) => req<T.DeploymentDto | null>(`/projects/${e(id)}/deployment`),
  deploy: (bid: string, input: T.DeployInput) => req<T.DeployResult>(`/builds/${e(bid)}/deploy`, { method: 'POST', json: input }),
  startDeployment: (did: string) => req<T.DeploymentDto>(`/deployments/${e(did)}/start`, { method: 'POST' }),
  stopDeployment: (did: string) => req<T.DeploymentDto>(`/deployments/${e(did)}/stop`, { method: 'POST' }),
  rotateDeploymentToken: (did: string) => req<T.DeployResult>(`/deployments/${e(did)}/rotate-token`, { method: 'POST' }),
  removeDeployment: (did: string) => req<{ ok: true }>(`/deployments/${e(did)}`, { method: 'DELETE' }),
  deploymentLogs: (did: string) => req<{ lines: string[] }>(`/deployments/${e(did)}/logs`),

  testCases: (id: string) => req<T.TestCaseDto[]>(`/projects/${e(id)}/test-cases`),
  createTestCase: (id: string, input: T.UpsertTestCaseInput) => req<T.TestCaseDto>(`/projects/${e(id)}/test-cases`, { method: 'POST', json: input }),
  updateTestCase: (tid: string, input: Partial<T.UpsertTestCaseInput>) => req<T.TestCaseDto>(`/test-cases/${e(tid)}`, { method: 'PATCH', json: input }),
  deleteTestCase: (tid: string) => req<unknown>(`/test-cases/${e(tid)}`, { method: 'DELETE' }),

  audit: () => req<T.AuditDto[]>('/audit'),
  settings: () => req<T.SettingsDto>('/settings'),
  codexAuth: () => req<T.CodexAuthStatus>('/codex/auth'),
  codexUpload: (input: T.UploadAuthInput) => req<T.CodexAuthStatus>('/codex/auth/upload', { method: 'POST', json: input }),
  codexApiKey: (input: T.ApiKeyLoginInput) => req<T.CodexAuthStatus>('/codex/auth/api-key', { method: 'POST', json: input }),
  codexDeviceStart: () => req<T.CodexAuthStatus>('/codex/auth/device', { method: 'POST' }),
  codexDeviceCancel: () => req<T.CodexAuthStatus>('/codex/auth/device', { method: 'DELETE' }),
  codexLogout: () => req<T.CodexAuthStatus>('/codex/auth/logout', { method: 'POST' }),
  saveSettings: (input: T.UpdateSettingsInput) => req<T.SettingsDto>('/settings', { method: 'PUT', json: input }),

  generationProfile: () => req<T.GenerationProfileDto>('/generation-profile'),
  saveGenerationProfile: (input: T.UpdateGenerationInput) => req<T.GenerationProfileDto>('/generation-profile', { method: 'PUT', json: input }),
  projectGeneration: (id: string) => req<T.ProjectGenerationDto>(`/projects/${e(id)}/generation`),
  saveProjectGeneration: (id: string, input: T.UpdateGenerationInput) => req<T.ProjectGenerationDto>(`/projects/${e(id)}/generation`, { method: 'PUT', json: input }),
  clearProjectGeneration: (id: string) => req<T.ProjectGenerationDto>(`/projects/${e(id)}/generation`, { method: 'DELETE' }),
  codexModels: () => req<T.CodexModelOption[]>('/codex/models'),
  checkModel: (model: string) => req<T.ModelCheckResult>('/codex/models/check', { method: 'POST', json: { model } }),
};

export const buildEventsUrl = (bid: string) => `${API_URL}/builds/${e(bid)}/events`;

/** Artifact downloadUrl may be absolute, `/api/...` or relative to the API base. */
export function absUrl(u: string): string {
  if (/^https?:\/\//.test(u)) return u;
  // API_URL may be relative (e.g. `/api` behind the gateway): then `/api/...` is already same-origin.
  if (u.startsWith('/api/')) return /^https?:/.test(API_URL) ? new URL(API_URL).origin + u : u;
  return API_URL + (u.startsWith('/') ? u : '/' + u);
}
