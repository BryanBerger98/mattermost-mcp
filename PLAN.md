# mattermost-mcp — Implementation Plan

Phased plan with tasks. Every endpoint below was verified against the official
Mattermost OpenAPI v4 sources and OAuth2 docs (see Appendix A). Nothing is assumed.

Decisions locked: auth = **PAT + password + OAuth2** (all in v1) · HTTP client =
**official `@mattermost/client` Client4 (v11.6.0)** · write posture = **guardrails**.

Companion doc: `SCOPE.md` (frozen scope, tool catalog).

---

## Conventions

- Runtime: Node.js 20 LTS, ESM (`"type": "module"`), TypeScript (NodeNext).
- MCP: `@modelcontextprotocol/sdk` v1.29.x, **stdio** transport.
- Validation: `zod` for every tool input schema.
- All logs go to **stderr** (stdout is the MCP stdio channel — never log there).
- Each task lists an acceptance criterion. A phase is done when all its criteria pass.
- Endpoints quoted as `METHOD /path` are relative to `{MM_URL}/api/v4` unless noted
  with a leading `{MM_URL}` (OAuth2 web routes live outside `/api/v4`).

---

## Phase 0 — Bootstrap & tooling

- [x] `git init` (directory is not yet a repo).
- [x] `package.json`: name `mattermost-mcp`, `"type": "module"`, `bin` entry, scripts (`build`, `dev`, `lint`, `test`).
- [x] `tsconfig.json`: target ES2022, module/moduleResolution NodeNext, strict, outDir `dist`.
- [x] Dev tooling: ESLint + Prettier + `vitest`.
- [x] Install deps: `@modelcontextprotocol/sdk@^1.29`, `@mattermost/client@^11.6`, `zod`.
- [x] `.gitignore`, `.env.example` (all `MM_*` vars), `README` stub.
- [x] `src/index.ts`: minimal MCP server that boots over stdio and lists 0 tools.

**Acceptance:** `npm run build` succeeds; server starts over stdio and responds to an MCP `initialize`/`tools/list` handshake (empty list).

---

## Phase 1 — Config & auth (PAT + password)

- [x] `src/config.ts`: parse + zod-validate env. Required `MM_URL`. `MM_AUTH_MODE = pat | password | oauth2`. Guardrail vars (Phase 3). Fail fast with a clear message on invalid config.
- [x] `src/mattermost/client.ts`: instantiate `Client4`, `setUrl(MM_URL)`. Set a `User-Agent` header. Neutralize webapp browser behavior (CSRF token is cookie/`document`-based — irrelevant headless; ensure no reliance on cookies, Bearer header only).
- [x] **PAT mode**: `client.setToken(MM_TOKEN)` → Bearer header (`getOptions()` confirmed adds `Authorization: Bearer <token>`).
- [x] **Password mode**: `POST /users/login` with `{ login_id, password, token? (MFA) }`. Session token is returned in the **`Token` response header** — capture it, `setToken(...)`. Implement auto re-login on `401`.
- [x] Smoke: `GET /users/me` succeeds in both modes.

**Acceptance:** With `MM_AUTH_MODE=pat` and with `=password`, the client authenticates and `GET /users/me` returns the current user.

**Verified endpoints:** `POST /users/login` (`login_id`, `password` required; `token`=MFA; `device_id` optional) · `GET /users/me`.

---

## Phase 2 — OAuth2 auth (authorization-code + PKCE + refresh)

> Heavier flow; isolated in its own phase. Assumes an OAuth app is registered
> (admin via _System Console > Integrations > OAuth 2.0 Applications_, or
> `POST /api/v4/oauth/apps`). Redirect URIs must start with `http://`/`https://`.

- [x] Config: `MM_CLIENT_ID`, `MM_CLIENT_SECRET` (confidential client), `MM_OAUTH_REDIRECT` (loopback, e.g. `http://127.0.0.1:<port>/callback`).
- [x] Local callback HTTP server on loopback to receive the authorization `code`.
- [x] Build authorize URL: `GET {MM_URL}/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&state=…` (+ PKCE `code_challenge`/`code_challenge_method=S256` — required for public clients, safe to include for confidential).
- [x] Print/open the authorize URL for user consent; validate returned `state`.
- [x] Token exchange: `POST {MM_URL}/oauth/access_token` (`client_secret_post`): `grant_type=authorization_code`, `code`, `client_id`, `client_secret`, `redirect_uri` (+ `code_verifier` if PKCE). Response: `access_token`, `refresh_token` (confidential), `token_type`, `expires_in`.
- [x] `client.setToken(access_token)`.
- [x] Refresh: on expiry, `POST {MM_URL}/oauth/access_token` with `grant_type=refresh_token`, `client_id`, `client_secret`, `refresh_token`.
- [x] Token persistence between runs (cache file in OS config dir; access + refresh + expiry).

**Acceptance:** `MM_AUTH_MODE=oauth2` completes consent once, `GET /users/me` works, and an expired access token is transparently refreshed.

**Implementation:** `src/mattermost/oauth.ts` (PKCE S256, loopback catcher with state-CSRF check + 300s timeout, form-encoded token exchange, 0600 token cache keyed by sha256(url|clientId) under `$XDG_CONFIG_HOME/mattermost-mcp`); wired into `src/mattermost/client.ts` (`acquireOAuthToken` at boot, `refreshOAuthToken` on 401). Verified e2e against a mock: full consent+PKCE, cache-first reuse, refresh-on-expiry.

**Verified facts:** authorize `= {MM_URL}/oauth/authorize`, token `= {MM_URL}/oauth/access_token` (web routes, NOT under `/api/v4`). Grant flows: authorization_code + implicit. Confidential clients get refresh tokens; public clients use PKCE, no refresh. No granular scopes — token inherits the authorizing user's access level.

---

## Phase 3 — Guardrails layer

- [x] `src/guardrails.ts`: pure checks evaluated before any write reaches the API.
  - `MM_READ_ONLY=true` → disable all write tools (not even registered, or hard-refuse).
  - `MM_ALLOW_DESTRUCTIVE` (default false) gates 💥 tools; require `confirm:true` arg **and** flag true.
  - `MM_TEAM_ALLOWLIST` / `MM_CHANNEL_ALLOWLIST` (CSV) → refuse actions on out-of-list resources (resolve channel→team as needed).
  - `MM_MAX_MESSAGE_LEN` (default 16383) → reject over-long messages pre-send.
- [x] Surface Mattermost API errors verbatim (status_code + message), no swallowing.
- [x] Unit tests for every guardrail branch.

**Acceptance:** unit tests cover read-only, destructive gate (with/without confirm + flag), allowlist in/out, and length limit.

**Implementation:** `src/guardrails.ts` — pure, network-free predicates throwing `GuardrailError`: `assertNotReadOnly`, `assertDestructiveAllowed` (env flag AND `confirm:true`), `assertWriteAllowed` (read-only precedes destructive), `assertTeamAllowed` / `assertChannelAllowed` (empty list = unrestricted), `assertMessageWithinLimit` (counts Unicode code points to match server rune count). `src/mattermost/errors.ts` — `formatMattermostError` (verbatim status + message + `server_error_id`/`detailed_error`) and `isMattermostError`. 30 unit tests (22 guardrails + 8 errors). Channel→team resolution deferred to the Phase 4 framework (needs the session); guardrails stay pure.

> Open decision resolved: `MM_READ_ONLY` **hard-refuses** at call time (still listed in `tools/list`) rather than hiding tools — simpler, and the refusal message is explicit.

---

## Phase 4 — Tool framework & registry

- [x] `src/tools/registry.ts`: tool definition shape `{ name, title, description, inputSchema (zod), write?: bool, destructive?: bool, handler }` (+ optional `resources`/`messageText` for allowlist & length checks).
- [x] Register tools with the MCP server. Map zod → MCP `inputSchema`.
- [x] Central handler wrapper: run guardrail checks → call Client4 → format output → catch & format errors uniformly.
- [x] Demo tool `get_me` wired end-to-end through the framework.

**Acceptance:** `tools/list` shows `get_me`; `tools/call get_me` returns the current user; a guarded write tool stub is correctly blocked under `MM_READ_ONLY`.

**Implementation:** `src/tools/registry.ts` — `ToolDef` shape, `defineTool` (typed authoring, erased to `AnyToolDef`), `toMcpTool`/`buildToolList` (zod → JSON Schema via `zod-to-json-schema`, `$schema` stripped, write/destructive → `annotations.readOnlyHint`/`destructiveHint`), `dispatchToolCall` (validate → `assertWriteAllowed` → length/allowlist → handler via `session.call` → format; guardrail refusals and API errors both returned as `isError:true` text, API errors verbatim), `registerTools` (wires `tools/list` + `tools/call` on the low-level `Server`). `src/tools/users.ts` (`get_me`), `src/tools/index.ts` (`allTools`); `index.ts` now serves the registry. Verified: 15 unit tests (every wrapper branch) + 3 in-process MCP e2e (real `Client`↔`Server` via `InMemoryTransport`).

> Note: we map zod→JSON Schema by hand (low-level `Server`, not `McpServer.registerTool`) — added `zod-to-json-schema` as a direct dependency.

---

## Phase 5 — Messaging tools (Tier 1)

Each tool: zod schema · Client4 call · guardrail wiring (⚠️/💥) · unit test.

- [x] `post_message` ⚠️ — `POST /posts` (`channel_id`, `message` req; `root_id`, `file_ids`, `props` opt).
- [x] `reply_thread` ⚠️ — `POST /posts` with `root_id`.
- [x] `get_channel_posts` — `GET /channels/{channel_id}/posts` (`page`, `per_page`, `since`, `before`, `after`).
- [x] `get_thread` — `GET /posts/{post_id}/thread`.
- [x] `get_post` — `GET /posts/{post_id}`.
- [x] `search_posts` — `POST /teams/{team_id}/posts/search` (`terms`, `is_or_search` req; `page`, `per_page` opt).
- [x] `edit_post` ⚠️ — `PUT /posts/{post_id}/patch` (send only `message`; patch endpoint avoids full-object replace).
- [x] `delete_post` 💥 — `DELETE /posts/{post_id}`.
- [x] `send_dm` ⚠️ — `POST /channels/direct` (JSON array of **exactly 2** user ids) or `POST /channels/group` (array of **3–8** ids) → then `post_message` to the returned channel.
- [x] `pin_post` / `unpin_post` ⚠️ — `POST /posts/{post_id}/pin` · `/unpin`.
- [x] `add_reaction` ⚠️ — `POST /reactions` (`user_id`, `post_id`, `emoji_name`).
- [x] `remove_reaction` ⚠️ — `DELETE /users/{user_id}/posts/{post_id}/reactions/{emoji_name}`.

**Acceptance:** post → read back → reply → react → edit → delete round-trips against a live test instance.

**Implementation:** `src/tools/messaging.ts` (13 tools, `export const messagingTools`). Each is a `defineTool` over a verified `Client4` method: `createPost` (post/reply/send_dm), `getPosts`/`getPostsSince`/`getPostsBefore`/`getPostsAfter` (cursor-selected in `get_channel_posts`), `getPostThread`, `getPost`, `searchPosts`, `patchPost` (edit, `{id, message}` — not full replace), `deletePost`, `pinPost`/`unpinPost`, `addReaction`/`removeReaction` (use `session.userId` for the actor), `createDirectChannel`/`createGroupChannel` then `createPost` (send_dm: members = `[session.userId, ...user_ids]`, 2 → direct, 3–8 → group). Writes flagged `write`; `delete_post` `destructive`; message-bearing tools wire `messageText` for length; `channel_id`/`team_id` wired via `resources` for allowlists. 11 unit tests via `dispatchToolCall` (happy paths + destructive gate + length + channel allowlist). Live round-trip deferred to the Phase 9 integration harness.

---

## Phase 6 — Channels & Teams tools

- [x] `list_teams` — `GET /users/me/teams`.
- [x] `list_channels` — `GET /users/{user_id}/teams/{team_id}/channels` (use `me`).
- [x] `get_channel` — `GET /channels/{channel_id}`.
- [x] `create_channel` ⚠️ — `POST /channels` (`name`, `display_name`, `type`, `team_id` req).
- [x] `join_channel` ⚠️ — `POST /channels/{channel_id}/members` (`user_id` or `user_ids[]`).
- [x] `leave_channel` ⚠️ — `DELETE /channels/{channel_id}/members/{user_id}`.
- [x] `archive_channel` 💥 — `DELETE /channels/{channel_id}`.
- [x] `list_channel_members` — `GET /channels/{channel_id}/members` (`page`, `per_page`).
- [x] `add_member` ⚠️ / `remove_member` 💥 — `POST /channels/{channel_id}/members` · `DELETE /channels/{channel_id}/members/{user_id}`.
- [x] `get_unreads` — per channel `GET /users/{user_id}/channels/{channel_id}/unread`; team aggregate `GET /users/{user_id}/teams/{team_id}/channels/members`.
- [x] `mark_channel_read` ⚠️ — `POST /channels/members/{user_id}/view` (`channel_id` req; `prev_channel_id` opt; `user_id`=`me`).

**Acceptance:** list teams → list channels → join → post → mark read → leave works end-to-end.

**Implementation:** `src/tools/channels.ts` (12 tools, `export const channelTools`). `Client4` methods: `getMyTeams`, `getMyChannels(team_id)`, `getChannel`, `createChannel({name, display_name, type∈'O'|'P', team_id})`, `addToChannel`/`removeFromChannel` (self for join/leave via `session.userId`; other user for add/remove_member), `deleteChannel` (archive), `getChannelMembers`, `viewMyChannel` (mark read). `get_unreads` uses `getMyChannelMembers(team_id)` (the team-aggregate variant — Client4 has no per-channel unread getter) mapped to `{channel_id, msg_count, mention_count}`. `archive_channel`/`remove_member` `destructive`; others `write`; `channel_id`/`team_id` via `resources`. 11 unit tests (read paths, destructive double-lock, read-only block, team allowlist, invalid `type`, unread mapping).

---

## Phase 7 — Users & presence tools

- [x] `get_me` — `GET /users/me` (already built in Phase 4; finalize).
- [x] `get_user` — `GET /users/{user_id}` and `GET /users/username/{username}`.
- [x] `search_users` — `POST /users/search` (`term` req).
- [x] `get_user_status` — `GET /users/{user_id}/status`.
- [x] `set_status` ⚠️ — `PUT /users/{user_id}/status` (`status` ∈ online/away/offline/dnd).
- [x] `set_custom_status` ⚠️ — `PUT /users/{user_id}/status/custom` (`emoji`, `text`).

**Acceptance:** lookup by id and username, search, read + set status round-trip.

**Implementation:** `src/tools/users.ts` extended (`export const userTools = [getMe, ...]`; `get_me` unchanged). `get_user` takes exactly one of `user_id`/`username` (zod `.refine`) → `getUser` | `getUserByUsername`. `search_users` → `searchUsers(term, {})`. `get_user_status` → `getStatus`. `set_status` → `updateStatus({user_id: session.userId, status})` (`status` enum). `set_custom_status` → `updateCustomStatus({emoji, text, duration: duration ?? ""} as Parameters<typeof c.updateCustomStatus>[0])` — the param-type cast avoids importing the CJS `CustomStatusDuration` enum as a value. Status setters `write`. 10 unit tests (id vs username dispatch, one-of refine, invalid status enum, read-only block, self user_id).

---

## Phase 8 — Files tools

- [x] `upload_file` ⚠️ — `POST /files` (multipart: `files` + `channel_id`) → response `{ file_infos[], client_ids[] }`; return the `file_info.id`(s).
- [x] Attachment path: feed returned `file_ids` into `post_message`.
- [x] `get_file` — `GET /files/{file_id}` (binary; decide MCP return: base64 inline vs saved path — default base64 for small, size-cap configurable).
- [x] `get_file_metadata` — `GET /files/{file_id}/info`; also expose `/thumbnail`, `/preview`, `/link`.

**Acceptance:** upload a file → attach to a post → fetch metadata → download round-trips.

**Implementation:** `src/tools/files.ts` (3 tools, `export const fileTools`). `upload_file` ⚠️ decodes `content_base64` → `Buffer` → Node-global `FormData`/`Blob`, `c.uploadFile(fd)`, returns mapped `{id, name, size, mime_type}` (feed `id` into `post_message.file_ids`). `Client4` has no byte-download / `/info` method, so `get_file` and `get_file_metadata` use raw `fetch` against `c.getFileRoute(file_id)` (+`/info`) with `Authorization: Bearer ${c.getToken()}` — the SCOPE-sanctioned fallback; non-`ok` responses throw a verbatim `Mattermost API error {status}: {body}`. `get_file` returns base64 inline with a configurable `max_bytes` cap (default 8 MiB; over-cap throws and asks to raise it) — resolves the PLAN open decision (base64 + size cap). 8 unit tests (`vi.stubGlobal('fetch')`; happy paths, read-only block, channel allowlist, size cap, non-ok surfacing). Note: raw-fetch tools bypass the `session.call` 401 auto-recovery (they still read the current token), an accepted minor gap.

---

## Phase 9 — Hardening, docs, release

- [x] Integration test harness against a disposable Mattermost (`mattermost-preview` Docker image).
- [x] Resilience: retry/backoff on `429`/5xx, timeouts, clear auth-failure messages.
- [x] `README`: env table, full tool catalog, per-auth-mode setup, guardrail matrix.
- [x] MCP client config examples (`claude_desktop_config.json` / `.mcp.json`).
- [x] `bin` shebang + packaging; semver `0.1.0`; ~~optional `npm publish`~~ (deferred — not an in-repo step).

**Acceptance:** fresh clone → configure env → register in an MCP client → exercise one tool per domain successfully.

**Implementation:** `src/mattermost/resilience.ts` — `withRetry` (retries `429`/`5xx`/network with exponential backoff + jitter; `sleep`/`rand` injectable for tests) and `applyRequestTimeout` (injects an `AbortSignal.timeout` into `Client4.getOptions` so the underlying fetch is actually aborted — HTTP stays inside Client4). `createSession` now: builds the client with the timeout, wraps every `call` in `withRetry` around the existing 401 auth-recovery, and fails fast at boot with an actionable `Mattermost authentication failed (mode=…): … Verify your MM_* credentials …` message. Three env vars added (`MM_REQUEST_TIMEOUT_MS`=30000, `MM_MAX_RETRIES`=3, `MM_RETRY_BASE_MS`=500) → `Config.resilience` (optional so test fixtures stay valid; defaults via `DEFAULT_RESILIENCE`). 12 resilience unit tests. Integration: `docker-compose.yml` (mattermost-preview) + `src/integration/live.integration.test.ts` (get_me / list_teams / post→get→delete), gated by `MM_INTEGRATION=1` (skipped by default → `npm test` stays offline; `npm run test:integration` runs it). Docs: `README.md` (12 sections — env tables, 34-tool catalog, auth setups, guardrail matrix, client-config examples, integration guide, architecture) + `examples/mcp.json` + `examples/claude_desktop_config.json`. Packaging already in place from Phase 0: `bin` → `dist/index.js` (shebang preserved by `tsc`), `files: ["dist"]`, `engines.node >=20`, version `0.1.0`. `npm publish` intentionally not run (outward-facing release action, left to a human). Gates: build ✅, lint ✅ (eslint + prettier), 130 unit tests pass + 3 integration skipped.

> Notes: `ClientError` exposes no response headers, so retry uses pure backoff (no `Retry-After`). The raw-`fetch` file tools (`get_file`/`get_file_metadata`) and the OAuth token endpoint bypass the Client4 timeout/retry wrap — an accepted minor gap. `.env.example` could not be updated (sandbox blocks writes to `.env*`); the resilience vars are documented in `README.md` instead.

---

## Sequencing & parallelism

```
Phase 0 → Phase 1 → Phase 3 ─┐
              └→ Phase 2     ├→ Phase 4 → 5 / 6 / 7 / 8 (parallel) → Phase 9
                             ┘
```

- Phase 2 (OAuth2) can run in parallel with Phase 3 after Phase 1.
- Phases 5–8 are independent once Phase 4 exists → parallelizable.

---

## Open implementation decisions (resolve at task time, not invented now)

- File download return format (base64 inline vs path) — default base64 + size cap.
- OAuth token cache location & encryption at rest.
- Whether `MM_READ_ONLY` hides write tools from `tools/list` or registers + hard-refuses.

---

## Appendix A — Verified endpoint map

All confirmed against `github.com/mattermost/mattermost/api/v4/source/*.yaml`
(posts, channels, users, files, reactions, teams) and the OAuth2 docs.

| Capability          | Method & path                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Login               | `POST /users/login` (`login_id`,`password`,`token`=MFA) → token in `Token` header                 |
| PAT auth            | `Authorization: Bearer <token>` header                                                            |
| OAuth2 authorize    | `GET {MM_URL}/oauth/authorize` (`response_type=code`, `client_id`, `redirect_uri`, `state`, PKCE) |
| OAuth2 token        | `POST {MM_URL}/oauth/access_token` (`grant_type=authorization_code` \| `refresh_token`)           |
| Create post         | `POST /posts`                                                                                     |
| Channel posts       | `GET /channels/{channel_id}/posts`                                                                |
| Thread              | `GET /posts/{post_id}/thread`                                                                     |
| Get post            | `GET /posts/{post_id}`                                                                            |
| Edit post           | `PUT /posts/{post_id}/patch`                                                                      |
| Delete post         | `DELETE /posts/{post_id}`                                                                         |
| Pin / unpin         | `POST /posts/{post_id}/pin` · `/unpin`                                                            |
| Search posts        | `POST /teams/{team_id}/posts/search`                                                              |
| Add reaction        | `POST /reactions`                                                                                 |
| Remove reaction     | `DELETE /users/{user_id}/posts/{post_id}/reactions/{emoji_name}`                                  |
| Create channel      | `POST /channels`                                                                                  |
| DM / group DM       | `POST /channels/direct` (2 ids) · `POST /channels/group` (3–8 ids)                                |
| Get channel         | `GET /channels/{channel_id}`                                                                      |
| Archive channel     | `DELETE /channels/{channel_id}`                                                                   |
| Add / remove member | `POST /channels/{channel_id}/members` · `DELETE …/members/{user_id}`                              |
| Channel members     | `GET /channels/{channel_id}/members`                                                              |
| Mark read (view)    | `POST /channels/members/{user_id}/view` (`channel_id`)                                            |
| List teams          | `GET /users/{user_id}/teams`                                                                      |
| Channels in team    | `GET /users/{user_id}/teams/{team_id}/channels`                                                   |
| Unread (channel)    | `GET /users/{user_id}/channels/{channel_id}/unread`                                               |
| Get me / user       | `GET /users/me` · `/users/{user_id}` · `/users/username/{username}`                               |
| Search users        | `POST /users/search` (`term`)                                                                     |
| Get / set status    | `GET` · `PUT /users/{user_id}/status` (online/away/offline/dnd)                                   |
| Custom status       | `PUT /users/{user_id}/status/custom` (`emoji`,`text`)                                             |
| Upload file         | `POST /files` (multipart `files`,`channel_id`) → `{file_infos[]}`                                 |
| Get file / info     | `GET /files/{file_id}` · `/files/{file_id}/info` · `/thumbnail` · `/preview` · `/link`            |
