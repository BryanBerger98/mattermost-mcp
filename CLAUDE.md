# mattermost-mcp

MCP server (stdio) exposing the Mattermost REST API v4 as tools, for self-hosted instances.
Scope + tool catalog: `SCOPE.md`. Phases + verified endpoint map: `PLAN.md` (read on demand).

## Commands

- `npm run dev` — run the server over stdio (tsx)
- `npm run build` — `tsc` → `dist/`
- `npm test` — vitest. Single file: `npx vitest run src/tools/messaging.test.ts`
- `npm run lint` — eslint + prettier

## Stack (fixed — do not swap)

- Node 20, ESM (`"type": "module"`), TypeScript NodeNext, `strict`
- `@modelcontextprotocol/sdk` ^1.29 — stdio transport
- `@mattermost/client` ^11.6 `Client4` for ALL HTTP — do not hand-roll fetch
- `zod` for every tool input schema

## Rules

- IMPORTANT: stdout is the MCP channel. Log ONLY to stderr. Never write to stdout.
- Validate every tool input with a zod schema before use.
- All writes go through `src/guardrails.ts`. Destructive tools (`delete_post`, `archive_channel`, `remove_member`) require arg `confirm: true` AND env `MM_ALLOW_DESTRUCTIVE=true`. `MM_READ_ONLY=true` disables all writes.
- Surface Mattermost API errors verbatim (status code + message). Do not swallow.
- IMPORTANT: never invent API paths. Use only endpoints verified in `PLAN.md` Appendix A.
- `edit_post` uses `PUT /posts/{id}/patch` (not full replace). `send_dm` body is a JSON array of user ids (2 direct / 3–8 group).
- Auth modes: `pat | password | oauth2`. Password session token comes from the `Token` response header.

## Layout

- `src/index.ts` — server bootstrap (stdio)
- `src/config.ts` — env parsing + validation (zod)
- `src/mattermost/` — `Client4` wrapper + auth strategies
- `src/guardrails.ts` — read-only / destructive / allowlist checks
- `src/tools/` — tool defs per domain (messaging, channels, users, files) + `registry.ts`

## Conventions

- One tool file per domain; register through `src/tools/registry.ts`.
- All env vars are prefixed `MM_` (see `.env.example`).
