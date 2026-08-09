# Verification

## Baseline — 2026-08-09

- Command: `npm run check`
- Result: pass
- Tests: 11 passed, 0 failed
- Branch before implementation: `codex/issue-2-api-contract`

## Issue #2 implementation — 2026-08-09

- Command: `git diff --check && npm run check`
- Result: pass
- Tests: 16 passed, 0 failed
- Scale fixture: `keeps the default list response bounded with 1,000 agents` in `test/server.test.js` uses 10 KB provider metadata per agent and asserts `Buffer.byteLength(body) < 100_000` for 50 items and `< 400_000` for 200 items; both responses exclude metadata.
- Independent review: Adviser (`gpt-5.6-sol`, medium caller to high reviewer) found five actionable completion gaps; deterministic ID tie-breaks, listener-before-ready SSE ordering, direct event assertions, maximum-page measurement, and compatibility rules were added before rerunning checks.
- PR feedback rerun: `git diff --check && npm run check` passed with 17 tests after controlled SSE views, last-good adapter retention, malformed-ID validation, payload bounds, and cwd normalization.

## Issue #3 implementation — 2026-08-09

- Command: `git diff --check && npm run check`
- Result: pass
- Tests: 26 passed, 0 failed after rebasing the PR #12 feedback fixes
- Concurrency fixtures: concurrent fast/slow adapters, exact refresh coalescing, non-cooperative timeout without duplicate discovery, healthy visibility before slow completion, and timer max-active count of one.
- Lifecycle fixtures: cooperative abort, non-cooperative late timeout and shutdown completion suppression, retry after settled timeout, and Codex RPC AbortSignal listener cleanup on success/error/abort.
- HTTP fixtures: listener-first liveness, initial `503` readiness, degraded `200` readiness, and controlled adapter-health response.
- Independent review: Adviser (`gpt-5.6-sol`, medium caller to high reviewer) identified aggregate-apply latency, late-result mutation, retry, and cleanup evidence gaps. The implementation was changed to per-adapter incremental apply and all completion checks were added before the final 26-test rerun.

## Issue #4 implementation — 2026-08-09

- Command: `git diff --check && npm run check`
- Result: pass
- Tests: 30 passed, 0 failed
- Authentication fixtures: missing/invalid bearer credentials, protected list/detail/adapter/action routes, and aggregate-only public readiness.
- Browser-boundary fixtures: exact same-origin and allowlisted-origin success, default-deny and explicitly denied origins, invalid Host, bracketed IPv6 loopback, valid preflight, and disallowed preflight headers.
- Mutation fixtures: required idempotency keys, identical replay suppression, conflicting payload rejection, per-agent serialization, post-settlement TTL for slow actions, and stable media/body errors.
- Audit fixtures: exactly paired authenticated action attempts/completions, no events from rejected unauthenticated or cross-origin requests, and no token or request-body content in events.
- Independent review: six security specialists reviewed injection, authentication/authorization, secrets, business logic/races, infrastructure/network boundaries, and supply chain. Findings covering public reconnaissance, audit flooding, token logging, IPv6 Host handling, replay/race behavior, and deployment documentation were addressed; injection and supply-chain passes had no findings.

## Issue #5 implementation — 2026-08-09

- Command: `git diff --check && npm run check`
- Result: pass
- Tests: 38 passed, 0 failed
- Recorded scale fixture: 1,000 Codex threads + 108 process records + 8 Herdr agents = 1,116 raw records; the default recent view returns 26 records and a smaller 200-limit payload, while 990 historical Codex records remain explicitly pageable.
- Codex fixtures: normal discovery performs one bounded request, history is separately bounded, provider activity becomes ISO `lastActivityAt`, and `notLoaded` remains `unknown`.
- Process fixtures: direct executables are high confidence; wrappers, helpers, and search commands are excluded or raw-only; no process record advertises interrupt.
- Reconciliation fixtures: exact same-provider PID duplicates link through `duplicateOf`, while same-cwd/different-PID records remain distinct; history caching does not change the live revision or emit lifecycle events.
- Independent review: Adviser rejected permanent history mode, `notLoaded => done`, and implicit process interruption. The implementation uses an isolated history cache/revision, separates visibility from runtime status, and leaves destructive process control disabled.
- PR Guardian follow-up: added invalid timeout configuration coverage, proved raw-only changes advance raw cursor revisions, and proved cached historical records are overlaid by live state while unrelated live changes do not invalidate historical pagination.
- Current-head bot review follow-up: validated history TTL configuration, immediate retry after failed history loads, live-only historical cursor invalidation, case-insensitive Bearer scheme parsing, canonical origin configuration errors, defensive Codex result truncation, environment-prefixed process classification, immutable list-cache results, and deterministic idempotency TTL timing.

## Issue #6 implementation — 2026-08-09

- Commands: `npm run fixtures:generate`, `git diff --check`, `npm run check`, and `npm run conformance`
- Result: pass
- Tests: 43 passed, 0 failed.
- Demo fixtures: all six stable statuses, read-only/promptable/interruptible/approval-blocked capability combinations, fixed timestamps, and deterministic prompt/interrupt/approve/reject transitions.
- Client conformance: a reusable runner validates a live demo server's bounded raw snapshot, approval detail, authenticated idempotent action, `audit.action` / `agent.action` / `agent.updated` events, structured error, and SSE reconnect ready state.
- Privacy/schema: seven versioned JSON fixtures are parsed and scanned for personal local paths, bearer credentials, token/session content, cwd, and raw metadata. The scale fixture contains exactly 1,000 unique schema-compatible agents.
- One-command smoke test: `npm run demo` listened on loopback with only the demo adapter; an authenticated raw snapshot returned six agents and all six normalized states. A supplied test token avoided touching the generated-token file.

## Issue #7 implementation — 2026-08-09

- Commands: `git diff --check` and `npm run check`
- Result: pass
- Tests: 61 passed, 0 failed.
- Transport fixtures: HTTP 101/accept validation, masked client frames, partial and
  fragmented text frames, combined frames, ping/pong, close, invalid handshake,
  oversized payload rejection, explicit proxy argv, and old-generation isolation.
- Live-session fixtures: string-valued loaded thread IDs from the official protocol,
  per-thread resume isolation, persisted-only capability gating, direct-input gating,
  notification-driven working/blocked/completed registry updates, generation-scoped
  approval correlation, stale discovery rejection, disconnect/reconnect, and raw-only
  process detection.
- Manual smoke: Codex CLI 0.144.6 served an isolated temporary `CODEX_HOME` over a Unix
  socket. A second control-proxy connection completed initialize, loaded-list, and
  persisted-list requests without stopping the App Server. The smoke exposed the
  official loaded-list string-ID shape, which was added to the adapter and tests. The
  temporary App Server and directory were stopped and removed; no user daemon or
  existing session was accessed.
- Independent review: Adviser (`gpt-5.6-sol`, medium caller to high reviewer) set the
  explicit-socket boundary and required generation scoping, stale capability removal,
  shared-approval semantics, action-time validation, raw-only unsupported processes,
  and WebSocket subset checks. Completion review then found action/reconnect, stream
  EOF, unload cleanup, direct-input fail-open, coalesced-handshake, and race-coverage
  gaps; all were fixed and covered before PR creation. A final follow-up identified
  uncertain `turn/steer` replay as the last blocker, so shared control now returns the
  failure without automatically resending the prompt as a new turn.
