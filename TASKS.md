# Roadmap: bot gần workflow coder trên laptop

Làm theo phase. Mỗi task độc lập, có thể merge riêng. Tick `- [ ]` khi xong.

---

## Session có mất khi mở workspace khác không?

**Không mất**, nếu chỉ *đổi* workspace / session.

| Hành động | Session cũ |
|-----------|------------|
| `/workspaces` hoặc `/repos` rồi chọn folder/repo mới | Giữ nguyên. Bot tạo session mới và đặt nó thành *current*. Session cũ vẫn trong `/sessions` |
| Gửi text sau khi đã có session Telegram | Tiếp tục session *current*, không tạo mới |
| `/sessions` rồi bấm session cũ | Nối lại đúng workspace + lịch sử chat |
| Restart `cursor-cp` / daemon / reboot máy (nếu daemon + SQLite còn) | Session còn. Agent được resume theo `sdkAgentId` |
| Mở project khác trong Cursor IDE trên laptop | **Không liên quan.** Session bot nằm ở SQLite của control plane (`~/cursor-cp`), không theo cửa sổ IDE |
| `/close` | **Mất** session current: xóa agent, xóa tin nhắn, xóa record |
| `/closeall` | **Mất hết** |

Giới hạn mặc định: `sdk.max_sessions: 5` (xem `cursor-cp/config.default.yaml`). Đủ 5 session thì tạo workspace mới sẽ lỗi — phải `/close` cái không dùng.

Telegram chỉ có **một current session / chat**. Đổi workspace = đổi con trỏ current, không xóa cái trước.

Muốn chắc: sau khi vào workspace B, gửi `/sessions` — phải thấy cả A lẫn B.

---

## Phase 0 — Nền (làm trước cho các phase sau)

- [x] **0.1** Thêm nhóm lệnh Telegram (help + autocomplete): `/progress`, `/stop`, `/diff`, `/files`, `/open`, `/undo`, `/status`, `/log`, `/branch`, `/commit`, `/push`, `/pr`, `/test`, `/lint`, `/dev`, `/preview`, `/ask`, `/agent`, `/plan`, `/rules`, `/machine`
- [x] **0.2** Helper chạy git/shell trong `repoPath` của session current; timeout; cắt log dài; gửi file `.txt` nếu vượt giới hạn Telegram
- [x] **0.3** Phân biệt 3 mode session: `ask` (chỉ đọc) / `agent` (được sửa) / `plan` (lên kế hoạch, chưa ghi file). Lưu trên session
- [x] **0.4** Sửa `/current`: hiện workspace path, mode, model, activity, file/lệnh gần nhất
- [x] **0.5** Khi tạo session từ `/workspaces` hoặc `/repos`, bot trả lời rõ: session cũ vẫn còn, vào lại bằng `/sessions`

---

## Phase 1 — Nhìn được việc (gap lớn nhất)

Hiện stream `thinking` / `tool_call` bị bỏ, Telegram chỉ nhận text cuối.

- [x] **1.1** Bắt event `tool_call` / `status` từ SDK; lưu “bước đang chạy” trên session (file, lệnh, tool)
- [x] **1.2** `/progress` — tóm tắt run hiện tại: tool, file, lệnh, đã chạy bao lâu
- [x] **1.3** Trong lúc agent chạy, Telegram cập nhật định kỳ (edit tin “⏳ …” hoặc tin ngắn), không chỉ đợi xong
- [x] **1.4** `/stop` — hủy run hiện tại; session về idle; không xóa session
- [x] **1.5** Báo “agent busy” kèm nút `/stop` thay vì chỉ bảo đóng session

**Xong Phase 1 khi:** gửi prompt dài, trên Telegram thấy agent đang đọc/sửa file nào, và `/stop` dừng được.

---

## Phase 2 — Review thay đổi như trong Cursor

- [x] **2.1** `/diff` — `git diff` workspace current; chia theo file; file dài gửi `.patch`
- [x] **2.2** `/files` — file agent vừa đụng trong run (từ tool events hoặc `git status`)
- [x] **2.3** `/open <path>` — gửi nội dung file (rút gọn / chia hunk / gửi document)
- [x] **2.4** `/search <query>` — tìm trong repo (`git grep`, fallback `rg`), trả file + dòng
- [x] **2.5** `/tree [path]` — cây thư mục nông (1–2 tầng)
- [x] **2.6** `/undo` — `git restore` các file dirty về HEAD; hỏi xác nhận
- [x] **2.7** Nút inline trên `/diff`: **Keep** / **Revert** theo từng file

**Xong Phase 2 khi:** sau một prompt sửa code, xem được diff, mở được file, revert được file không muốn giữ.

---

## Phase 3 — Git hàng ngày

`/repos` hiện chỉ clone. Coder sống ở status → diff → commit → PR.

- [x] **3.1** `/status` — `git status -sb` + ahead/behind
- [x] **3.2** `/log [n]` — log ngắn (mặc định 10)
- [x] **3.3** `/branch` — branch hiện tại + list; callback checkout
- [x] **3.4** `/commit [message]` — `git add` theo lựa chọn + commit; **luôn hỏi xác nhận**. Không có message thì agent hoặc `git status` gợi ý
- [x] **3.5** `/push` — push branch hiện tại; hỏi trước
- [x] **3.6** `/pr [title]` — `gh pr create`; hỏi trước; trả URL
- [x] **3.7** Chặn lệnh nguy hiểm cho đến khi bấm xác nhận: `push --force`, reset hard, xóa branch remote

**Xong Phase 3 khi:** từ Telegram xem status, commit, push, mở PR mà không cần viết “hãy commit giúp”.

---

## Phase 4 — Chạy và xác minh

- [x] **4.1** `/test` — `npm test` / script detect được; trả exit code + log rút gọn + file log đầy đủ
- [x] **4.2** `/lint` — tương tự typecheck/lint
- [x] **4.3** `/dev [script]` — start/stop dev server (pid theo session); `/dev stop`
- [x] **4.4** `/preview [port]` — Cloudflare tunnel tới app (không phải dashboard `:8747`); `/preview stop`
- [x] **4.5** `/shot [url]` — screenshot trang (Playwright hoặc tương đương), gửi ảnh Telegram
- [x] **4.6** `/logs` — stdout/stderr lệnh gần nhất

**Xong Phase 4 khi:** bảo bot sửa xong, tự chạy test, (nếu có UI) mở preview hoặc xem ảnh trang.

---

## Phase 5 — Gửi việc đa dạng

Hiện bot chỉ nhận text.

- [x] **5.1** Ảnh / screenshot → prompt kèm mô tả (caption = instruction)
- [x] **5.2** Document / file code upload → lưu vào workspace hoặc đưa nội dung cho agent
- [x] **5.3** Voice → transcribe → gửi như prompt; hiện text đã nhận
- [x] **5.4** Reply một tin cũ = follow-up đúng context tin đó
- [x] **5.5** Cú pháp `@path/to/file` trong prompt = đính nội dung file vào context
- [x] **5.6** Nạp `.cursorrules` / rules workspace vào session (hiện SDK `settingSources: []`)

**Xong Phase 5 khi:** gửi ảnh bug + “sửa cái này” là agent có context visual, không chỉ lời.

---

## Phase 6 — Mode và an toàn

- [x] **6.1** `/ask` `/agent` `/plan` đổi mode; prompt bị chặn ghi file khi `ask`/`plan`
- [x] **6.2** `plan` xong có nút **Apply** → chuyển `agent` và thực hiện plan
- [x] **6.3** Policy lệnh nguy hiểm: `rm -rf`, migrate, drop DB, `push --force` → inline Yes/No
- [x] **6.4** Timeout câu hỏi agent (hiện 1 giờ, fallback option đầu) — hiện rõ và cho `/stop`
- [x] **6.5** `/rules` xem/sửa tóm tắt rules đang áp dụng
- [x] **6.6** Bảo vệ `/ui`: token/password hoặc chỉ allowlist; nhắc `/ui stop` khi xong`

**Xong Phase 6 khi:** có thể “chỉ hỏi”, “lên plan”, hoặc “được sửa” — lệnh phá hủy phải qua xác nhận.

---

## Phase 7 — Máy nhà phải sống khi bạn ở ngoài

- [x] **7.1** `/machine` — daemon up/down, uptime, disk workspace, số session, tunnel đang mở
- [x] **7.2** Cảnh báo nếu máy sắp ngủ / daemon chết (heartbeat Telegram hoặc log)
- [x] **7.3** Tài liệu + script: caffeinate, không ngủ khi gập nắp (nếu user muốn), daemon login
- [x] **7.4** Tunnel dashboard URL ổn định hơn (named Cloudflare tunnel) thay vì random `trycloudflare.com` mỗi lần
- [x] **7.5** (Tuỳ chọn) Wake-on-LAN từ bot nếu máy ngủ được cấu hình WoL

**Xong Phase 7 khi:** ở trường/công ty gửi `/machine` biết máy nhà còn sống, và `/ui` ra link dùng được.

---

## Phase 8 — UX session (tránh mất việc vì hiểu nhầm)

Không phải mất data — dễ *lạc* current session.

- [x] **8.1** Mỗi reply agent gắn prefix ngắn: workspace + session id rút gọn
- [x] **8.2** `/sessions` hiện current, model, activity, số tin, tuổi
- [x] **8.3** Cảnh báo khi tạo workspace mới: “Session cũ vẫn còn. `/close` mới xóa.”
- [x] **8.4** Khi gần `max_sessions`, hỏi đóng session cũ trước khi tạo
- [x] **8.5** `/close` hỏi xác nhận (vì xóa lịch sử, không phải chỉ ngắt current)

**Xong Phase 8 khi:** đổi workspace không bao giờ khiến user tưởng session cũ biến mất.

---

## Thứ tự gợi ý

1. Phase 0 + **8.3 / 8.5** (hiểu session, khỏi mất việc vì `/close`)
2. Phase 1 (thấy và dừng được)
3. Phase 2 (review diff)
4. Phase 3 (git)
5. Phase 4 (test / preview)
6. Phase 5–7 khi đã dùng daily

---

## Ngoài scope (không nhắm thay laptop)

- Debugger từng dòng, nhảy definition như IDE
- Chỉnh UI pixel-perfect
- Multi-cursor / refactor thủ công
- Thay thế ngồi máy cho việc cần mắt và tay trên editor

Những việc đó: về laptop, hoặc `/ui` + Cursor/VS Code Remote / Tailscale / Screens.
