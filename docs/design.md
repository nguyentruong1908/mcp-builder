# MCP Factory: Thiết kế kỹ thuật v0.1

Tài liệu này mô tả cách triển khai MVP theo product plan v0.1 và bản UI draft (`ui-draft/index.html`).

## 1. Quyết định đã chốt

| Hạng mục | Lựa chọn |
|---|---|
| Frontend | Next.js 16 (App Router) + React 19 + Tailwind CSS 4, design token theo shadcn/ui, icon `lucide-react` |
| Backend | NestJS + Prisma + PostgreSQL 16 |
| Sinh code | `@openai/codex-sdk` chạy thật (không có mock), model đặt qua `CODEX_MODEL` |
| Job queue | Bảng `Build` trong Postgres + worker trong tiến trình API, lấy job bằng `FOR UPDATE SKIP LOCKED` (không thêm Redis) |
| Auth | Chưa có. Mọi thao tác ghi actor là `system` (hoặc header `x-actor` nếu có) |
| Runtime đầu ra | Node.js 20+ / npm. Một template nền: MCP server (stdio) + CLI dùng chung `tools.json` |
| Monorepo | pnpm workspace: `apps/web`, `apps/api`, `packages/shared`, `templates/mcp-node` |

## 2. Kiến trúc

```
apps/web (Next.js :3000) ──REST/SSE──▶ apps/api (NestJS :4000) ──▶ PostgreSQL
                                          │
                                          ├─ SpecModule      parse/validate OpenAPI, snapshot, diff
                                          ├─ ToolsModule     tool definition (dùng chung MCP/CLI)
                                          ├─ BuildWorker     pipeline nền theo từng build
                                          │    1. spec      chuẩn hóa đầu vào, chặn khi lỗi
                                          │    2. codex     copy template → Codex SDK viết adapter/docs
                                          │    3. build     npm install, tsc, secret scan (tự sửa ≤ N vòng)
                                          │    4. qa        QA runner độc lập với code Codex sinh
                                          │    5. package   npm pack, checksum, provenance, QA report
                                          └─ data/        workspaces + artifacts (ngoài DB)
```

**Nguyên tắc từ plan được giữ trong code:**
- Codex chỉ viết code trong workspace của build (`sandboxMode: workspace-write`, không có network). Swagger/context được đưa vào dưới dạng file dữ liệu, không ghép vào phần chỉ dẫn hệ thống.
- QA runner nằm trong `apps/api`, do Factory viết, không dùng test của Codex để kết luận.
- Thiếu môi trường hoặc credential thì kết quả là `not_run`/`blocked` kèm lý do, không bao giờ ghi thành `pass`.
- Credential chỉ lưu dưới dạng tham chiếu (`env://VAR_NAME`), giá trị đọc từ biến môi trường của API lúc chạy QA, không ghi vào artifact hay log (log được che bằng `redact()`).
- Fetch Swagger qua URL bị giới hạn bởi `SPEC_FETCH_ALLOWLIST`; `$ref` ngoài file bị chặn (chỉ resolve nội bộ).

## 3. Mô hình dữ liệu (Prisma)

- `Project`: tên, slug, mô tả, owner, đầu ra (`outputs`), `archivedAt`.
- `SpecSnapshot`: raw spec, sha256, OAS version, API version, danh sách operation, issues. Mỗi lần import tạo snapshot mới.
- `ProjectContext` (1–1 với project): các trường context có cấu trúc + glossary (JSON).
- `ToolDefinition`: mỗi operation của spec hiện tại là một dòng; `selected`, `name`, `description`, `impact` (read/write/side_effect/destructive), `requireConfirm`, `inputSchema`, `unsupportedReason`.
- `Connection`: môi trường (dev/test/prod), base URL, kiểu auth, `secretRef`, `allowWrite`, `useForQa`.
- `Version`: số semver, trạng thái (draft/released/deprecated), snapshot của spec/context/tools tại thời điểm export, changelog.
- `Build`: seq (hiển thị `b-0001`), trạng thái, trạng thái từng stage, token usage, chi phí ước tính, số vòng tự sửa, nhãn Package/Integration verified, provenance, `cancelRequested`.
- `BuildLog`, `QaResult` (layer × tool × status + evidence), `Artifact` (file, sha256, size), `AuditLog`, `Setting` (ngân sách, giới hạn).

## 4. API (prefix `/api`)

Kiểu dữ liệu trả về khai báo trong `packages/shared/src/index.ts`.

| Method | Path | Mô tả |
|---|---|---|
| GET | `/dashboard` | Số liệu tổng, danh sách project, build đang chạy, hoạt động gần đây |
| GET / POST | `/projects` | Danh sách / tạo project |
| GET / PATCH | `/projects/:id` | Chi tiết (kèm tiến trình 9 bước) / cập nhật |
| POST | `/projects/:id/archive` | Archive (không xóa) |
| POST | `/projects/:id/spec` | Import spec: `{ url }` hoặc `{ content, filename }` |
| GET | `/projects/:id/spec` | Snapshot hiện tại + lịch sử |
| GET | `/projects/:id/spec/diff?from=&to=` | Diff giữa hai snapshot + tool bị ảnh hưởng |
| GET / PUT | `/projects/:id/context` | Context có cấu trúc + glossary |
| GET | `/projects/:id/conflicts` | Mâu thuẫn phát hiện được giữa context và spec |
| GET | `/projects/:id/tools` | Tool definitions |
| PATCH | `/tools/:id` | Sửa tên, mô tả, impact, requireConfirm, selected |
| GET / POST | `/projects/:id/connections` | Môi trường |
| PATCH / DELETE | `/connections/:id` | Sửa / xóa môi trường |
| POST | `/connections/:id/test` | Kiểm tra kết nối (GET base URL) |
| GET | `/projects/:id/versions` | Danh sách version |
| POST | `/versions/:id/release` | Release (chỉ khi build mới nhất đạt Package verified) |
| POST | `/versions/:id/deprecate` | Deprecate |
| POST | `/projects/:id/builds` | **Export**: chốt snapshot vào version nháp và xếp hàng build |
| GET | `/projects/:id/builds` | Lịch sử build |
| GET | `/builds/:id` | Chi tiết build + artifacts |
| GET | `/builds/:id/logs?after=` | Log (đã che secret) |
| GET | `/builds/:id/events` | SSE: log + thay đổi trạng thái |
| POST | `/builds/:id/cancel` | Hủy |
| GET | `/builds/:id/qa` | QA report: tổng hợp theo lớp, ma trận coverage, danh sách lỗi |
| POST | `/builds/:id/qa-run` | QA run độc lập trên code của build đó (bỏ qua Codex), trả về build `kind: qa` |
| GET / PUT | `/generation-profile` | Generation profile cấp workspace (model, reasoning, rules → AGENTS.md) |
| GET / PUT / DELETE | `/projects/:id/generation` | Ghi đè profile cho project (DELETE = dùng lại profile workspace) |
| GET | `/codex/models` | Model + mức reasoning từ cache của Codex |
| POST | `/codex/models/check` | Kiểm tra tài khoản Codex dùng được model `{ model }` |
| GET / POST | `/projects/:id/test-cases` | Test case tùy chỉnh (gọi tool hoặc tác vụ agent) |
| PATCH / DELETE | `/test-cases/:id` | Sửa / xóa test case |
| GET | `/artifacts/:id/download` | Tải artifact |
| GET | `/audit` | Audit log |
| GET / PUT | `/settings` | Ngân sách và giới hạn |

## 5. Pipeline build

| Stage | Việc làm | Fail khi |
|---|---|---|
| spec | Đọc snapshot của version, kiểm tra có ≥ 1 tool được chọn, không chọn operation không hỗ trợ | Không có tool, spec lỗi |
| codex | Copy `templates/mcp-node` vào `data/builds/<id>/workspace`, ghi `factory/tools.json`, `factory/context.md`, `factory/openapi.json`; mở thread Codex viết `src/adapters/<tool>.ts` + `README.md` | Codex lỗi, vượt ngân sách token |
| build | `npm install`, `npm run build` (tsc), secret scan. Lỗi thì gửi log lỗi lại cho cùng thread Codex, tối đa `maxRepairRounds` | Hết vòng sửa |
| qa | Xem bảng dưới | Không fail stage; kết quả quyết định nhãn |
| package | `npm pack`, sha256, `provenance.json`, `qa-report.json` | Lỗi đóng gói |

**QA runner:**

| Lớp | Cách chạy | Ghi chú |
|---|---|---|
| input | Kiểm tra lại schema của tool, operation không hỗ trợ | |
| build | Kết quả tsc + secret scan | |
| interface | Khởi động MCP server (stdio) bằng MCP SDK client, `tools/list` khớp danh sách tool đã chọn và schema; CLI `--help` exit 0, lệnh sai exit ≠ 0 | |
| contract | Mock server do Factory dựng từ spec, gọi từng tool với tham số mẫu sinh từ schema, kiểm tra method/path/query/body | |
| error | Mock trả 401/404/429/500: tool phải trả `isError` có thông điệp, server không chết | |
| runtime | Phân trang, retry, idempotency | `not_run` ở MVP, có lý do |
| integration | Gọi API thật qua connection `useForQa` với tool `read`; tool ghi chỉ chạy khi `allowWrite` | Không có connection/secret → `not_run`/`blocked` |
| agent | Đánh giá agent với tác vụ mẫu | `not_run` ở MVP, có lý do |
| install | Cài tgz vào thư mục sạch, chạy `--help` | |

**Nhãn:** `packageVerified` = mọi kết quả của input, build, interface, contract, error, install đều `pass`. `integrationVerified` = `yes` nếu mọi tool đã chọn đều pass integration, `partial` nếu có pass và có blocked/not_run, `no` nếu có fail, `not_run` nếu không chạy.

## 6. Phiên bản

- Export lấy trạng thái hiện tại (snapshot spec mới nhất, context, tool) ghi vào version **draft** mới nhất; nếu chưa có draft thì tạo draft mới với số minor kế tiếp.
- Release chỉ được khi build mới nhất của version đạt Package verified. Version đã release không bị sửa.
- Không thể thu hồi package đã tải; deprecate chỉ đánh dấu.

## 7. Chạy local

Xem `README.md` ở thư mục gốc.
