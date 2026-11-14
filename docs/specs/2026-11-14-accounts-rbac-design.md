# User accounts, sign-in and RBAC: design

Status: proposed · 2026-11-14

## 1. Intent

MCP Builder has no users today: anyone who reaches the port can manage the Codex sign-in, run builds, deploy servers and read every project. The goal is to let a team share one MCP Builder server safely:

- people sign in with a **username and password created by an admin**;
- what each person may do is decided by **roles that admins configure** (RBAC), not roles hard-coded in the product;
- access to a **Tool Project is by membership**: people who are not members of a project cannot see it at all.

## 2. Goals, non-goals, anti-goals

**Goals**
- Sign-in page, session handling, sign-out, change own password.
- Admin-managed users: create, edit, reset password, disable/enable.
- Configurable roles built from a fixed permission catalog, in two scopes: workspace and project.
- Project membership with one project role per member; non-members get 404.
- Every API route enforces a permission on the server; the UI hides or disables what the user may not do.
- Audit log and builds record the real user instead of `system`.

**Non-goals (this version)**
- SSO / OIDC / LDAP, self sign-up, email invitations or email password reset, 2FA.
- Personal API tokens for users (agents keep using deployment bearer tokens).
- Per-tool or per-environment permissions; multiple workspaces.

**Anti-goals (failure even if it "works")**
- Admins can lock themselves out (no admin left, or the Admin role broken).
- Passwords, password hashes or session tokens appear in logs, audit entries, API responses or the URL.
- Existing deployed MCP endpoints (`/mcp/<slug>`) or the agents using them stop working.
- A non-member can learn that a project exists (names in dashboard, deployments, audit, artifact downloads, SSE).

## 3. Constraints from the current system

- Web (Next.js, all client components) calls the API with `fetch`; build logs stream over **SSE (`EventSource`)** and artifacts download through **plain links**. Neither can send an `Authorization` header, so authentication must be a **cookie**.
- In Docker the gateway serves web and API on one origin. In local development web runs on `:3000` and the API on `:4000` (same site `localhost`, different origin): CORS must allow credentials for `WEB_ORIGIN`.
- `/mcp/*` is a raw Express proxy mounted outside Nest and outside the `/api` prefix; it keeps its own bearer-token auth and is not affected by sign-in.
- `@mcp-builder/shared` is **types only** (imported with `import type`, no runtime build). Runtime lists such as the permission catalog must come from the API.
- `AuditService.log(..., actor = 'system')`, `BuildsService.create/createQaRun(..., actor = 'system')` and `Project.owner` already carry an actor string.
- No new dependencies are needed: passwords use Node's `crypto.scrypt`, sessions use random tokens.

## 4. Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| A. One fixed role per user for the whole workspace | Least code; cannot restrict a person to some projects | Rejected |
| B. Workspace role + project membership with project roles | Isolates projects between teams; every list must filter by access | **Chosen** |
| C. Three fixed roles (Admin / Editor / Viewer) | Simplest UI; loses reviewer-only release and the planned personas | Rejected |
| Hard-coded roles vs configurable RBAC | Hard-coded is simpler; RBAC lets admins adapt roles without a release | **RBAC chosen**: permissions fixed in code, roles are data |

## 5. Decisions

### 5.1 Permission catalog (fixed in code)

Workspace permissions (granted by the user's workspace role):

| Key | Allows |
|---|---|
| `users.manage` | Create users, edit, reset passwords, disable/enable |
| `roles.manage` | Create, edit and delete roles |
| `codex.manage` | Codex sign-in: device code, API key, `auth.json` upload, sign-out |
| `settings.manage` | Limits/budget and the workspace generation profile |
| `audit.read` | Workspace-wide audit log |
| `projects.create` | Create projects |
| `projects.all` | Act as a member with **every project permission** on every project, member or not |

Project permissions (granted by the member's role in that project):

| Key | Allows |
|---|---|
| `project.edit` | Name, description, outputs, archive, project generation override |
| `spec.edit` | Import specs |
| `context.edit` | Context, glossary, sample tasks |
| `tools.edit` | Tool designer changes |
| `connections.manage` | Create, edit, delete and test QA environments |
| `testcases.manage` | Create, edit, delete test cases |
| `builds.run` | Export (start a build), cancel an export |
| `qa.run` | Start a standalone QA run, cancel a QA run |
| `versions.release` | Release and deprecate versions |
| `deploy.manage` | Deploy, redeploy, start, stop, rotate token, remove a deployment |
| `members.manage` | Add and remove members, change their project role |
| `artifacts.download` | Download packages, QA reports and provenance |

Being a member always allows **viewing** the project: overview, spec, tools, connections (secret refs only, as today), builds and logs, QA reports, versions, deployment details and deployment logs.

The API serves the catalog with labels and descriptions at `GET /api/permissions` so the UI does not duplicate it.

### 5.2 Roles (data)

`Role { id, name, scope: 'workspace' | 'project', description, permissions: string[], system: boolean }`. Name is unique per scope. Permissions must belong to the role's scope (validated).

Seeded on first migration:

| Scope | Role | Permissions | System |
|---|---|---|---|
| workspace | Admin | all workspace permissions | yes |
| workspace | Member | `projects.create` | no |
| project | Owner | all project permissions | yes |
| project | Developer | all project permissions except `members.manage` and `versions.release` | no |
| project | Domain expert | `context.edit`, `testcases.manage`, `artifacts.download` | no |
| project | Reviewer | `testcases.manage`, `qa.run`, `versions.release`, `artifacts.download` | no |
| project | Agent developer | `artifacts.download` | no |

Rules:
- System roles (Admin, Owner) cannot be edited or deleted; their name and permissions are fixed.
- A role in use (by a user or a membership) cannot be deleted; the UI says how many use it.
- Permission changes take effect on the next request (permissions are loaded per request, not stored in the session).
- **No privilege escalation** *(builder's call, prevents `users.manage`/`roles.manage`/`members.manage` from being admin-equivalent)*:
  - Assigning a workspace role to a user (create, edit) requires that the actor already holds every permission of that role.
  - Creating or editing a role may only include permissions the actor holds; editing or deleting a role the actor is assigned to is refused.
  - Users cannot change their own workspace role, disable themselves, or change their own project role.
  - Assigning a project role to a member requires the actor to hold every permission of that role in that project (users with `projects.all` hold all project permissions).

### 5.3 Users

`User { id, username (unique, lowercase, [a-z0-9._-], 3–32), displayName, passwordHash, roleId (workspace role), disabled, mustChangePassword, lastLoginAt, createdAt }`.

- Admins (`users.manage`) create a user with username, display name and workspace role. The server **generates a temporary password**, returns it **once** in the response, and sets `mustChangePassword`. Admins can also type the initial password instead.
- Reset password: same, new temporary password shown once; all of that user's sessions are revoked.
- Disable: sign-in refused and all sessions revoked. Users are never hard-deleted (audit and builds keep pointing at them).
- **Last-admin guard:** the server refuses any change (disable, change workspace role) that would leave no enabled user whose role has `users.manage` and `roles.manage`.
- Password rules: at least 10 characters; not equal to the username.
- Hash: `scrypt` (N=2^15, r=8, p=1, 64-byte key, 16-byte random salt) stored as `scrypt$N$r$p$salt$hash` (base64); compared with `timingSafeEqual`. Unknown usernames are checked against a dummy hash so timing does not reveal which usernames exist.

### 5.4 Sessions and sign-in

- `POST /api/auth/login { username, password }` → sets cookie `mcpb_session` (random 32 bytes, base64url). The DB stores only `sha256(token)`: `Session { id (=hash), userId, createdAt, expiresAt, lastSeenAt, userAgent }`.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `PUBLIC_URL` is https. Lifetime **7 days absolute** from sign-in (`expiresAt = createdAt + 7d`), no sliding refresh; after that the user signs in again. *(Builder's call: simplest schema, predictable expiry.)*
- `POST /api/auth/logout` deletes the session. `GET /api/auth/me` returns the current user (see 5.8). `POST /api/auth/password { current, next }` changes the own password, clears `mustChangePassword` and revokes the user's other sessions.
- Brute force: in-memory limiter, 10 failed attempts per (IP, username) per 15 minutes → 429. Generic error message `Invalid username or password` for every failure, including disabled users.
- CSRF: `SameSite=Lax` plus a required header `X-MCPB-Request: 1` on every non-GET API request (the web client always sends it; a cross-site form cannot, and CORS preflight blocks other origins). Requests without it get 403.
- While `mustChangePassword` is set, every API route except `auth/me`, `auth/password` and `auth/logout` returns 403 `password_change_required`.

### 5.5 First admin and recovery

- On API start, if there are **no users** and `ADMIN_USERNAME` + `ADMIN_PASSWORD` are set, create that user with the Admin role (`mustChangePassword = false`). Log the username only.
- If there are no users and the variables are not set, the web app shows a **first-run setup page** (`/setup`) to create the first admin; `POST /api/auth/setup` works only while the users table is empty (checked in a transaction), then is permanently refused.
- Recovery command inside the container: `node dist/cli/reset-password.js <username>` prints a new temporary password, sets `mustChangePassword`, enables the user, gives nothing else.

### 5.6 Project membership

`ProjectMember { projectId, userId, roleId (project role), createdAt; unique(projectId, userId) }`.

- The creator of a project becomes a member with the **Owner** role. `Project.owner` stores the creator's username (display only).
- Effective project permissions of a user = permissions of their member role, or **all project permissions** if their workspace role has `projects.all`. Admins therefore manage every project without being members.
- Members page per project: list members (display name, username, role); with `members.manage`: add an existing enabled user with a project role, change role, remove.
- A project may end up with no member holding `members.manage`; users with `projects.all` can always fix it. No extra guard.
- Existing projects (created before this feature) have no members: only `projects.all` users see them until members are added. The release note says so.

### 5.7 Enforcement in the API

- A global Nest guard authenticates every route under `/api` except `auth/login`, `auth/setup`, `auth/setup-status` (tells the web app whether setup is needed). Unauthenticated → 401.
- Routes declare what they need with a decorator, for example `@Perm('tools.edit', { project: 'tool' })`. The resolver maps the route's `:id` to a project through the owning record (`project`, `connection`, `tool`, `testCase`, `build`, `version`, `artifact`, `deployment`). Not a member and no `projects.all` → **404** with the same message as a missing record; member without the permission → 403 `Requires permission <key>`.
- Lists are filtered to accessible projects: `projects`, `dashboard` (totals, projects, running builds, recent activity), `deployments`.
- Route map:

| Route | Requirement |
|---|---|
| `GET dashboard`, `GET projects`, `GET deployments` | signed in; filtered |
| `POST projects` | `projects.create` |
| `GET` any project-scoped read (project, context, conflicts, spec, diff, tools, connections, test-cases, builds, build, logs, qa, events (SSE), versions, deployment, deployment logs, project generation) | member |
| `PATCH projects/:id`, `POST projects/:id/archive`, `PUT/DELETE projects/:id/generation` | `project.edit` |
| `POST projects/:id/spec` | `spec.edit` |
| `PUT projects/:id/context` | `context.edit` |
| `PATCH tools/:id` | `tools.edit` |
| `POST projects/:id/connections`, `PATCH/DELETE connections/:id`, `POST connections/:id/test` | `connections.manage` |
| `POST projects/:id/test-cases`, `PATCH/DELETE test-cases/:id` | `testcases.manage` |
| `POST projects/:id/builds` | `builds.run` |
| `POST builds/:id/qa-run` | `qa.run` |
| `POST builds/:id/cancel` | `builds.run` for export builds, `qa.run` for QA runs |
| `POST versions/:id/release`, `/deprecate` | `versions.release` |
| `GET artifacts/:id/download` | `artifacts.download` |
| `POST builds/:id/deploy`, `POST deployments/:id/start`, `/stop`, `/rotate-token`, `DELETE deployments/:id` | `deploy.manage` |
| `GET/POST/PATCH/DELETE projects/:id/members…` | read: member; write: `members.manage` |
| `GET audit` | without `projectId`: `audit.read`; with `projectId`: member of that project |
| `GET settings`, `GET generation-profile`, `GET codex/models`, `GET codex/auth` | signed in |
| `PUT settings`, `PUT generation-profile` | `settings.manage` |
| `POST codex/models/check` | `settings.manage` or `project.edit` on any project |
| `POST/DELETE codex/auth/*` | `codex.manage` |
| `/users…` | `users.manage` (`GET users?search=` also allowed with `members.manage` on some project, returning only id, username, display name, for the add-member picker) |
| `/roles…` | read: signed in; write: `roles.manage` |
| `GET permissions` | signed in |

- Audit: every mutation logs the real username as `actor`; new actions `auth.login`, `auth.login_failed` (username only, no password), `auth.logout`, `user.create`, `user.update`, `user.reset_password`, `user.disable`, `user.enable`, `role.create`, `role.update`, `role.delete`, `member.add`, `member.update`, `member.remove`. Audit entries tied to a project carry `meta.projectId` so project-scoped queries work.
- Builds record who started them (existing `actor` parameter, stored and shown instead of `system`).

### 5.8 API contract additions (shared types)

- `MeDto { id, username, displayName, role: { id, name }, permissions: WorkspacePermission[], mustChangePassword }`.
- `ProjectDetail` gains `myPermissions: ProjectPermission[]` (effective, including `projects.all`).
- `UserDto { id, username, displayName, role: { id, name }, disabled, mustChangePassword, lastLoginAt, createdAt }`; `UserCreateResult { user, temporaryPassword: string | null }`.
- `RoleDto { id, name, scope, description, permissions, system, usage: number }`.
- `ProjectMemberDto { userId, username, displayName, role: { id, name }, createdAt }`.
- `PermissionInfo { key, scope, label, description }`.
- Permission keys as string-literal union types (types only, consistent with the shared package).

### 5.9 Web

- `/login`: username, password, error message, redirect to `?next=` (same-origin paths only). `/setup`: first admin form, shown only when `auth/setup-status` says so.
- The app shell loads `auth/me` once; on 401 from any call it redirects to `/login?next=<current path>`. When `mustChangePassword` is set it redirects to `/account` until the password is changed.
- Sidebar footer shows the real user (display name, workspace role) with **Account** (change password) and **Sign out**.
- API client: `credentials: 'include'`, header `X-MCPB-Request: 1` on non-GET; `EventSource(url, { withCredentials: true })`.
- **Settings** gains tabs **Users** and **Roles**, each shown only with its permission; the Audit tab only with `audit.read`. Codex sign-in controls are read-only without `codex.manage`.
- **Roles** tab: two matrices (project roles, workspace roles), permissions as columns grouped by area, checkboxes per role; system roles shown locked; create/rename/delete role with usage count.
- **Users** tab: table (username, display name, role, status, last sign-in); create user dialog showing the temporary password once with a copy button; edit, reset password, disable/enable.
- Project navigation gains **Members**.
- Buttons and pages for actions the user lacks are hidden when they would be noise (for example Export) or disabled with the tooltip `Requires permission <label>`; the API remains the authority.

### 5.10 Configuration

| Variable | Purpose |
|---|---|
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Optional first admin, created only when no user exists |
| `PUBLIC_URL` | Existing; https enables the `Secure` cookie flag |
| `WEB_ORIGIN` | Existing; CORS now with `credentials: true` |

`.env.example`, `docker-compose.yml` (pass the two admin variables to `api`), README (remove the "no user accounts" warnings, document sign-in, roles and recovery) and `docs/design.md` are updated.

## 6. Known limitations (decided: security hardening comes later)

Project isolation in this version holds against honest mistakes, not against a hostile member. Two gaps are known and deliberately out of scope; the README states them:

- **Secret references read the whole API environment.** `env://NAME` resolves against `process.env`, so a member with `connections.manage` (Owners have it) can point a connection at their own host with `env://DATABASE_URL` or `env://ADMIN_PASSWORD` and receive the value through *Test connection*, builds, QA or deployments.
- **Generated code and Codex run inside the API container.** Codex runs unsandboxed in Docker, and generated adapters run there during build, QA and deployments. Anyone who can shape Codex input (`spec.edit`, `context.edit`, `tools.edit`, `builds.run`) could, through prompt injection, read `/data` (all projects' workspaces and artifacts, the Codex sign-in) and the API's environment.

Until a separate runner exists, grant these permissions only to trusted people. Planned follow-up (separate project): scope secret references to a dedicated prefix and move Codex, build, QA and deployments to an isolated runner service.

## 7. Testing

- Unit: password hash/verify (and rejects tampered hashes), permission evaluation (member role, `projects.all`, non-member, scope validation), last-admin guard, login limiter.
- API integration against the dev database: 401 without a session, 404 for non-members on each project-scoped route family, 403 for a member lacking the permission, success with it; artifact download and SSE with cookie only; setup refused once a user exists; `mustChangePassword` lockout; session revoked after password reset/disable.
- Browser: sign in, forced password change, admin creates a user and a custom role, member sees only their projects, sign out.
- Docker: upgrade the existing stack; first admin from env; existing projects visible to the admin; `/mcp/docker-smoke` still answers with its bearer token.

## 8. Left to the builder

- Exact UI layout of the Users, Roles and Members pages within the existing design system.
- Module boundaries (`AuthModule`, `UsersModule`, `RolesModule`, member routes inside `ProjectsModule` or their own module).
- Migration details for seeding roles (SQL in the migration or an idempotent seed on start).
- Limiter implementation detail, as long as behaviour matches 5.4.
