# mattermost-mcp — Scope

MCP server (Node.js / TypeScript) exposing Mattermost as tools for an LLM agent.
Targets **self-hosted** Mattermost instances. REST API v4 (`{MM_URL}/api/v4`).

Status: **scope frozen, pre-implementation.**

---

## 1. Goals

- Let an agent read and write messages in Mattermost.
- Navigate teams / channels, manage membership and read state.
- Look up users and presence.
- Upload and retrieve files.
- Authenticate against self-hosted instances with three interchangeable modes.
- Ship safe by default: write actions exist but are gated by guardrails.

Non-goals (v1): real-time WebSocket subscriptions, admin/system console, plugins,
webhooks/slash-command provisioning, compliance/data-retention, Boards/Playbooks/Calls.

---

## 2. Authentication

Single selector `MM_AUTH_MODE = pat | password | oauth2`. Common: `MM_URL`.

| Mode            | Env                                                      | Mechanism                                  | Notes                                                                                                                 |
| --------------- | -------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `pat` (default) | `MM_TOKEN`                                               | `Authorization: Bearer <token>`            | Personal Access Token. No expiry, revocable. Must be enabled in System Console > Integrations. Simplest, recommended. |
| `password`      | `MM_LOGIN_ID`, `MM_PASSWORD`, `MM_MFA_TOKEN?`            | `POST /api/v4/users/login` → session token | Token expires; auto re-login on 401. Supports MFA. No admin setup needed.                                             |
| `oauth2`        | `MM_CLIENT_ID`, `MM_CLIENT_SECRET`, `MM_OAUTH_REDIRECT?` | OAuth2 flow + refresh token                | Heaviest. For multi-user / delegated scenarios.                                                                       |

Token (whatever the source) is injected as a Bearer header on every REST call.
WebSocket (future) reuses the same token via `authentication_challenge`.

---

## 3. Tools (v1)

Legend: ⚠️ = write guardrail · 💥 = destructive (extra gate).

### 3.1 Messaging (core)

| Tool                               | Purpose                                                 | API                                        |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| `post_message`                     | Post to a channel (optional `file_ids`, `props`)        | `POST /posts`                              |
| `reply_thread`                     | Reply in a thread (`root_id`)                           | `POST /posts`                              |
| `get_channel_posts`                | Paginated channel history (`page`, `per_page`, `since`) | `GET /channels/{id}/posts`                 |
| `get_thread`                       | Root post + all replies                                 | `GET /posts/{id}/thread`                   |
| `get_post`                         | Single post by id                                       | `GET /posts/{id}`                          |
| `search_posts`                     | Full-text search in a team                              | `POST /teams/{id}/posts/search`            |
| `edit_post` ⚠️                     | Update a post's message                                 | `PUT /posts/{id}`                          |
| `delete_post` 💥                   | Delete a post                                           | `DELETE /posts/{id}`                       |
| `send_dm`                          | Open/get DM (or group DM) and post                      | `POST /channels/direct`, `/channels/group` |
| `pin_post` / `unpin_post`          | Pin state                                               | `POST /posts/{id}/pin` · `/unpin`          |
| `add_reaction` / `remove_reaction` | Emoji reactions                                         | `POST /reactions` · `DELETE ...`           |

### 3.2 Channels & Teams

| Tool                                 | Purpose                       | API                                                               |
| ------------------------------------ | ----------------------------- | ----------------------------------------------------------------- |
| `list_teams`                         | Teams the user belongs to     | `GET /users/me/teams`                                             |
| `list_channels`                      | Channels for me in a team     | `GET /users/me/teams/{tid}/channels`                              |
| `get_channel`                        | Channel metadata              | `GET /channels/{id}`                                              |
| `create_channel` ⚠️                  | Create public/private channel | `POST /channels`                                                  |
| `join_channel` / `leave_channel` ⚠️  | Membership self               | `POST /channels/{id}/members` · `DELETE .../{uid}`                |
| `archive_channel` 💥                 | Archive (soft delete)         | `DELETE /channels/{id}`                                           |
| `list_channel_members`               | Members of a channel          | `GET /channels/{id}/members`                                      |
| `add_member` / `remove_member` ⚠️/💥 | Manage other members          | `POST .../members` · `DELETE .../members/{uid}`                   |
| `get_unreads`                        | Unread counts per channel     | `GET /users/me/teams/{tid}/channels/members` (msg_count vs total) |
| `mark_channel_read` ⚠️               | Mark channel viewed           | `POST /channels/members/me/view`                                  |

### 3.3 Users & presence

| Tool                   | Purpose                    | API                                          |
| ---------------------- | -------------------------- | -------------------------------------------- |
| `get_me`               | Current user               | `GET /users/me`                              |
| `get_user`             | By id or username          | `GET /users/{id}` · `/users/username/{name}` |
| `search_users`         | Search by term             | `POST /users/search`                         |
| `get_user_status`      | online/away/dnd/offline    | `GET /users/{id}/status`                     |
| `set_status` ⚠️        | Set own status             | `PUT /users/me/status`                       |
| `set_custom_status` ⚠️ | Emoji + text custom status | `PUT /users/me/status/custom`                |

### 3.4 Files

| Tool                | Purpose                          | API                    |
| ------------------- | -------------------------------- | ---------------------- |
| `upload_file` ⚠️    | Upload to a channel → `file_id`  | `POST /files`          |
| `get_file`          | Download file content            | `GET /files/{id}`      |
| `get_file_metadata` | Info / thumbnail / preview links | `GET /files/{id}/info` |

Attachments: pass returned `file_id`s to `post_message.file_ids`.

---

## 4. Guardrails

Config-driven safety layer in the tool wrapper, evaluated before any write hits the API.

| Env                    | Default   | Effect                                                                                         |
| ---------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `MM_READ_ONLY`         | `false`   | `true` → all ⚠️/💥 tools disabled; only reads exposed.                                         |
| `MM_ALLOW_DESTRUCTIVE` | `false`   | Gates 💥 tools (`delete_post`, `archive_channel`, `remove_member`). When `false`, they refuse. |
| `MM_TEAM_ALLOWLIST`    | _(unset)_ | CSV of team ids; actions outside are refused.                                                  |
| `MM_CHANNEL_ALLOWLIST` | _(unset)_ | CSV of channel ids; actions outside are refused.                                               |
| `MM_MAX_MESSAGE_LEN`   | `16383`   | Reject over-long messages before send.                                                         |

Additional rules:

- 💥 tools also require an explicit `confirm: true` argument **and** `MM_ALLOW_DESTRUCTIVE=true`.
- Mattermost API errors are surfaced verbatim (status + message), not swallowed.
- Allowlists checked against the channel/team resolved for the call.

---

## 5. Stack & layout

- **MCP**: `@modelcontextprotocol/sdk` (TypeScript), **stdio** transport.
- **HTTP**: official `@mattermost/client` (REST v4 coverage, Node 18+ global fetch) wrapped by a thin guardrail layer. Fall back to raw `fetch` where the client lacks an endpoint.
- **Validation**: `zod` for every tool input schema.
- **Config**: environment variables (+ `.env` in dev).

```
src/
  index.ts          # MCP server bootstrap, stdio transport
  config.ts         # env parsing + validation (auth mode, guardrails)
  mattermost/
    client.ts       # auth strategies + wrapped @mattermost/client
    types.ts
  guardrails.ts     # read-only / destructive / allowlist checks
  tools/
    messaging.ts
    channels.ts
    users.ts
    files.ts
    registry.ts     # collects tool defs + zod schemas
```

---

## 6. Open questions / later

- Real-time: WebSocket events → no clean MCP mapping. Polling `get_unreads` covers v1; revisit if needed.
- Pagination ergonomics: expose cursor/`since` or auto-aggregate? (lean: expose, let agent page).
- OAuth2 token storage for multi-session use.
- MCP Resources (read-only channel/post exposure) vs Tools-only — v1 is tools-only.

---

## 7. References

- API reference: https://api.mattermost.com/ (→ developers.mattermost.com/api-documentation)
- Personal access tokens: https://developers.mattermost.com/integrate/reference/personal-access-token/
- API v4 sources: https://github.com/mattermost/mattermost/tree/master/api/v4/source
