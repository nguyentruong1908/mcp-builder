# MCP Factory

Biến API hiện có (OpenAPI 3.0.x) thành bộ công cụ cho AI agents, gồm **MCP server** (stdio/HTTP) và **CLI**. Code được sinh bằng **Codex SDK**, kiểm thử bởi QA runner độc lập, đóng gói kèm checksum và provenance.

- Thiết kế kỹ thuật: [docs/design.md](docs/design.md)
- UI draft gốc: [ui-draft/index.html](ui-draft/index.html)
- Logo (do Codex CLI sinh): [brand/](brand/)

## Cấu trúc

| Thư mục | Nội dung |
|---|---|
| `apps/web` | Next.js 16 + Tailwind 4 (admin UI) |
| `apps/api` | NestJS 12 + Prisma 7 + PostgreSQL, worker build chạy trong tiến trình |
| `packages/shared` | Kiểu dữ liệu API dùng chung (types only) |
| `templates/mcp-node` | Runtime nền cho package đầu ra (MCP + CLI dùng chung `factory/tools.json`) |
| `examples/sample-erp` | API mẫu (OpenAPI + server in-memory) để thử end-to-end |

## Triển khai bằng Docker Compose

Stack gồm `postgres`, `api` (NestJS + worker build + Codex CLI), `web` (Next.js standalone) và `gateway` (Caddy: UI và `/api` chung một cổng, stream log SSE không buffer).

```bash
cp .env.example .env            # đổi POSTGRES_PASSWORD, CODEX_MODEL…
```

```bash
cp secrets.env.example secrets.env   # secret cho connection dạng env://NAME (tùy chọn)
```

```bash
docker compose up -d --build
```

Mở `http://localhost:8080`, vào **Settings › Codex** và chọn một trong ba cách đăng nhập:

| Cách | Khi nào dùng |
|---|---|
| **ChatGPT (device code)** | Khuyên dùng. Server chạy `codex login --device-auth`, bạn nhập mã một lần trên trình duyệt bất kỳ |
| **API key** | Dùng key OpenAI riêng cho Factory (`codex login --with-api-key`) |
| **Upload auth.json** | Có sẵn `~/.codex/auth.json` từ `codex login` ở máy khác. Nếu file đó vẫn được dùng ở máy kia, làm mới token ở một bên có thể đăng xuất bên còn lại |

Thông tin đăng nhập nằm trong volume `factory-data` (`/data/codex-home/auth.json`, quyền 600), không vào database và API không bao giờ trả lại token. Có thể dùng `CODEX_API_KEY` trong `.env` thay cho đăng nhập qua UI.

Thử với API mẫu: `docker compose --profile demo up -d`, import spec `http://sample-erp:4010/openapi.yaml`, tạo connection base URL `http://sample-erp:4010`, bearer, secret `env://SAMPLE_ERP_TOKEN`.

**Lưu ý khi đưa lên server:**
- Bản này **chưa có đăng nhập người dùng**. Ai truy cập được cổng đều quản lý được tài khoản Codex và build. Mặc định gateway chỉ bind `127.0.0.1:8080`. Muốn mở ra ngoài, đặt sau reverse proxy có TLS và xác thực (VD: Caddy `basic_auth`, Cloudflare Access, VPN), rồi chỉnh `MCP_FACTORY_BIND`.
- Xem mục **Codex sandbox trong Docker** bên dưới trước khi chạy build đầu tiên.
- Sao lưu volume `pgdata` (dữ liệu) và `factory-data` (artifact và đăng nhập Codex).
- Cập nhật: `git pull && docker compose up -d --build`. Migration chạy tự động khi API khởi động.

### Codex sandbox trong Docker

Codex chạy lệnh của nó trong sandbox bubblewrap: không có mạng, chỉ ghi được vào workspace của build. Bubblewrap cần user namespace, mà profile seccomp/AppArmor mặc định của Docker chặn. Vì vậy compose **mặc định đặt `CODEX_SANDBOX=danger-full-access`**: Codex không tự sandbox, container `api` là ranh giới cô lập. Nếu muốn bật lại sandbox của Codex (`CODEX_SANDBOX=workspace-write`), Settings › Codex sẽ báo lỗi cho đến khi chọn cách 1 hoặc 3:

| Cách | Cấu hình | Đánh đổi |
|---|---|---|
| Nới profile cho service `api` | thêm `security_opt: [seccomp=unconfined, apparmor=unconfined]` vào `api` trong `docker-compose.yml` | Sandbox của Codex hoạt động (không mạng, chỉ ghi workspace), nhưng container `api` mất lớp lọc syscall mặc định của Docker |
| Tắt sandbox của Codex (**mặc định**) | `CODEX_SANDBOX=danger-full-access` | Container là ranh giới duy nhất. Codex có mạng và đọc được `/data` (gồm `auth.json`); spec độc hại có thể tìm cách lộ thông tin đăng nhập |
| Seccomp profile riêng | profile mặc định của Docker cộng quyền `unshare`/`clone` với `CLONE_NEWUSER` | An toàn nhất nhưng cần tự bảo trì profile |

Đã kiểm chứng trên Docker Desktop: với cách thứ nhất, lệnh trong sandbox Codex không ghi được ra ngoài thư mục cho phép và không gọi được mạng nội bộ của compose.

## Chạy local (dev)

Yêu cầu: Node 20+ (đã thử với 24), pnpm 9, PostgreSQL 16. Codex CLI đi kèm SDK; đăng nhập trong **Settings › Codex** (lưu ở `data/codex-home`, tách khỏi `~/.codex` của máy).

```bash
pnpm install
```

```bash
cp apps/api/.env.example apps/api/.env   # sửa DATABASE_URL, CODEX_MODEL nếu cần
```

```bash
pnpm db:up          # hoặc dùng PostgreSQL có sẵn, tạo DB mcp_factory
```

```bash
pnpm db:migrate
```

```bash
pnpm --filter api build && pnpm --filter api start   # API :4000
```

```bash
pnpm --filter web dev                                # Web :3000
```

```bash
node examples/sample-erp/server.mjs                  # API mẫu :4010 (token: dev-token)
```

Thử nhanh: tạo project → *API & Context* → import `http://localhost:4010/openapi.yaml` → *Connections* thêm môi trường `test`, base URL `http://localhost:4010`, bearer, secret `env://SAMPLE_ERP_TOKEN`, bật "Dùng cho QA" → **Export**.

## QA độc lập và test case

- **Chạy QA** (trang QA hoặc trang build): chạy lại toàn bộ QA trên code của một build có sẵn, bỏ qua bước Codex generation. Kết quả là một run riêng `kind: qa`, gắn nhãn "trên code của b-000X", có log live và QA report như build thường.
- **Test case** (trang QA › Test case), dùng cho cả Export lẫn QA run:
  - *Gọi tool*: tool + tham số JSON, chạy trên mock (có thể giả lập response, VD 409) hoặc API thật qua connection QA. Kỳ vọng: có lỗi hay không, loại lỗi (`conflict`, `not_found`…), chuỗi phải xuất hiện. Test fail sẽ chặn Package verified.
  - *Tác vụ agent*: Codex dùng MCP tool vừa build để làm tác vụ. Chấm theo lệnh gọi tool thực tế, tool mong đợi và chuỗi phải có trong câu trả lời.
- **Agent task evaluation** còn lấy tác vụ mẫu trong Context (mỗi dòng một tác vụ, thêm `=> tên_tool` để chấm việc chọn tool). Tối đa 5 tác vụ mỗi lần chạy (`AGENT_EVAL_MAX_TASKS`). Trên API thật agent chỉ thấy tool đọc, trừ khi môi trường cho phép ghi.

## Tùy biến chất lượng sinh code

- **Generation profile** (Settings › Generation profile; project ghi đè ở trang Overview):
  - *Model* và *reasoning effort*: project ghi đè workspace, workspace ghi đè `CODEX_MODEL`. Nút "Kiểm tra model" chạy một lượt Codex nhỏ để xác nhận tài khoản dùng được model đó.
  - *Quy tắc*: markdown của workspace, rồi quy tắc riêng của project nối sau. Được ghi thành `AGENTS.md` trong workspace build; Codex tự đọc file này, nó không được đóng vào package. Quy tắc chỉ tinh chỉnh cách viết, không nới được các ràng buộc cố định (vùng file được sửa, secret, dependency), vì những ràng buộc này do code của Factory cưỡng chế.
  - Mỗi lần lưu tăng version. Build ghi `model`, `reasoningEffort`, `generationProfile` (VD `workspace@v3+project@v1`) và `rulesSha256` vào provenance.
- **Vòng tự sửa theo QA** (Settings › Ngân sách, mặc định 2 vòng, 0 = tắt): sau QA, các lỗi sửa được bằng code adapter (contract, xử lý lỗi, runtime, test case, integration, agent chọn sai tool) được gửi lại cho cùng thread Codex. Sau đó build lại và chạy lại toàn bộ QA. Lỗi hạ tầng hoặc lỗi định nghĩa tool không được gửi. Vòng nào không giảm được lỗi thì dừng.
- **Agent eval** chạy với sandbox theo `CODEX_SANDBOX` (Docker: full access) và tự duyệt mọi lệnh gọi tool trong danh sách Factory cho phép. Tool ghi chỉ được bật khi môi trường QA cho phép ghi, nên agent có thể thay đổi dữ liệu thật trên môi trường đó. Agent dùng shell thay vì tool vẫn bị tính là fail.

## Lưu ý vận hành

- **Codex luôn chạy thật** (không có mock). Mỗi build tốn token theo tài khoản Codex của máy chủ; ngân sách và trần chi phí cấu hình ở *Settings*.
- `CODEX_MODEL` phải là model tài khoản của bạn được dùng (với tài khoản ChatGPT trên máy này: `gpt-6-sol`).
- Secret của môi trường chỉ lưu dạng tham chiếu `env://TEN_BIEN`; giá trị đặt trong env của API (`apps/api/.env`).
- Build cần mạng để `npm install` dependency của package đầu ra. Bản thân Codex chạy trong sandbox `workspace-write`, không có mạng.
- Workspace và artifact nằm ở `data/` (ngoài DB, đã gitignore).

## Test

```bash
pnpm --filter api build && pnpm --filter api test
```
