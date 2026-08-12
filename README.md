# agent-host

A local control plane for AI coding agents.

`agent-host` discovers agents running on your machine, normalizes their state/capabilities, and exposes one local API that thin clients can use. A watch, Stream Deck, menu bar app, web UI, phone app, or another agent should not need to know whether the target is Codex, Claude Code, Herdr, or something else.

> Status: early MVP. Herdr control, a host-owned Codex App Server integration, opt-in attachment to an explicitly configured Codex App Server control socket, and a macOS LaunchAgent lifecycle are implemented. Other external desktop/CLI processes remain detection-only until a reliable transport exists.

## Why

The client should be boring:

```text
Codex / Claude / Gemini / Herdr / ...
                │
                ▼
           agent-host
      discovery · registry
      actions · event stream
                │
       ┌────────┼────────┐
       ▼        ▼        ▼
    Watch     Web UI   iPhone
```

Clients only consume a stable agent model and invoke capabilities exposed by the host.

## MVP

- Detect common local coding-agent processes (`claude`, `codex`, `gemini`, `opencode`, `hermes`, `cursor-agent`).
- Read Herdr's live agent registry through `herdr api snapshot` when Herdr is running.
- Start a local `codex app-server` over stdio and expose Codex threads through the same agent model.
- Send prompts to Codex threads with `thread/resume` + `turn/start`, or `turn/steer` for a turn owned by this host.
- Track Codex thread status notifications and interrupt turns owned by this host.
- Surface real Codex command/file approval requests and answer them semantically with `accept` / `decline`.
- Optionally subscribe to live threads already loaded on a shared Codex App Server Unix control socket.
- Normalize status to `unknown | idle | working | blocked | done | error`.
- Advertise per-agent capabilities instead of pretending every backend supports every action.
- Control Herdr agents with prompt, key input, interrupt, focus, and read operations.
- Expose HTTP JSON endpoints plus an SSE event stream.
- Keep the server loopback-only by default (`127.0.0.1`).

## API

```text
GET  /health
GET  /ready
GET  /v1/adapters
GET  /v1/diagnostics                   # authenticated, sanitized, bounded operations snapshot
GET  /v1/agents                        # bounded summaries; default limit 50, maximum 200
GET  /v1/agents/:id
POST /v1/refresh
GET  /v1/events                         # Server-Sent Events
POST /v1/agents/:id/prompt              { "text": "Fix the test" }
POST /v1/agents/:id/send-keys           { "keys": ["esc"] }
POST /v1/agents/:id/approve             { "approvalId": "61" } # optional when exactly one is pending
POST /v1/agents/:id/reject              { "approvalId": "61" }
POST /v1/agents/:id/interrupt
POST /v1/agents/:id/focus
POST /v1/agents/:id/read
```

Only `/health` and the aggregate `/ready` probe are unauthenticated. Every `/v1/*`
request requires `Authorization: Bearer <token>`. Action requests also require
`Content-Type: application/json` and an 8-128 character `Idempotency-Key`; retries
with the same key and payload return the original result, while conflicting reuse
returns `409 idempotency_conflict`. Mutations for one agent execute serially.
Action queues are bounded at 32 entries per agent and 256 globally; excess work
returns `429 queue_full` with `Retry-After: 1`.

`GET /v1/agents` accepts repeatable or comma-separated `provider` and `status`
filters, plus `view`, `cwd`, free-text `q`, `limit`, and an opaque `cursor`. Responses include
the current snapshot `revision`; a cursor returns `409 stale_cursor` if that snapshot
changes during pagination. List entries are bounded summaries and never include raw
provider metadata. Use the detail endpoint for controlled fields such as pending
approvals.

`view` controls discovery noise:

| View | Meaning |
| --- | --- |
| `recent` (default) | Active agents plus the bounded recent working set |
| `active` | Working, blocked, or confidently detected live agents |
| `historical` | Older persisted sessions, loaded on demand and cached separately |
| `raw` | All normalized records, including low-confidence and linked duplicates |

`raw` does not expose provider metadata. Records can include provider-neutral
`discovery.kind`, `confidence`, `visibility`, and `duplicateOf` fields. Historical
loading has its own cursor revision and does not expand the periodic refresh workload
or emit a burst of normal agent lifecycle events.

Provider metadata is intentionally non-semantic and excluded from public responses
and change detection. Adapter authors must lift every client-visible mutable value
into the canonical agent fields; otherwise that value will not advance the snapshot
revision or emit an update event.

All JSON responses include `apiVersion`. Errors use one stable envelope:

```json
{
  "apiVersion": "1",
  "error": {
    "code": "capability_not_available",
    "message": "capability approve is not available",
    "details": { "agentId": "codex:thr_123", "action": "approve" }
  }
}
```

Action request bodies are limited to 1 MB and oversized payloads return
`413 payload_too_large`.

An action returns `409 capability_not_available` when the agent does not advertise
the requested capability. SSE events contain `apiVersion`, a monotonically increasing
`sequence`, and the agent snapshot revision associated with the change.
Successful actions have stable `ok`, `agentId`, and `action` fields. Their optional
`data` value is adapter-specific and should only be interpreted by clients that know
that adapter; provider-neutral clients should treat it as opaque.

The `v1` compatibility boundary covers field names, status values, capability names,
action result fields, event types, and error codes. New optional fields and new event
types may be added without changing the version; clients should ignore fields and
events they do not understand. Removing or renaming a field, changing its meaning or
type, or removing an existing status, capability, action, event, or error code requires
a new API version.

`/health` is a liveness probe and responds as soon as the HTTP listener is running.
`/ready` returns `503` only while the bounded initial discovery is still loading, then
returns `200` even when one adapter is degraded. `GET /v1/adapters` exposes each
adapter's `status` (`loading`, `healthy`, `error`, or `timeout`), last attempt and
success timestamps, duration, agent count, sanitized error, and circuit state. Slow and failed
adapters retain their last successful agents while healthy adapters continue updating.
SSE emits `adapter.health` only when status, agent count, or sanitized error changes.
Repeated failures use deterministic exponential backoff and open the adapter circuit
after three failures. Scheduled refreshes respect the circuit; an authenticated explicit
refresh can request a rate-limited single probe and is never lost behind a scheduled pass.

Example Codex agent waiting for approval:

```json
{
  "id": "codex:thr_123",
  "provider": "codex",
  "source": "codex",
  "name": "Fix tests",
  "status": "blocked",
  "capabilities": {
    "prompt": true,
    "sendKeys": false,
    "approve": true,
    "reject": true,
    "interrupt": true,
    "focus": false,
    "read": true
  },
  "pendingApprovals": [
    {
      "approvalId": "1:thr_123:61",
      "method": "item/commandExecution/requestApproval",
      "command": "npm test",
      "reason": "Run tests"
    }
  ]
}
```

`approve` and `reject` are deliberately **not** mapped to blind Enter/Escape presses. The Codex adapter only exposes these capabilities after App Server sends a real approval request and resolves that exact server request ID. Approval IDs are opaque; clients must return the value received from the API unchanged.

## Install a release

The integrated `0.3.0` release artifact contains agent-host plus dashboard assets built
from the exact compatible dashboard commit. It installs into immutable version
directories behind `~/.local/share/agent-host/current`; the LaunchAgent uses the stable
`~/.local/bin/agent-host` launcher, so update and rollback do not depend on a clone or
old source path. Verify `checksums.txt`, extract the archive, and run:

```bash
node agent-host-0.3.0/scripts/manage-installation.js install agent-host-0.3.0
~/.local/bin/agent-host init
~/.local/bin/agent-host service install
~/.local/bin/agent-host start
```

The packaged dashboard is then available at `http://127.0.0.1:4777/`; its same-origin
`/agent-host/v1/*` requests use the same authentication as `/v1/*`. Tokens remain in
memory-only onboarding and are never embedded in assets. Full update, rollback, and
removal commands are in [docs/install.md](docs/install.md); version/API/config/dashboard
rules and verified Node/adapter ranges are in [docs/compatibility.md](docs/compatibility.md).

## Run from source

Requires Node.js 22+ and optionally the CLIs for the adapters you want to use. The Codex semantic adapter requires `codex` to be available on `PATH`.

```bash
npm install
npm start                # foreground
```

Initialize a versioned user configuration and private API token:

```bash
node src/cli.js init
node src/cli.js config validate
node src/cli.js config show --json
```

The default configuration is `~/.agent-host/config.json`. Precedence is CLI flags,
then `AGENT_HOST_*` environment variables, then the JSON file, then defaults. Unknown
JSON keys and invalid values fail startup instead of being ignored. The supported
settings are:

| JSON key | CLI / environment | Purpose |
| --- | --- | --- |
| `bind` | `--bind` / `AGENT_HOST_BIND` | loopback bind address |
| `port` | `--port` / `AGENT_HOST_PORT` | HTTP port |
| `refreshMs` | `--refresh-ms` / `AGENT_HOST_REFRESH_MS` | periodic refresh interval |
| `adapterTimeoutMs` | `--adapter-timeout-ms` / `AGENT_HOST_ADAPTER_TIMEOUT_MS` | per-adapter timeout |
| `enabledAdapters` | `--enabled-adapters` / `AGENT_HOST_ENABLED_ADAPTERS` | comma-separated `codex,herdr,process` subset |
| `codexTransport` | `--codex-transport` / `AGENT_HOST_CODEX_TRANSPORT` | `owned` or `control` |
| `codexSocket` | `--codex-socket` / `AGENT_HOST_CODEX_SOCKET` | control-mode Unix socket |
| `tokenFile` | `--token-file` / `AGENT_HOST_TOKEN_FILE` | private bearer token file |
| `lockFile` | `--lock-file` / `AGENT_HOST_LOCK_FILE` | single-instance ownership file |
| `logLevel` | `--log-level` / `AGENT_HOST_LOG_LEVEL` | `debug`, `info`, `warn`, or `error` |
| `logFile` | `--log-file` / `AGENT_HOST_LOG_FILE` | rotating application JSONL log |
| `dashboardUrl` | `--dashboard-url` / `AGENT_HOST_DASHBOARD_URL` | canonical dashboard origin |
| `dashboardDirectory` | `--dashboard-dir` / `AGENT_HOST_DASHBOARD_DIR` | optional built dashboard assets served from `/` |
| `allowedOrigins` | repeatable `--allowed-origin` / `AGENT_HOST_ALLOWED_ORIGINS` | additional canonical browser origins |

Relative paths in the JSON file resolve from the configuration directory. CLI and
environment paths resolve from the current working directory. State directories are
owner-only; configuration, token, lock, and LaunchAgent files reject unsafe ownership
or symbolic-link use where they are read or replaced.

### Service lifecycle

Portable foreground operation remains `agent-host serve`. On macOS, install an
auto-starting per-user LaunchAgent, then control it explicitly:

```bash
node src/cli.js service install
node src/cli.js start
node src/cli.js status --json
node src/cli.js restart
node src/cli.js stop
node src/cli.js service uninstall
```

`service install` writes `~/Library/LaunchAgents/dev.agent-host.plist` but does not
start it. The plist contains absolute Node, CLI, config, and console-log paths; it never embeds
the API token. `RunAtLoad` and `KeepAlive` restore the service after login or a crash.
Only the managed plist is removed on uninstall—configuration, token, and logs remain.
`start`, `stop`, and `restart` are macOS service commands; use Ctrl-C or SIGTERM for a
portable foreground process.

The instance lock prevents duplicate daemons and is released after graceful shutdown.
A stale crash lock is recovered only after its recorded process is no longer alive and
the lock inode is rechecked. Port conflicts and invalid configuration return actionable
errors.

Rotate the persistent token only while the daemon is stopped:

```bash
node src/cli.js stop
node src/cli.js token rotate
node src/cli.js start
```

`AGENT_HOST_API_TOKEN` is a non-persistent startup override and is deliberately not
changed by `token rotate`.

For a reversible real LaunchAgent smoke test on a Mac with no existing
`dev.agent-host` service loaded:

```bash
AGENT_HOST_RUN_SERVICE_SMOKE=1 npm run smoke:macos-service
```

The script uses an isolated temporary home, verifies start/status/stop/restart and
uninstall, confirms configuration and token preservation, then cleans up.

To start directly without initialization, the first foreground run securely creates
the token as needed:

```bash
npm start
```

By default, `agent-host` starts and owns a separate Codex App Server over stdio. To
observe the same loaded threads as clients attached to an existing local App Server,
opt in to its Unix control socket with an explicit absolute path:

```bash
AGENT_HOST_CODEX_TRANSPORT=control \
AGENT_HOST_CODEX_SOCKET=/absolute/path/to/app-server.sock \
npm start
```

Both variables are required for shared control. `agent-host` does not discover socket
paths, start or stop the daemon, change socket permissions, or support TCP/WebSocket
URLs. If the connection is lost, Codex records immediately become `unknown` with no
actions until reconnect and subscription succeed.

Discovery runs concurrently, is coalesced when refreshes overlap, and defaults to a
20-second timeout per adapter. Override it with a positive integer in
`AGENT_HOST_ADAPTER_TIMEOUT_MS`; invalid values stop startup. The
normal refresh interval remains configurable with `AGENT_HOST_REFRESH_MS`.

### Operations and diagnostics

Runtime logs are JSON Lines in the configured `logFile`. They use a fixed field
allowlist and central redaction for credentials, bearer values, prompts, configured
private paths, URL credentials/query strings, and home paths. The file is owner-only,
rotates at 1 MiB, and retains three generations; the in-memory diagnostics ring retains
the latest 200 records. LaunchAgent stdout/stderr use the separate
`agent-host.log.console` and `.console.error` files so launchd cannot keep writing to a
rotated application-log inode.
Write, capacity, and rotation failures do not terminate the host. The logger pauses
sink retries for 30 seconds and exposes the failure code and operation through the
diagnostics snapshot and bounded in-memory ring.

Operational metrics have fixed labels and bounded histogram buckets. They cover
refresh duration, adapter failure/recovery and circuit probes, SSE connections,
reconnects and overflow, subscriber and queue depth, action rejection/latency, and a
current Node memory snapshot. Obtain the running snapshot through authenticated
`GET /v1/diagnostics`, or create a single owner-only JSON bundle that falls back to
local config, lock state, versions, and rotated logs when the daemon is offline:

```bash
node src/cli.js diagnostics
node src/cli.js diagnostics /private/path/agent-host-diagnostics.json
```

SSE delivery keeps at most 64 pending events or 256 KiB per client after Node signals
backpressure. Heartbeats are dropped while blocked. A client that exceeds either bound
is disconnected and must reconnect and replace its local snapshot; other clients remain
connected. Shutdown stops new mutations, closes SSE listeners, rejects queued actions,
gives active actions a bounded grace period, aborts remaining work, then closes adapters
and the HTTP listener.

The accelerated soak models 28,800 one-second refresh periods (eight hours), injected
adapter exits/circuit recovery, action traffic, and repeated slow SSE clients. It reports
heap/RSS, handle, queue, log-ring, metric-series, and tracked-child trends:

```bash
npm run soak:quick
npm run soak
```

Then:

```bash
AGENT_HOST_TOKEN="$(tr -d '\n' < "$HOME/.agent-host/token")"
curl -H "Authorization: Bearer $AGENT_HOST_TOKEN" \
  'http://127.0.0.1:4777/v1/agents?status=working,blocked&limit=25'
curl -N -H "Authorization: Bearer $AGENT_HOST_TOKEN" \
  http://127.0.0.1:4777/v1/events
curl -X POST -H "Authorization: Bearer $AGENT_HOST_TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: prompt-example-0001' \
  -d '{"text":"Fix the test"}' \
  http://127.0.0.1:4777/v1/agents/codex%3Athr_123/prompt
```

CLI:

```bash
npm run list
node src/cli.js action 'codex:thr_123' prompt '{"text":"Fix the test"}'
node src/cli.js action 'codex:thr_123' approve '{"approvalId":"61"}'
```

Checks:

```bash
npm run check
npm run soak:quick
```

## Dashboard demo and client conformance

Start a deterministic, local-only demo host with one command:

```bash
npm run demo
```

Demo mode disables the Codex, Herdr, and process adapters and exposes only six
clearly named `demo:*` agents covering `idle`, `working`, `blocked`, `done`,
`error`, and `unknown`. It is opt-in: normal `npm start` behavior is unchanged.
Read the generated bearer token from `~/.agent-host/token`, as in the API examples
above. Dashboard development commonly also needs an exact origin allowlist:

```bash
AGENT_HOST_ALLOWED_ORIGINS=http://127.0.0.1:3000 npm run demo
```

The demo supports predictable transitions: prompting an idle/error agent moves it
to working, interrupting a working agent moves it to idle, and accepting or declining
`demo-approval-1` moves the blocked agent to working or done. An action immediately
emits `agent.action`; call `POST /v1/refresh` to publish the resulting `agent.updated`
snapshot transition.

Language-neutral fixtures live in `fixtures/client-conformance/`, including approval,
adapter-failure, SSE reconnect, and a 1,000-agent scale case. The reusable Node runner
in `conformance/client-suite.js` verifies snapshot, action, error, event, and reconnect
behavior against a fresh demo server. Regenerate the checked-in scale fixture with
`npm run fixtures:generate`, or run only the live contract checks with
`npm run conformance`.

SSE is a live stream, not a replay log. After disconnect or a sequence gap, clients
must reconnect, inspect the new `ready` event, and fetch a fresh snapshot before
applying later events.

## Adapter tiers

The host separates **detection** from **control**.

| Adapter | Detect | State | Prompt | Keys | Semantic approve/reject |
| --- | --- | --- | --- | --- | --- |
| OS process | yes | unknown | no | no | no |
| Herdr | yes | rich | yes | yes | not yet |
| Codex app-server (host-owned) | yes | rich for host-owned activity | yes | n/a | yes |
| Codex app-server (shared control socket) | opt-in | rich for loaded threads | yes* | n/a | yes* |
| Claude Code hooks | planned | rich | planned* | planned* | planned |
| Desktop app adapters | planned | app-specific | app-specific | app-specific | app-specific |

`*` Shared Codex actions require a successfully subscribed loaded thread. Threads that
are only persisted remain visible but expose no actions; a parent-owned child thread
may also reject direct prompt input. Shared prompt is fail-closed and appears only
when experimental `canAcceptDirectInput` is explicitly `true`. Multiple App Server
subscribers can see the same
approval, so the first valid response wins and all clients must converge on
`serverRequest/resolved`.

For planned hook-based adapters, hooks provide identity/state but input still requires
a supported control path such as Herdr, a native protocol, or an app-specific bridge.

## Codex adapter

In the default `owned` mode, `agent-host` launches its own
`codex app-server --listen stdio://`. In opt-in `control` mode, it runs
`codex app-server proxy --sock <absolute-path>` and performs a WebSocket upgrade over
that child process's stdio. Both modes perform the required `initialize` /
`initialized` handshake and use the official App Server protocol rather than terminal
keystroke automation.

Implemented protocol paths:

```text
thread/list
thread/loaded/list
thread/resume
thread/read
turn/start
turn/steer
turn/interrupt
thread/status/changed
turn/started
turn/completed
turn/failed
turn/aborted
item/commandExecution/requestApproval
item/fileChange/requestApproval
serverRequest/resolved
```

Command and file-change approvals expire from the local view after five minutes by
default. In owned mode they are also cancelled so unattended requests do not leave a
thread blocked. Shared mode never cancels an expired approval or answers unsupported
server requests because another subscriber may still own that interaction. Owned mode
returns an explicit unsupported-method response for other server-initiated requests.

### Ownership and subscription boundary

API records expose `discovery.provenance` as either `owned-app-server` or
`shared-control-socket`. Shared control means `agent-host` is another subscriber, not
the owner of a desktop client, thread, turn, or approval. It subscribes only to threads
returned by `thread/loaded/list`, using `thread/resume` with turn history excluded.
Persisted-only threads remain detection-only. A failed per-thread subscription is
isolated to that thread.

Connection, subscription, and approval identities are scoped to one transport
generation. On reconnect, old approval IDs cannot be reused and actions remain gated
until each thread is subscribed again. Codex processes unrelated to the configured
socket remain available only in the `raw` view, avoiding a duplicate controllable
record.

## Architecture

```text
src/
  core/
    types.js       unified model + capabilities
    contracts.js   versioned HTTP views, filters, pagination, errors
    discovery.js   visibility ordering + process/rich reconciliation
    registry.js    merge discovery + route actions
    event-bus.js   normalized events
  adapters/
    demo.js        deterministic opt-in dashboard states and transitions
    process.js     OS process discovery
    herdr.js       Herdr adapter
    codex-websocket-wire.js  control-proxy WebSocket framing
    codex-rpc.js   Codex App Server JSON-RPC transport
    codex.js       Codex thread/status/action adapter
  http/
    server.js      HTTP + SSE interface
  runtime.js       live versus demo adapter composition
  cli.js           daemon / local CLI
conformance/
  client-suite.js  reusable HTTP/SSE client contract checks
fixtures/
  client-conformance/  sanitized versioned scenarios and scale data
```

### Adapter contract

```ts
interface AgentAdapter {
  id: string
  onChange?(handler): () => void
  discover(options?: { signal?: AbortSignal }): Promise<AgentRecord[]>
  discoverHistory?(options?: { signal?: AbortSignal }): Promise<AgentRecord[]>
  markStale?(agent): AgentRecord
  prompt?(agent, text): Promise<AgentActionResult>
  sendKeys?(agent, keys): Promise<AgentActionResult>
  approve?(agent, payload?): Promise<AgentActionResult>
  reject?(agent, payload?): Promise<AgentActionResult>
  interrupt?(agent): Promise<AgentActionResult>
  focus?(agent): Promise<AgentActionResult>
  read?(agent): Promise<AgentActionResult>
  close?(): Promise<void>
}
```

This keeps client integrations provider-agnostic.

The process adapter treats direct agent executables as high-confidence and loose
command-line matches as raw-only. Process records never advertise interrupt by
default. A process record is suppressed from normal views only when a richer
same-provider adapter reports the exact same PID; matching working directories alone
never merges agents.

## Next adapters

### Claude Code

Use hooks for reliable session identity and lifecycle signals. Pair those signals with an explicit input/control transport. For Claude sessions running inside Herdr, Herdr already provides that transport; direct terminal sessions need a separate safe adapter.

### Desktop apps

Use native/local protocols where available. Accessibility automation should be a last-resort adapter and should advertise weaker capabilities because UI automation is fragile.

## Security

- Binds to loopback only. `AGENT_HOST_BIND` accepts `127.0.0.1`, `localhost`, or
  `::1`; remote/LAN binding is rejected.
- Set `AGENT_HOST_API_TOKEN` to supply a token. Otherwise a new 256-bit token is
  generated before listening and atomically written to `~/.agent-host/token` with
  owner-only permissions. Override that path with `AGENT_HOST_TOKEN_FILE`. The token
  itself is never written to service logs.
- All `/v1/*` routes require the bearer token. Do not commit it, put it in dashboard
  source, or include it in URLs. A browser dashboard should receive it at runtime
  through a user prompt or a local backend/session and keep it out of persistent web
  assets.
- Browser requests must have an allowed Host and Origin. Cross-origin access is
  denied by default. Set `AGENT_HOST_ALLOWED_ORIGINS` to a comma-separated list of
  exact dashboard origins such as `http://127.0.0.1:3000`; only those origins receive
  CORS preflight permission for Authorization, Content-Type, and Idempotency-Key.
  Origins must be canonical (no path or trailing slash); invalid configuration stops startup.
- Never exposes an action unless the adapter declares it.
- Codex semantic approvals require a real pending server request ID/context.
- Treat `AGENT_HOST_CODEX_SOCKET` as a local security boundary. Configure only a
  socket owned by the intended user; `agent-host` passes the path as an argument and
  never creates, deletes, changes permissions on, or discovers control sockets.
- Attempted and completed authenticated actions emit `audit.action` events containing
  identifiers and outcome codes, never request bodies, headers, or tokens.

## References

- Codex app-server: https://github.com/openai/codex/tree/main/codex-rs/app-server
- Bearer token usage: https://www.rfc-editor.org/rfc/rfc6750
- Browser CORS: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS
- Herdr socket/CLI API: https://herdr.dev/docs/socket-api/
- Herdr agent automation: https://herdr.dev/docs/agent-automation/

## License

MIT
