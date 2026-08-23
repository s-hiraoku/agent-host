# AGENTS.md

## Cursor Cloud specific instructions

`agent-host` is a single Node.js product: a loopback HTTP JSON API + SSE control plane
for AI coding agents. It has **zero runtime npm dependencies** and no database/service
backends. Node.js `>=22 <25` is required (see `engines` in `package.json`); the VM's
Node 22 satisfies this.

Standard commands live in `package.json` `scripts`; use those rather than reinventing
them:

- Lint / syntax check + tests: `npm run check` (runs `node --check` over `src/**` then `npm test`).
- Tests only: `npm test` (Node built-in test runner across `test/**/*.test.js`).
- Client conformance only: `npm run conformance`.
- Run in dev (real adapters): `npm start` (= `node src/cli.js serve`).
- Run in dev (deterministic, no external CLIs): `npm run demo`.

Non-obvious caveats:

- `npm install` is effectively a no-op / script validation — there is no lockfile and no
  dependencies. Do not expect it to install anything.
- Prefer `npm run demo` for end-to-end verification: it disables the `codex`/`herdr`/`process`
  live adapters (which need external CLIs/daemons not present in this VM) and exposes six
  deterministic `demo:*` agents on `http://127.0.0.1:4777`.
- All `/v1/*` routes require a bearer token. The token is auto-generated at
  `~/.agent-host/token` on first serve/demo; read it and send `Authorization: Bearer <token>`.
  Only `/health` and `/ready` are unauthenticated.
- Write/action endpoints (e.g. `POST /v1/agents/:id/prompt`) require an `Idempotency-Key`
  header of 8–128 safe ASCII characters, otherwise they return `invalid_idempotency_key`.
- SSE (`/v1/events`) is a live stream, not a replay log. Prompting an agent emits
  `agent.action` immediately; call `POST /v1/refresh` to publish the resulting
  `agent.updated` snapshot transition, then re-`GET` the agent to see the new status.
- The web dashboard is a **separate repo** (`s-hiraoku/agent-host-dashboard`) and is not
  built here; there is no in-repo GUI to test.
