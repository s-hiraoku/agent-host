# agent-host

A local control plane for AI coding agents.

`agent-host` discovers agents running on your machine, normalizes their state/capabilities, and exposes one local API that thin clients can use. A watch, Stream Deck, menu bar app, web UI, phone app, or another agent should not need to know whether the target is Codex, Claude Code, Herdr, or something else.

> Status: early MVP. Herdr control and a host-owned Codex App Server integration are implemented. Direct control of arbitrary external desktop/CLI agent processes remains capability-gated until a reliable adapter exists.

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

`GET /v1/agents` accepts repeatable or comma-separated `provider` and `status`
filters, plus `cwd`, free-text `q`, `limit`, and an opaque `cursor`. Responses include
the current snapshot `revision`; a cursor returns `409 stale_cursor` if that snapshot
changes during pagination. List entries are bounded summaries and never include raw
provider metadata. Use the detail endpoint for controlled fields such as pending
approvals.

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
success timestamps, duration, agent count, and sanitized error. Slow and failed
adapters retain their last successful agents while healthy adapters continue updating.
SSE emits `adapter.health` only when status, agent count, or sanitized error changes.

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
      "approvalId": "61",
      "method": "item/commandExecution/requestApproval",
      "command": "npm test",
      "reason": "Run tests"
    }
  ]
}
```

`approve` and `reject` are deliberately **not** mapped to blind Enter/Escape presses. The Codex adapter only exposes these capabilities after App Server sends a real approval request and resolves that exact server request ID.

## Run

Requires Node.js 22+ and optionally the CLIs for the adapters you want to use. The Codex semantic adapter requires `codex` to be available on `PATH`.

```bash
npm install
npm start
```

Discovery runs concurrently, is coalesced when refreshes overlap, and defaults to a
20-second timeout per adapter. Override it with `AGENT_HOST_ADAPTER_TIMEOUT_MS`; the
normal refresh interval remains configurable with `AGENT_HOST_REFRESH_MS`.

Then:

```bash
curl 'http://127.0.0.1:4777/v1/agents?status=working,blocked&limit=25'
curl -N http://127.0.0.1:4777/v1/events
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
```

## Adapter tiers

The host separates **detection** from **control**.

| Adapter | Detect | State | Prompt | Keys | Semantic approve/reject |
| --- | --- | --- | --- | --- | --- |
| OS process | yes | unknown | no | no | no |
| Herdr | yes | rich | yes | yes | not yet |
| Codex app-server (host-owned) | yes | rich for host-owned activity | yes | n/a | yes |
| Claude Code hooks | planned | rich | planned* | planned* | planned |
| Desktop app adapters | planned | app-specific | app-specific | app-specific | app-specific |

`*` Hooks are good for identity/state; actual input/control still needs a supported control path (for example Herdr, a native protocol, or an app-specific bridge).

## Codex adapter

`agent-host` launches its own `codex app-server --listen stdio://` process and performs the required `initialize` / `initialized` handshake. It uses the official App Server protocol rather than terminal keystroke automation.

Implemented protocol paths:

```text
thread/list
thread/resume
thread/read
turn/start
turn/steer
turn/interrupt
thread/status/changed
turn/started
turn/completed
item/commandExecution/requestApproval
item/fileChange/requestApproval
serverRequest/resolved
```

Command and file-change approvals expire after five minutes by default and are cancelled so unattended requests do not leave a thread blocked indefinitely. Other server-initiated request types receive an explicit unsupported-method response instead of stalling the App Server connection.

### Important limitation

The current adapter owns its App Server connection. It can list persisted Codex threads that are visible from the same Codex home and it can resume/control work through the host-owned App Server.

It does **not** yet claim to attach to an arbitrary already-running Codex Desktop App Server process. Therefore, a turn that is actively running inside a separate Codex Desktop process may not appear as `working` in this host-owned server, and its in-flight approval request cannot be answered by this connection unless that request originated from the host-owned App Server.

A future transport adapter should attach to an explicitly reachable existing App Server endpoint/control socket. That is the path to true cross-client live control of Codex Desktop.

## Architecture

```text
src/
  core/
    types.js       unified model + capabilities
    contracts.js   versioned HTTP views, filters, pagination, errors
    registry.js    merge discovery + route actions
    event-bus.js   normalized events
  adapters/
    process.js     OS process discovery
    herdr.js       Herdr adapter
    codex-rpc.js   Codex App Server JSON-RPC transport
    codex.js       Codex thread/status/action adapter
  http/
    server.js      HTTP + SSE interface
  cli.js           daemon / local CLI
```

### Adapter contract

```ts
interface AgentAdapter {
  id: string
  discover(options?: { signal?: AbortSignal }): Promise<AgentRecord[]>
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

## Next adapters

### Codex existing-process transport

Attach to an explicitly exposed App Server endpoint/control socket so `agent-host` can observe and control the same live threads as another Codex client instead of owning a separate App Server process.

### Claude Code

Use hooks for reliable session identity and lifecycle signals. Pair those signals with an explicit input/control transport. For Claude sessions running inside Herdr, Herdr already provides that transport; direct terminal sessions need a separate safe adapter.

### Desktop apps

Use native/local protocols where available. Accessibility automation should be a last-resort adapter and should advertise weaker capabilities because UI automation is fragile.

## Security

- Binds to `127.0.0.1` by default.
- Never exposes an action unless the adapter declares it.
- Codex semantic approvals require a real pending server request ID/context.
- Remote access and authentication are intentionally out of scope for the first MVP.

## References

- Codex app-server: https://github.com/openai/codex/tree/main/codex-rs/app-server
- Herdr socket/CLI API: https://herdr.dev/docs/socket-api/
- Herdr agent automation: https://herdr.dev/docs/agent-automation/

## License

MIT
