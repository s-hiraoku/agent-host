# Decisions

## 2026-08-09

- Deliver backend work as dependency-ordered focused PRs instead of one cross-cutting PR.
- Keep dashboard implementation out of this repository; expose a provider-neutral versioned HTTP/SSE contract instead.
- Start with issue #2 because refresh health, browser security, discovery defaults, fixtures, and dashboard integration depend on the API/event contract.
- Use GitHub issue #11 as the cross-repository daily-driver release gate.
- Treat provider-native metadata as non-semantic and non-public. Adapter authors must lift client-visible mutable state into canonical fields.
- Use a snapshot `revision` for pagination consistency and a separate event `sequence` for ordered SSE delivery.
- Keep successful action result core fields provider-neutral while treating optional `data` as an opaque adapter extension.
- Define readiness as "the bounded initial refresh cycle completed"; adapter failures make readiness degraded but do not make the usable local API permanently unready.
- Apply each adapter's successful discovery as soon as it completes instead of waiting for the slowest adapter's timeout.
- Abort cooperative discovery on timeout. Keep a non-cooperative timed-out flight tracked until it settles so refresh timers cannot duplicate it, and ignore its late result.
- Keep `/health` and aggregate `/ready` public, but require a bearer token for every `/v1/*` route so agent paths and adapter diagnostics are not exposed to other local processes.
- Reject non-loopback service binding and cross-origin browser requests by default. Allow dashboard origins only through an exact runtime allowlist.
- Persist an auto-generated token atomically in an owner-only file instead of printing it to service logs.
- Require an idempotency key on every action, cache in-flight/completed results for a bounded TTL, and serialize actions per agent so dashboard retries and double-clicks cannot duplicate or race mutations.
- Make `recent` the default discovery view; expose `active`, `historical`, and `raw` explicitly without ever serializing provider metadata.
- Keep normal Codex discovery at one recency-sorted page of 100 threads. Load up to 1,000 history records only on explicit historical/raw requests into a separate TTL cache with an independent cursor revision and no lifecycle-event burst.
- Treat Codex `notLoaded` as unknown state, not completion, and classify recency separately from runtime status using provider timestamps.
- Never advertise process interrupt by default. Keep loose command matches raw-only and suppress process/rich duplicates only on exact same-provider PID correlation.
- Track raw snapshot revisions separately so raw-only process changes invalidate raw cursors without emitting normal lifecycle events. Overlay current records on cached history and invalidate historical cursors only when a history-linked live record changes.

# Issue #6 decisions

- Demo mode is an isolated runtime composition, not an extra adapter alongside live
  discovery. This keeps demonstrations deterministic and prevents private sessions
  from appearing in dashboard screenshots or fixture capture.
- Demo state changes remain subject to the same registry refresh boundary as real
  adapters: actions emit `agent.action`, and the following refresh emits the semantic
  `agent.updated`. The conformance runner proves this public contract instead of adding
  demo-only behavior to the registry.
- SSE remains non-replayable in v1. The reconnect fixture requires clients to compare
  the new `ready` revision/sequence and replace their snapshot after a disconnect or
  gap, avoiding a false replay guarantee that the event bus cannot provide.
- Client fixtures use fictional `demo:*` identifiers, fixed timestamps, and no cwd,
  session payload, metadata, credentials, or personal data. The large fixture is
  generated deterministically and checked in so non-Node clients can consume it.

# Issue #7 decisions

- Define the supported external Codex boundary as clients sharing one explicitly
  configured App Server Unix control socket. Require `AGENT_HOST_CODEX_TRANSPORT=control`
  plus an absolute `AGENT_HOST_CODEX_SOCKET`; do not discover sockets, support network
  URLs, or manage the external daemon lifecycle.
- Subscribe only to IDs returned by `thread/loaded/list`. Persisted-only records remain
  visible without actions, and per-thread resume failures do not degrade unrelated
  loaded threads.
- Model provenance as `owned-app-server` or `shared-control-socket`, not session or
  approval ownership. Shared approvals are generation-scoped, first-response-wins
  interactions; agent-host never auto-cancels expired shared approvals or answers
  unsupported shared server requests.
- Treat the connection generation as the validity boundary for RPC responses,
  notifications, subscriptions, discovery results, and approval IDs. Disconnects
  preserve identity but atomically set status to unknown and disable every action.
- In control mode, keep process-detected Codex records raw-only. This prevents a second
  canonical record for the configured live transport while retaining unsupported
  process evidence in the explicit raw view.
