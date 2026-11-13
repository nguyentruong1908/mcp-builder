# MCP Factory: Technical Design

This document describes how the MVP is built. The README covers goals, setup, and the roadmap.

## 1. Decisions

| Area | Choice |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, Tailwind CSS 4, shadcn/ui-style tokens, `lucide-react` icons |
| Backend | NestJS 12 (ESM), Prisma 7 with the `pg` driver adapter, PostgreSQL 16 |
| Code generation | `@openai/codex-sdk`, always real (no mock mode). Model and reasoning come from the generation profile |
| Job queue | `Build` table in Postgres plus an in-process worker that claims jobs with `FOR UPDATE SKIP LOCKED` (no Redis) |
| Auth | None yet. Every write is recorded with actor `system` |
| Output runtime | Node.js 20+ / npm. One base template: MCP server (stdio + Streamable HTTP) and CLI sharing `factory/tools.json` |
| Monorepo | pnpm workspace: `apps/web`, `apps/api`, `packages/shared`, `templates/mcp-node` |
| Deployment | Docker Compose: `postgres`, `api`, `web`, `gateway` (Caddy, one origin for UI and `/api`) |

## 2. Architecture

```
apps/web (Next.js) ──REST/SSE──▶ apps/api (NestJS) ──▶ PostgreSQL
                                     │
                                     ├─ SpecModule         parse/validate OpenAPI, snapshots, diff, tool sync
                                     ├─ ProjectsModule     projects, context, conflicts, dashboard, settings, audit
                                     ├─ ConnectionsModule  QA environments, secret references, agent access level
                                     ├─ TestCasesModule    custom tool / multi-step / agent test cases
                                     ├─ GenerationModule   generation profiles, Codex model list and check
                                     ├─ CodexAuthModule    Codex sign-in (device code, API key, auth.json)
                                     └─ BuildsModule       export, QA runs, versions, artifacts, worker
                                          1. spec      workspace from the template (or copied from a source build)
                                          2. codex     Codex writes src/adapters/*.ts + README (skipped for QA runs)
                                          3. build     npm install, tsc, secret scan (Codex repairs ≤ N rounds)
                                          4. qa        independent QA runner, then QA-driven repair rounds
                                          5. package   npm pack, sha256, provenance.json, qa-report.json
data/ (outside the DB): build workspaces, artifacts, Codex home (auth.json)
```

**Principles enforced in code (not only in prompts):**
- Codex may only change `src/adapters/` and `README.md`. Any other change is reverted after each Codex turn. Spec and context reach Codex as data files, never as instructions.
- The QA runner is written by the Factory and never relies on tests produced by Codex. A mock pass is never reported as an integration pass.
- Missing environments or credentials produce `not_run` / `blocked` with a reason, never `pass`.
- Credentials are stored only as references (`env://VAR_NAME`). Values are read from the API environment at run time and redacted from logs and evidence. Build subprocesses get a minimal environment.
- Spec URLs are fetched only from `SPEC_FETCH_ALLOWLIST`; external `$ref`s are rejected.
- Write tools are never called with generated sample data on a live API. They are verified through user-written live test cases.

## 3. Data model (Prisma)

- `Project`: name, slug, description, owner, outputs, generation override, `archivedAt`.
- `SpecSnapshot`: raw spec, sha256, OAS/API version, normalized operations, issues. One per import.
- `ProjectContext`: structured context fields and glossary.
- `ToolDefinition`: one row per operation: `selected`, `name`, `description`, `impact` (read / write / side_effect / destructive), `requireConfirm`, `inputSchema`, `bodyWhole`, `unsupportedReason`.
- `Connection`: environment, base URL, auth type, `secretRef`, `allowWrite`, `agentAccess` (read_only / write / write_destructive), `useForQa`.
- `TestCase`: `tool_call`, `tool_steps` (ordered steps with `{{stepN.path}}` placeholders and cleanup steps), or `agent_task`.
- `Version`: semver, status (draft / released / deprecated), frozen spec, context and tools.
- `Build`: `kind` (export / qa), source build for QA runs, stage states, token usage and cost, repair and QA repair rounds, verdicts, frozen tool snapshot and generation profile, provenance.
- `BuildLog`, `QaResult` (layer × tool × status + evidence), `Artifact`, `AuditLog`, `Setting` (limits, workspace generation profile).

## 4. API (prefix `/api`)

Response types live in `packages/shared/src/index.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/dashboard` | Totals, projects, running builds, recent activity, budget |
| GET / POST | `/projects` | List / create projects |
| GET / PATCH | `/projects/:id` | Detail (with 9-step progress) / update |
| POST | `/projects/:id/archive` | Archive (never delete) |
| POST | `/projects/:id/spec` | Import a spec: `{ url }` or `{ content, filename }` |
| GET | `/projects/:id/spec` | Current snapshot and history |
| GET | `/projects/:id/spec/diff?from=&to=` | Diff between snapshots and affected tools |
| GET / PUT | `/projects/:id/context` | Structured context and glossary |
| GET | `/projects/:id/conflicts` | Detected context/spec conflicts (heuristics) |
| GET | `/projects/:id/tools` | Tool definitions |
| PATCH | `/tools/:id` | Rename, describe, set impact, confirmation, selection |
| GET / POST | `/projects/:id/connections` | QA environments |
| PATCH / DELETE | `/connections/:id` | Update (only the fields sent) / delete |
| POST | `/connections/:id/test` | Connectivity check |
| GET / POST | `/projects/:id/test-cases` | Custom test cases |
| PATCH / DELETE | `/test-cases/:id` | Update / delete a test case |
| GET / PUT | `/generation-profile` | Workspace generation profile (model, reasoning, rules → AGENTS.md) |
| GET / PUT / DELETE | `/projects/:id/generation` | Project override (DELETE = use the workspace profile) |
| GET | `/codex/models` | Models and reasoning levels from the Codex cache |
| POST | `/codex/models/check` | Proves the account can use `{ model }` |
| GET | `/codex/auth` | Codex sign-in status (never returns tokens) |
| POST / DELETE | `/codex/auth/device` | Start / cancel device-code sign-in |
| POST | `/codex/auth/api-key`, `/codex/auth/upload`, `/codex/auth/logout` | API key sign-in, auth.json upload, sign-out |
| GET | `/projects/:id/versions` | Versions |
| POST | `/versions/:id/release`, `/versions/:id/deprecate` | Release (latest build must be Package verified) / deprecate |
| POST | `/projects/:id/builds` | **Export**: freeze spec/context/tools into the draft version and queue a build |
| GET | `/projects/:id/builds` | Build history |
| GET | `/builds/:id` | Build detail, artifacts, generation profile |
| GET | `/builds/:id/logs?after=` | Redacted logs |
| GET | `/builds/:id/events` | SSE: logs and state changes |
| POST | `/builds/:id/cancel` | Cancel |
| POST | `/builds/:id/qa-run` | Standalone QA run on that build's code (Codex generation skipped) |
| GET | `/builds/:id/qa` | QA report: layers, coverage matrix, failures, results |
| GET | `/artifacts/:id/download` | Download an artifact |
| GET | `/audit` | Audit log |
| GET / PUT | `/settings` | Limits and budget |

## 5. Build pipeline

| Stage | Work | Fails when |
|---|---|---|
| spec | Check Codex sign-in, spec errors, tool selection; create the workspace from the template (QA runs copy the source build); `npm install` | No tools, spec errors, not signed in |
| codex | Write `factory/tools.json`, `context.md`, the spec and `AGENTS.md` (profile rules); a Codex thread writes adapters and the README | Codex error, cost cap |
| build | `npm run build` (tsc) with Codex repair rounds, then secret scan | Repair rounds exhausted, secrets found |
| qa | QA runner (below), then QA-driven repair: fixable failures go back to the same Codex thread, rebuild, re-run QA; stops when a round does not reduce failures | Never fails the stage; results decide the verdicts |
| package | `npm pack`, sha256, `provenance.json`, `qa-report.json` | Packaging error |

**QA layers:**

| Layer | How |
|---|---|
| input | Tool definitions are well formed |
| build | tsc result and secret scan |
| interface | MCP `tools/list` matches the selected tools and schemas; CLI `--help`, unknown command → exit 2, `--json` output |
| contract | A Factory mock built from the spec; each tool is called with sample arguments; method, path, query, body and auth are checked |
| error | Mock returns 401/404/500 and malformed JSON; the tool must return `isError` with the right category |
| runtime | Retries on 429 for read tools only, timeout handling; pagination and idempotency are `not_run` in the MVP |
| integration | Read tools are called on the live QA environment with sample arguments; write tools are credited only by live test cases |
| agent | A Codex agent uses the generated MCP server for each sample task; scored from observed tool calls, expected tools and answer content; precondition failures reported by the agent become `blocked` |
| custom | User-defined test cases (single call, multi-step with cleanup) on the mock or live environment |
| install | Install the tarball in a clean directory, run the CLI and list MCP tools |

**Verdicts:** `packageVerified` requires every input, build, interface, contract, error and install result to pass, plus no failures in runtime or custom. `integrationVerified` is `yes` when every selected tool passes integration, `partial` with some passes and some blocked/not run, `no` with any failure, `not_run` otherwise.

**Agent eval permissions:** on a live environment the agent sees read tools only, unless the connection grants `write` or `write_destructive`. The agent runs with the deployment sandbox and auto-approved tool calls. The Factory does not clean up data the agent creates; the agent decides and reports it.

## 6. Versions

- Export freezes the current spec snapshot, context and tools into the latest draft version, or creates a new draft with the next minor number.
- Release requires the latest build of the version to be Package verified. Released versions never change.
- Downloaded packages cannot be revoked; deprecation only marks a version.
