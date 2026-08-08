# agent-host

A local control plane for AI coding agents.

`agent-host` discovers agents running on your machine, normalizes their state/capabilities, and exposes one local API that thin clients can use. A watch, Stream Deck, menu bar app, web UI, phone app, or another agent should not need to know whether the target is Codex, Claude Code, Herdr, or something else.

> Status: early MVP. The architecture and Herdr control path are usable; direct semantic control of arbitrary external desktop/CLI agents is intentionally capability-gated until a reliable adapter exists.

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
- Normalize status to `unknown | idle | working | blocked | done | error`.
- Advertise per-agent capabilities instead of pretending every backend supports every action.
- Control Herdr agents with prompt, key input, interrupt, focus, and read operations.
- Expose HTTP JSON endpoints plus an SSE event stream.
- Keep the server loopback-only by default (`127.0.0.1`).

## API

```text
GET  /health
GET  /v1/agents
GET  /v1/agents/:id
POST /v1/refresh
GET  /v1/events                         # Server-Sent Events
POST /v1/agents/:id/prompt              { "text": "Fix the test" }
POST /v1/agents/:id/send-keys           { "keys": ["esc"] }
POST /v1/agents/:id/approve
POST /v1/agents/:id/reject
POST /v1/agents/:id/interrupt
POST /v1/agents/:id/focus
POST /v1/agents/:id/read
```

An action returns `409` when that agent does not advertise the requested capability.

Example agent:

```json
{
  "id": "herdr:w1:p2",
  "provider": "codex",
  "source": "herdr",
  "name": "reviewer",
  "status": "blocked",
  "capabilities": {
    "prompt": true,
    "sendKeys": true,
    "approve": false,
    "reject": false,
    "interrupt": true,
    "focus": true,
    "read": true
  }
}
```

`approve` and `reject` are deliberately **not** mapped to blind Enter/Escape presses. An adapter should only expose semantic approval when it can identify and answer a real approval request reliably.

## Run

Requires Node.js 22+.

```bash
npm install
npm run dev
```

Then:

```bash
curl http://127.0.0.1:4777/v1/agents
curl -N http://127.0.0.1:4777/v1/events
```

CLI:

```bash
npm run dev -- list
# after build
node dist/cli.js list
```

## Adapter tiers

The host separates **detection** from **control**.

| Adapter | Detect | State | Prompt | Keys | Semantic approve/reject |
| --- | --- | --- | --- | --- | --- |
| OS process | yes | unknown | no | no | no |
| Herdr | yes | rich | yes | yes | not yet |
| Codex app-server | planned | rich | planned | n/a | planned |
| Claude Code hooks | planned | rich | planned* | planned* | planned |
| Desktop app adapters | planned | app-specific | app-specific | app-specific | app-specific |

`*` Hooks are good for identity/state; actual input/control still needs a supported control path (for example Herdr, a native protocol, or an app-specific bridge).

## Architecture

```text
src/
  core/
    types.js       unified model + capabilities
    registry.js    merge discovery + route actions
    event-bus.js   normalized events
  adapters/
    process.js     OS process discovery
    herdr.js       Herdr adapter
  http/
    server.js      HTTP + SSE interface
  cli.js           daemon / local CLI
```

### Adapter contract

```ts
interface AgentAdapter {
  id: string
  discover(): Promise<AgentRecord[]>
  prompt?(agent, text): Promise<AgentActionResult>
  sendKeys?(agent, keys): Promise<AgentActionResult>
  approve?(agent): Promise<AgentActionResult>
  reject?(agent): Promise<AgentActionResult>
  interrupt?(agent): Promise<AgentActionResult>
  focus?(agent): Promise<AgentActionResult>
  read?(agent): Promise<AgentActionResult>
}
```

This keeps client integrations provider-agnostic.

## Next adapters

### Codex

Codex `app-server` is the preferred semantic integration because it exposes thread lifecycle/status, turn events, prompts, interrupts, and explicit approval requests over its protocol. The adapter should support both a host-owned app-server and connection to an explicitly configured existing endpoint. We should not claim an arbitrary Codex Desktop process is controllable unless its live app-server endpoint is actually reachable.

### Claude Code

Use hooks for reliable session identity and lifecycle signals. Pair those signals with an explicit input/control transport. For Claude sessions running inside Herdr, Herdr already provides that transport; direct terminal sessions need a separate safe adapter.

### Desktop apps

Use native/local protocols where available. Accessibility automation should be a last-resort adapter and should advertise weaker capabilities because UI automation is fragile.

## Security

- Binds to `127.0.0.1` by default.
- Never exposes an action unless the adapter declares it.
- Semantic approvals should require a real approval request ID/context; do not implement them as generic keystrokes.
- Remote access and authentication are intentionally out of scope for the first MVP.

## References

- Codex app-server: https://github.com/openai/codex/tree/main/codex-rs/app-server
- Herdr socket/CLI API: https://herdr.dev/docs/socket-api/
- Herdr agent automation: https://herdr.dev/docs/agent-automation/

## License

MIT
