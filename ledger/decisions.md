# Decisions

## Issue #34 decisions

- Keep launch creation separate from existing per-agent actions. `POST /v1/launches`
  accepts only advertised provider options and never treats prompt or discovery as an
  implicit create operation.
- Make the owner-only durable launch ledger authoritative. Persist `requested` before
  queueing and `creating` with a stable attempt ID before provider invocation; only a
  correlated provider ID and public agent ID can transition atomically to `owned`.
- Treat timeout, shutdown, transport loss, and restart from `creating` as `uncertain`.
  Reconcile through the provider attempt ID when supported and never blindly reissue an
  uncertain create. Reserve `failed` for an adapter's explicit proof of non-creation.
- Derive effective mutation and billing risk from normalized server-side capabilities,
  require an exact two-flag acknowledgement, and freeze the capability version and risk
  in the ledger so configuration drift cannot change an accepted request's meaning.
- Hash idempotency keys before persistence and retain bounded records instead of using a
  TTL that could silently permit duplicate agents or spend. Fail closed at 1,000 records
  or 32 unresolved `requested`, `creating`, or `uncertain` intents. Hold a separate
  race-aware single-writer lease for the ledger even though the normal service also owns
  its process lock.
- Separate `discoverOwned` from ordinary discovery. Registry supplies only ledger-owned
  records and rejects missing, duplicate, mismatched-source, or otherwise unproven agent
  results before they enter the public registry.
- Use a deterministic demo launch provider to prove local-mutation and external/billable
  confirmation paths, concurrency, restart recovery, and conformance without SDK code,
  credentials, workspace changes, external execution, or charges.
- Treat a provider's explicit `failed` as proof that the attempt has no side effect and
  no in-flight work, not merely as a missing lookup result. Keep a timed-out provider's
  scheduler lane and writer lease until its original promise settles; late results never
  rewrite the already-uncertain record.

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

# Issue #10 decisions

- Ship one integrated source release containing agent-host and only the built assets from an exact pinned dashboard commit. Keep dashboard source and implementation ownership in its separate repository.
- Serve packaged dashboard assets from the existing loopback listener and normalize same-origin `/agent-host/*` requests into the authenticated public API. Never inject the bearer token into built assets or a proxy.
- Separate immutable code under `~/.local/share/agent-host/releases/<version>` from mutable user state under `~/.agent-host`. Use an atomic `current` symlink and stable `~/.local/bin/agent-host` launcher for update and rollback.
- Keep product SemVer, wire API, configuration schema, dashboard version, and adapter compatibility independent in `release-compatibility.json`. Keep configuration schema 1 for 0.3.0 rather than inventing a migration.
- Treat the 0.3.0 archive as a source distribution with SHA-256, SPDX SBOM, GitHub build provenance, content allowlisting, and secret scanning. Do not claim Apple signing or notarization for a JavaScript/static archive.

# Issue #23 decisions

- Publish repository association as an independently versioned authenticated extension,
  discovered through `/v1/capabilities`, instead of adding an ambiguous optional field
  to the generic agent response.
- Keep the wire identity forge-neutral: `forge`, `host`, named or opaque coordinates,
  optional stable string ID, and a validated same-host HTTPS navigation URL. The
  dashboard adapter, not the host contract, maps supported forges to source-control clients.
- Treat adapter omission as `unsupported`; reserve `unavailable` for a supporting source's
  transient failure. Represent stale and partial data as ready results with explicit
  `freshness` and `complete` fields so usable associations are not discarded.
- Never infer an association from cwd, prompts, display names, provider metadata, or
  local Git state. Confirmed associations require high-confidence non-heuristic evidence;
  candidates remain explicit and cannot identify a pull request.
- Use a separate repository revision. Association-only changes do not advance the normal
  agent snapshot or emit an indistinguishable `agent.updated`; they emit a redacted
  invalidation event and require an authenticated no-store refetch.
- Keep SSE non-replayable. Clients subscribe before their first fetch and refetch after
  every reconnect or sequence gap; repository identity never appears in event payloads.
- Bound public results at 100, raw normalization work at 200, every public string and URL,
  and error output to machine-safe codes/counts. Worktree coordinates are opaque IDs, not paths.

# Issue #28 decisions

- Add `cursor-desktop` as an explicit opt-in artifact observer. Keep it out of the
  default adapter list, use no private IPC, and advertise no mutation capabilities.
- Read only Cursor's local-source conversation metadata plus project transcript JSONL.
  Validate ownership, regular-file type, size, and symlink boundaries for the database,
  WAL/SHM sidecars, project directories, and transcripts before opening them.
- Derive the public ID from a canonical profile-path hash plus Cursor's conversation UUID.
  Treat the profile hash as an isolation namespace, not a disclosed local path.
- Reconcile duplicate transcripts by canonical full-record hashes. Identical and strict
  prefix streams are readable from the longest copy; divergent, corrupt, or ambiguous
  streams become `unknown` and disable `read`. Recheck the same rules at read time.
- Publish only bounded user/assistant text. Omit tool inputs, tool results, provider
  metadata, terminal details, and local paths from the action result and operational logs.
- Infer `idle` or `error` only from a complete final terminal record. Partial streams and
  every uncertain state remain `unknown`; artifact observation never claims `working`.
- Expose Cursor's encoded project key only as a sanitized low-confidence
  `workspaceCandidate`. Do not present it as a verified cwd, repository, or worktree.
- Support one configured Cursor profile root per adapter instance in v1. Fail closed on
  format drift, scan-budget exhaustion, ownership mismatch, or duplicate ambiguity.

# Issue #32 decisions

- Keep `cursor-sdk:*` identities completely separate from `cursor-desktop:*`. The SDK
  surface creates or resumes SDK agents; it does not prove control of arbitrary existing
  Cursor IDE conversations.
- Do not build a production SDK adapter under the current action-only host API. Introduce
  a separately reviewed authenticated and idempotent launch contract before an adapter
  may create and advertise an owned agent.
- Treat the durable SDK agent as the public record and SDK runs as its turns. Bind status,
  read, prompt, and interrupt to an exact agent/run pair and a connection generation.
- Discover only IDs recorded in an agent-host-owned registry. Local mode must use an
  isolated explicit SDK store; cloud mode must carry an agent-host provenance marker.
- Keep both runtimes disabled by default. Local mode is workspace-mutating code execution;
  cloud mode is external and potentially billable. Neither may run during discovery.
- Never invoke interactive SDK login or persist Cursor credentials. Reapply pinned model
  and tool restrictions on every resume because SDK 1.0.28 does not persist them.
- Keep approve, reject, focus, arbitrary adoption, archive, and delete unavailable in an
  initial design. Capability proof is independent and fails closed on drift or replay gaps.
