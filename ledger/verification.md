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
- Tests: 35 passed, 0 failed
- Recorded scale fixture: 1,000 Codex threads + 108 process records + 8 Herdr agents = 1,116 raw records; the default recent view returns 26 records and a smaller 200-limit payload, while 990 historical Codex records remain explicitly pageable.
- Codex fixtures: normal discovery performs one bounded request, history is separately bounded, provider activity becomes ISO `lastActivityAt`, and `notLoaded` remains `unknown`.
- Process fixtures: direct executables are high confidence; wrappers, helpers, and search commands are excluded or raw-only; no process record advertises interrupt.
- Reconciliation fixtures: exact same-provider PID duplicates link through `duplicateOf`, while same-cwd/different-PID records remain distinct; history caching does not change the live revision or emit lifecycle events.
- Independent review: Adviser rejected permanent history mode, `notLoaded => done`, and implicit process interruption. The implementation uses an isolated history cache/revision, separates visibility from runtime status, and leaves destructive process control disabled.
