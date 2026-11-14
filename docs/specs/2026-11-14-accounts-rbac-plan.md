# User Accounts & RBAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin-created username/password accounts, cookie sessions, configurable roles built from a fixed permission catalog, and project membership enforced on every API route and reflected in the web UI.

**Architecture:** An Express middleware resolves the `mcpb_session` cookie and runs the request inside an `AsyncLocalStorage` context holding the user. Two global Nest guards follow: `AuthGuard` (signed in, CSRF header, forced password change) and `PermGuard` (reads `@Perm(...)` metadata, maps the route's `:id` to its project, checks workspace or project permissions; non-members get 404). Roles, users, sessions and memberships are Prisma models; the permission catalog is code in `apps/api/src/auth/permissions.ts` and is served to the web app.

**Tech Stack:** NestJS 12 (ESM), Prisma 7 + PostgreSQL 16, Next.js 16 client components, Node `crypto` (scrypt, randomBytes), `node:test`. No new dependencies.

**Spec:** `docs/specs/2026-11-14-accounts-rbac-design.md` (read it; this plan does not repeat its tables).

## Global Constraints

- Cookie `mcpb_session`: HttpOnly, SameSite=Lax, Path=/, Secure only when `PUBLIC_URL` starts with `https:`; 32 random bytes base64url; DB stores `sha256(token)` only; lifetime 7 days absolute, no sliding.
- Every non-GET `/api` request must carry header `X-MCPB-Request: 1`, else 403.
- Password: ≥ 10 characters, not equal to the username. Hash `scrypt$32768$8$1$<salt b64>$<hash b64>`, 16-byte salt, 64-byte key, `maxmem: 64 MiB` (N=2^15 exceeds Node's 32 MiB default).
- Username: lowercase, `^[a-z0-9._-]{3,32}$`, immutable after creation.
- Login limiter: 10 failures per (IP, username) per 15 minutes → 429. Failure message always `Invalid username or password`.
- Non-member (and no `projects.all`) → 404 with the same message as a missing record. Member lacking a permission → 403 `Requires permission <key>`.
- Never log, audit, return or put in a URL: passwords, hashes, session tokens. Temporary passwords appear only in the create/reset response.
- `/mcp/*` deployment proxy is untouched.
- Users are never hard-deleted. No new npm dependencies.
- Shared package stays types-only (`import type`); runtime catalogs come from `GET /api/permissions`.

## Review Focus

- **Last admin:** disabling the only admin, or moving them to Member, must be refused with 409; test in Task 4.
- **Self-escalation:** a user with only `users.manage` assigning Admin to themselves or anyone must get 403; test in Task 4.
- **Upgrade with existing data:** projects created before the migration have no members; an admin sees them, a new member does not; test in Task 3.
- **Cookie-only channels:** artifact download links and the build SSE stream must work with the cookie and fail without it; test in Task 3.
- **Revoked access mid-session:** after disable or password reset, the user's next request returns 401; test in Task 2.

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/prisma/schema.prisma` + new migration `…_accounts_rbac` | `User`, `Role`, `ProjectMember`, `Session`; seeded roles |
| `apps/api/src/auth/permissions.ts` | Catalog, labels, pure permission math |
| `apps/api/src/auth/password.ts` | Hash, verify, generate, validate |
| `apps/api/src/auth/context.ts` | `AsyncLocalStorage` request user, `actorName()` |
| `apps/api/src/auth/sessions.ts` | `SessionService`, cookie helpers, `authMiddleware` |
| `apps/api/src/auth/limiter.ts` | `LoginLimiter` |
| `apps/api/src/auth/guards.ts` | `@Public`, `@AllowPasswordChange`, `@Perm`, `AuthGuard`, `PermGuard` |
| `apps/api/src/auth/access.service.ts` | Resource → project resolution, effective permissions, accessible project ids |
| `apps/api/src/auth/auth.module.ts` | Auth controller (login/logout/me/password/setup), bootstrap admin, providers, global guards |
| `apps/api/src/accounts/accounts.module.ts` | Users, roles, permissions, members controllers |
| `apps/api/src/app.ts` | `createApp()` (moved out of `main.ts` so tests can boot the app) |
| `apps/api/src/cli/reset-password.ts` | Recovery command |
| `apps/api/test/auth.test.mjs` | Unit tests (pure modules) |
| `apps/api/test/e2e/run.mjs`, `apps/api/test/e2e/helpers.mjs`, `apps/api/test/e2e/*.test.mjs` | In-process API tests on a throwaway test database |
| `packages/shared/src/index.ts` | Permission unions and DTOs |
| `apps/web/src/lib/api.ts`, `apps/web/src/lib/auth.tsx` | Credentials, CSRF header, 401 redirect, `MeProvider` |
| `apps/web/src/app/{login,setup,account}/page.tsx` | Auth pages |
| `apps/web/src/app/settings/{users,roles}.tsx` | Admin tabs |
| `apps/web/src/app/projects/[id]/members/page.tsx` | Members page |

---

### Task 1: Data model, permission catalog, password hashing

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (add models; `Project.members`, `User` relations)
- Create: migration via `pnpm --filter api prisma:migrate --name accounts_rbac`, then append role seed `INSERT`s to the generated `migration.sql`
- Create: `apps/api/src/auth/permissions.ts`, `apps/api/src/auth/password.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `apps/api/test/auth.test.mjs`

**Interfaces:**
- Produces (Prisma): `Role { id, name, scope ('workspace'|'project'), description, permissions String[], system Boolean, createdAt; @@unique([scope, name]) }`; `User { id, username @unique, displayName, passwordHash, roleId → Role, disabled, mustChangePassword, lastLoginAt?, createdAt }`; `ProjectMember { id, projectId → Project (cascade), userId → User, roleId → Role, createdAt; @@unique([projectId, userId]) }`; `Session { id (sha256 hex of token), userId → User (cascade), createdAt, expiresAt, userAgent }`.
- Seeded roles (ids fixed so code can reference them): `role_admin` (workspace, system), `role_member` (workspace), `role_owner` (project, system), `role_developer`, `role_domain_expert`, `role_reviewer`, `role_agent_developer`, permissions as in spec §5.2.
- Produces (`permissions.ts`): `WORKSPACE_PERMISSIONS`, `PROJECT_PERMISSIONS` (readonly tuples, spec §5.1 order); `PERMISSION_INFO: PermissionInfo[]`; `ADMIN_ROLE_ID = 'role_admin'`, `OWNER_ROLE_ID = 'role_owner'`; `isPermissionOfScope(key: string, scope: RoleScope): boolean`; `effectiveProjectPermissions(workspace: readonly string[], memberRole: readonly string[] | null): ProjectPermission[] | null` (null = no access; `projects.all` → all project permissions; otherwise member role permissions); `canGrant(actor: readonly string[], role: readonly string[]): boolean` (role ⊆ actor).
- Produces (`password.ts`): `hashPassword(pw: string): Promise<string>`, `verifyPassword(pw: string, stored: string): Promise<boolean>` (false on malformed), `generatePassword(): string` (16 chars from `randomBytes(12).toString('base64url')`), `passwordProblem(pw: string, username: string): string | null`, `DUMMY_HASH: string` (computed once at module load).
- Produces (shared): `WorkspacePermission`, `ProjectPermission`, `RoleScope`, `PermissionInfo`, `MeDto`, `UserDto`, `UserCreateResult`, `UserLookupDto { id, username, displayName }`, `RoleDto`, `ProjectMemberDto` (fields per spec §5.8); `ProjectSummary.myPermissions: ProjectPermission[]`; `DeploymentDto.canManage: boolean`.

- [ ] **Step 1: Write failing unit tests** in `apps/api/test/auth.test.mjs` importing from `../dist/auth/permissions.js` and `../dist/auth/password.js`:
  - `hash round-trips`: `verifyPassword('correct horse', await hashPassword('correct horse')) === true`, wrong password false, hash starts with `scrypt$32768$8$1$`.
  - `verify rejects tampered or malformed hashes`: flip one char of the hash part → false; `'nope'` → false; never throws.
  - `password rules`: `passwordProblem('short', 'bob')` mentions `10`; `passwordProblem('alice12345', 'alice12345')` mentions `username`; `passwordProblem('a-long-password', 'bob') === null`.
  - `generatePassword` returns 16 chars and two calls differ.
  - `effective permissions`: `effectiveProjectPermissions(['projects.create'], null) === null`; with `['projects.all']` and `null` → all 12 project keys; with `[]` and `['context.edit']` → `['context.edit']`.
  - `scope check`: `isPermissionOfScope('users.manage','workspace')` true, `('users.manage','project')` false, `('nope','project')` false.
  - `canGrant`: `canGrant(['a','b'], ['a'])` true, `canGrant(['a'], ['a','b'])` false.
- [ ] **Step 2:** Run `pnpm --filter api build && pnpm --filter api test` → the new tests fail (modules missing).
- [ ] **Step 3:** Add the Prisma models and seed SQL, `permissions.ts`, `password.ts`, shared types. Run `pnpm --filter api prisma:migrate --name accounts_rbac` against the dev DB.
- [ ] **Step 4:** Run `pnpm --filter api build && pnpm --filter api test` → all tests pass (existing 11 + new).
- [ ] **Step 5:** Commit `feat(api): accounts data model, permission catalog, password hashing`.

### Task 2: Sessions, sign-in endpoints, guards, bootstrap and recovery

**Files:**
- Create: `apps/api/src/auth/context.ts`, `sessions.ts`, `limiter.ts`, `guards.ts`, `auth.module.ts`, `apps/api/src/app.ts`, `apps/api/src/cli/reset-password.ts`
- Modify: `apps/api/src/main.ts` (call `createApp()` then `listen`), `apps/api/src/core/core.services.ts` (`AuditService.log` actor default → `actorName()`), `apps/api/package.json` (script `test:e2e`)
- Create: `apps/api/test/e2e/run.mjs`, `helpers.mjs`, `auth.e2e.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`hashPassword`, `verifyPassword`, `DUMMY_HASH`, `passwordProblem`, `ADMIN_ROLE_ID`, Prisma models).
- Produces:
  - `context.ts`: `interface RequestUser { id; username; displayName; roleId; roleName; permissions: WorkspacePermission[]; mustChangePassword: boolean }`; `requestContext: AsyncLocalStorage<{ user: RequestUser | null; sessionId: string | null }>`; `currentUser(): RequestUser | null`; `actorName(): string` (username, or `'system'` outside a request).
  - `sessions.ts`: `SESSION_COOKIE = 'mcpb_session'`, `SESSION_TTL_MS = 7 * 24 * 3600 * 1000`; `SessionService.create(userId: string, userAgent: string): Promise<string>`, `.resolve(token: string): Promise<{ user: RequestUser; sessionId: string } | null>` (expired, missing or disabled → null; loads role permissions each call), `.revoke(sessionId: string)`, `.revokeAllForUser(userId: string, exceptSessionId?: string)`; `setSessionCookie(res, token)`, `clearSessionCookie(res)`; `authMiddleware(sessions: SessionService): express.RequestHandler` (parses the `cookie` header itself, runs `next` inside `requestContext.run`).
  - `limiter.ts`: `LoginLimiter.blocked(key: string): boolean`, `.fail(key: string): void`, `.reset(key: string): void`.
  - `guards.ts`: decorators `Public()`, `AllowPasswordChange()`; `AuthGuard` (global): public → allow; no user → 401; non-GET without `x-mcpb-request: 1` → 403; `mustChangePassword` and route not `AllowPasswordChange` → 403 `password_change_required`.
  - Routes (`auth.module.ts`, prefix `auth`): `GET setup-status` (public) → `{ needsSetup: boolean }`; `POST setup` (public) `{ username, displayName, password }` → `MeDto`, only while `user.count() === 0` inside a transaction, sets cookie; `POST login` (public) `{ username, password }` → `MeDto` + cookie, updates `lastLoginAt`, audits `auth.login` / `auth.login_failed`; `POST logout` (AllowPasswordChange); `GET me` (AllowPasswordChange) → `MeDto`; `POST password` (AllowPasswordChange) `{ current, next }` → `MeDto`, clears flag, revokes other sessions.
  - `AuthBootstrap.onApplicationBootstrap()`: when no users and `ADMIN_USERNAME` + `ADMIN_PASSWORD` set → create Admin user (`mustChangePassword: false`), log the username only.
  - `app.ts`: `createApp(): Promise<NestExpressApplication>` containing everything `bootstrap()` did except `listen`, plus `app.use('/api', authMiddleware(...))` before the body parser routes, CORS `{ origin: config.webOrigin.split(','), credentials: true }`.
  - `cli/reset-password.ts`: `node dist/cli/reset-password.js <username>` → prints a new temporary password, sets `mustChangePassword`, clears `disabled`, revokes sessions; exit 1 with a message for an unknown user.
  - Test harness: `run.mjs` derives the test DB URL from `DATABASE_URL` by appending `_test` to the database name, runs `prisma migrate reset --force` with it, then `node --test test/e2e/`. `helpers.mjs` exports `startApp(env?: Record<string,string>): Promise<{ base: string; app; prisma; close() }>` (sets env, imports `../../dist/app.js`, `listen(0)`), `client(base)` returning `{ login(u,p), get(path), post(path, body), patch, del, cookie }` that keeps the cookie and always sends `X-MCPB-Request: 1`, and `resetDb(prisma)` truncating everything except seeded roles.

- [ ] **Step 1: Write failing e2e tests** in `auth.e2e.test.mjs` (env `ADMIN_USERNAME=root`, `ADMIN_PASSWORD=root-password-1`):
  - `GET /api/projects` without cookie → 401.
  - `setup-status` → `{ needsSetup: false }` after bootstrap; `POST /api/auth/setup` → 403.
  - login with wrong password → 401 body message `Invalid username or password`; unknown user → same status and message.
  - login ok → `me.username === 'root'`, `me.permissions` includes `users.manage`; `Set-Cookie` contains `HttpOnly` and `SameSite=Lax`.
  - `POST /api/projects` with cookie but without `X-MCPB-Request` → 403.
  - 11 wrong attempts for the same user → the 11th returns 429.
  - a user created in DB with `mustChangePassword: true` gets 403 `password_change_required` on `GET /api/projects`, 200 on `GET /api/auth/me`; after `POST /api/auth/password` → `GET /api/projects` 200.
  - after `disabled = true` (set via Prisma) the user's next request → 401; after another session of the same user changes password, the first session → 401.
  - logout → next request 401.
  - with an empty users table and no admin env: `setup-status.needsSetup === true`, `POST setup` creates the admin and returns `MeDto`, a second `POST setup` → 403.
- [ ] **Step 2:** `pnpm --filter api build && pnpm --filter api test:e2e` → fails.
- [ ] **Step 3:** Implement the files above. Every existing controller keeps working for the signed-in admin (no `@Perm` yet).
- [ ] **Step 4:** `pnpm --filter api build && pnpm --filter api test && pnpm --filter api test:e2e` → all pass.
- [ ] **Step 5:** Commit `feat(api): sessions, sign-in, setup, guards and recovery command`.

### Task 3: Permission enforcement and access filtering

**Files:**
- Create: `apps/api/src/auth/access.service.ts`
- Modify: `apps/api/src/auth/guards.ts` (`Perm`, `PermGuard`), every controller listed in spec §5.7, `apps/api/src/projects/projects.module.ts` (filtered list/dashboard/audit, Owner membership on create, `owner` = username, `myPermissions`), `apps/api/src/deployments/deployments.module.ts` (filtered list, `canManage`), `apps/api/src/builds/builds.module.ts` (pass `actorName()` as `triggeredBy`, cancel check by build kind), `apps/api/src/generation/generation.module.ts` (`codex/models/check` rule)
- Test: `apps/api/test/e2e/access.e2e.test.mjs`

**Interfaces:**
- Consumes: Task 1 `effectiveProjectPermissions`; Task 2 `currentUser()`, `actorName()`.
- Produces:
  - `type ResourceKind = 'project' | 'connection' | 'tool' | 'testCase' | 'build' | 'version' | 'artifact' | 'deployment'`.
  - `Perm(permission: WorkspacePermission | ProjectPermission | 'member', resource?: ResourceKind)` decorator; the guard reads `req.params.id`.
  - `AccessService.projectIdOf(kind: ResourceKind, id: string): Promise<string | null>`; `.projectPermissions(user: RequestUser, projectId: string): Promise<ProjectPermission[] | null>`; `.assertProject(projectId: string, perm: ProjectPermission | 'member'): Promise<ProjectPermission[]>` (throws 404/403 per Global Constraints, uses `currentUser()`); `.accessibleProjectIds(user: RequestUser): Promise<string[] | 'all'>`; `.hasAnyProjectPermission(user, perm): Promise<boolean>`.
  - `PermGuard` (global, after `AuthGuard`): routes without `@Perm` and not `@Public` require only a signed-in user.
  - Route handlers that cannot be expressed by one decorator call `AccessService` directly: `POST builds/:id/cancel` (`builds.run` for `kind: 'export'`, `qa.run` for `kind: 'qa'`), `GET audit` (`audit.read` without `projectId`, member with it), `POST codex/models/check` (`settings.manage` or `hasAnyProjectPermission('project.edit')`).

- [ ] **Step 1: Write failing e2e tests** in `access.e2e.test.mjs`. Setup: admin creates users `dev` (Member) and `outsider` (Member) directly through Prisma with known passwords; `dev` creates project P via `POST /api/projects`.
  - `dev`'s `GET /api/projects` contains P with `myPermissions` = all 12 keys (Owner); `outsider`'s list is empty; `outsider` `GET /api/projects/:P` → 404 with the same body as `GET /api/projects/does-not-exist`.
  - A project inserted directly via Prisma (no members, simulating pre-upgrade data): visible to admin, invisible to `dev`.
  - Add `outsider` as member of P with `role_agent_developer` (Prisma insert): `GET /api/projects/:P` 200; `PUT /api/projects/:P/context` → 403 `Requires permission context.edit`; `POST /api/projects/:P/connections` → 403.
  - Child-resource routes resolve to the project: `outsider` (agent developer) `PATCH /api/connections/:id` → 403; a third user who is not a member → 404 on the same route.
  - Artifact: seed a build + artifact file for P via Prisma; `GET /api/artifacts/:id/download` with `outsider` (has `artifacts.download`) → 200; with the third user (not a member) → 404; without cookie → 401.
  - SSE: `GET /api/builds/:id/events` with cookie → 200 `text/event-stream`; without → 401.
  - `GET /api/dashboard` for `outsider` before membership: `stats.projects === 0` and no recent activity mentioning P.
  - `GET /api/audit` as `dev` → 403; `GET /api/audit?projectId=P` as `dev` → 200; admin `GET /api/audit` → 200 and P's creation entry has `actor === 'dev'`.
  - `PATCH /api/projects/:P` as `dev`, then admin `GET /api/audit?projectId=P` → the `project.update` entry has `actor === 'dev'`.
- [ ] **Step 2:** `pnpm --filter api build && pnpm --filter api test:e2e` → fails.
- [ ] **Step 3:** Implement `AccessService`, `Perm`/`PermGuard`, decorate every route per spec §5.7, filter lists, add Owner membership on project create, `myPermissions`, `canManage`. Builds and QA runs pass `actorName()` to the existing `actor` parameter (stored as `triggeredBy`); not covered by a test because starting a build needs Codex.
- [ ] **Step 4:** All unit and e2e tests pass.
- [ ] **Step 5:** Commit `feat(api): enforce RBAC on every route and filter lists by membership`.

### Task 4: Users, roles, permissions and members APIs

**Files:**
- Create: `apps/api/src/accounts/accounts.module.ts` (register in `app.ts`)
- Test: `apps/api/test/e2e/accounts.e2e.test.mjs`

**Interfaces:**
- Consumes: Task 1 `canGrant`, `isPermissionOfScope`, `generatePassword`, `hashPassword`, `passwordProblem`; Task 2 `SessionService.revokeAllForUser`, `currentUser()`; Task 3 `Perm`, `AccessService.assertProject`.
- Produces routes (all audited with the actions in spec §5.7):
  - `GET users` (`users.manage`) → `UserDto[]`; `GET users/lookup?q=` (`users.manage` or `hasAnyProjectPermission('members.manage')`) → `UserLookupDto[]` (enabled users, max 20); `POST users` (`users.manage`) `{ username, displayName, roleId, password? }` → `UserCreateResult` (`temporaryPassword` set only when generated); `PATCH users/:id` `{ displayName?, roleId?, disabled? }` → `UserDto`; `POST users/:id/reset-password` `{ password? }` → `{ temporaryPassword: string | null }`.
  - `GET permissions` (signed in) → `PermissionInfo[]`.
  - `GET roles` (signed in) → `RoleDto[]` with `usage`; `POST roles`, `PATCH roles/:id`, `DELETE roles/:id` (`roles.manage`).
  - `GET projects/:id/members` (member) → `ProjectMemberDto[]`; `POST projects/:id/members` `{ userId, roleId }`; `PATCH projects/:id/members/:userId` `{ roleId }`; `DELETE projects/:id/members/:userId` (`members.manage`).
  - Rules (409 for invariants, 403 for escalation, 400 for validation): username format and uniqueness; password rules; role scope must match (workspace role for users, project role for members); escalation checks with `canGrant`: assigning a workspace role to a user, or creating/editing a workspace role, requires role permissions ⊆ the actor's workspace permissions; creating/editing a project role requires the actor to hold `projects.all`; assigning a project role to a member requires role permissions ⊆ the actor's effective permissions in that project; no edits to own workspace role, own disabled flag, own project role, or a role the actor is assigned to; system roles immutable and undeletable; role in use not deletable (409 with usage count); last-admin guard (enabled users whose role has both `users.manage` and `roles.manage` must stay ≥ 1); disabling or resetting revokes sessions.

- [ ] **Step 1: Write failing e2e tests** in `accounts.e2e.test.mjs`:
  - admin creates `carol` (Member) without password → response has a 16-char `temporaryPassword`; `carol` logs in with it and gets `mustChangePassword: true`; `GET /api/users` response never contains `passwordHash`.
  - duplicate username → 400/409; `Bad Name` → 400; password `short` → 400.
  - a custom workspace role `UserManager` with only `users.manage` assigned to `uma`: `uma` assigning `role_admin` to `carol` → 403; `uma` changing own role → 403; `uma` creating a Member user → 200.
  - `uma` with `roles.manage` added by admin cannot add `projects.all` to any role → 403.
  - disabling the only admin (`root`) as `root` → 403 (self); as another admin created for the test, disabling `root` → 200, then disabling the last one → 409.
  - `PATCH roles/role_admin` → 409/403; `DELETE roles/role_developer` while in use → 409 with usage; create, edit and delete an unused project role → 200; permissions of the wrong scope → 400.
  - members: Owner `dev` adds `carol` as Reviewer → `carol` sees the project; `carol` (Reviewer) adding a member → 403; `dev` making `carol` Owner → 200; `carol` changing her own project role → 403; removing `carol` → she gets 404 on the project.
  - reset password → old sessions 401, new temporary password works.
  - `GET /api/users/lookup?q=car` as `dev` (has `members.manage` in P) → contains `carol` with only id/username/displayName; as an agent developer → 403.
- [ ] **Step 2:** Tests fail.
- [ ] **Step 3:** Implement `accounts.module.ts`.
- [ ] **Step 4:** All unit and e2e tests pass.
- [ ] **Step 5:** Commit `feat(api): users, roles and project members with escalation guards`.

### Task 5: Web sign-in, session handling, account page

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`credentials: 'include'`, `X-MCPB-Request: 1` on non-GET, 401 → `window.location.assign('/login?next=' + encodeURIComponent(path))` unless already on `/login` or `/setup`, new endpoint functions for Tasks 2 and 4), `apps/web/src/app/projects/[id]/builds/[buildId]/page.tsx` (`new EventSource(url, { withCredentials: true })`), `apps/web/src/components/app-shell.tsx` (render bare children on `/login` and `/setup`; wrap in `MeProvider`; redirect to `/account` while `mustChangePassword`; footer shows display name + workspace role with Account and Sign out)
- Create: `apps/web/src/lib/auth.tsx`, `apps/web/src/app/login/page.tsx`, `apps/web/src/app/setup/page.tsx`, `apps/web/src/app/account/page.tsx`

**Interfaces:**
- Consumes: Task 2 routes; shared `MeDto`.
- Produces: `MeProvider({ children })`; `useMe(): { me: MeDto; refetch(): void }`; `hasWorkspacePerm(me: MeDto, p: WorkspacePermission): boolean`; `safeNext(next: string | null): string` (only paths starting with `/` and not `//`, default `/`).

- [ ] **Step 1:** Implement the files. `/login`: username, password, submit, error text from the API, redirects to `safeNext(next)`; checks `setup-status` and routes to `/setup` when needed. `/setup`: username, display name, password, confirm. `/account`: change password form (current, new, confirm), shows the reason when forced.
- [ ] **Step 2:** `pnpm --filter web exec tsc --noEmit` passes.
- [ ] **Step 3:** Rebuild Docker (`docker compose up -d --build api web`) with `ADMIN_USERNAME`/`ADMIN_PASSWORD` in `.env`; in the browser pane verify: unauthenticated `/` redirects to `/login?next=%2F`; wrong password shows the error; sign-in lands on the dashboard; a build page streams logs; a package download works; Sign out returns to `/login`; `?next=//evil.example` lands on `/`.
- [ ] **Step 4:** Commit `feat(web): sign-in, setup, account and session handling`.

### Task 6: Web administration and permission-aware UI

**Files:**
- Create: `apps/web/src/app/settings/users.tsx`, `apps/web/src/app/settings/roles.tsx`, `apps/web/src/app/projects/[id]/members/page.tsx`
- Modify: `apps/web/src/app/settings/page.tsx` (tabs Users, Roles, Audit shown per permission; budget and generation forms read-only without `settings.manage`), `apps/web/src/app/settings/codex-auth.tsx` (controls read-only without `codex.manage`), `apps/web/src/components/app-shell.tsx` (Members in project nav; export project perms via `useProjectPermissions(): ProjectPermission[]`; hide Export without `builds.run`; hide New project without `projects.create`), pages under `apps/web/src/app/projects/[id]/` and `apps/web/src/app/deployments/page.tsx`, `apps/web/src/app/page.tsx`, `apps/web/src/components/deploy-dialog.tsx`

**Interfaces:**
- Consumes: Task 4 routes; Task 3 `myPermissions`, `canManage`; Task 5 `useMe`.
- Produces: `useProjectPermissions()`; `deniedTitle(has: boolean, permLabel: string): string | undefined` → `Requires permission <label>` when missing.

- [ ] **Step 1:** Users tab: table (username, display name, role, status, last sign-in), create dialog (shows the temporary password once with Copy), edit (display name, role), reset password, disable/enable; API errors shown inline. Roles tab: two matrices (project, workspace) built from `GET /api/permissions` and `GET /api/roles`, checkbox per role × permission, system roles locked, create/rename/delete with usage count. Members page: list; with `members.manage`, add via `users/lookup` search + role select, change role, remove.
- [ ] **Step 2:** Gate actions per spec §5.9 using `useProjectPermissions()` / `myPermissions` / `canManage`: disabled with `deniedTitle(...)` for visible controls (save buttons, Run QA, Release, Deploy actions, connections and test case editing, downloads), hidden where noise (Export, New project).
- [ ] **Step 3:** `pnpm --filter web exec tsc --noEmit` passes.
- [ ] **Step 4:** Rebuild web; in the browser verify as admin: create user `qa` (Member), create custom project role "Release manager" (`versions.release`, `artifacts.download`), add `qa` to ERP Sales Tools with it. Sign in as `qa` in a fresh session: forced password change, only ERP Sales Tools listed, Release enabled, Export hidden, connection editing disabled with the tooltip, Settings shows no Users/Roles/Audit tabs.
- [ ] **Step 5:** Commit `feat(web): users, roles, members and permission-aware UI`.

### Task 7: Configuration, docs and upgrade check

**Files:**
- Modify: `.env.example`, `apps/api/.env.example` (`ADMIN_USERNAME`, `ADMIN_PASSWORD`), `docker-compose.yml` (pass both to `api`), `README.md` (sign-in, first admin, roles and membership, recovery command, Known limitations from spec §6, remove "no user accounts" warnings, roadmap: move "User accounts and roles" to Done), `docs/design.md` (Auth row, data model, API table)

- [ ] **Step 1:** Update the files.
- [ ] **Step 2:** Upgrade check on the existing Docker stack: `docker compose up -d --build`; admin from `.env` signs in; ERP Sales Tools and FPTChat MCP visible to the admin; `curl -X POST <PUBLIC_URL>/mcp/docker-smoke` without token → 401 (proxy untouched); `docker compose exec api node dist/cli/reset-password.js <admin>` prints a temporary password that works and forces a change.
- [ ] **Step 3:** `pnpm --filter api build && pnpm --filter api test && pnpm --filter api test:e2e && pnpm --filter web exec tsc --noEmit` all pass.
- [ ] **Step 4:** Commit `docs: accounts, roles, recovery and known limitations`.
