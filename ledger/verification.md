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

## Issue #8 implementation — 2026-08-12

- Commands: `git diff --check`, `sh -n scripts/smoke-macos-launchagent.sh`, and `npm run check`.
- Result: pass; 82 tests, 0 failures.
- Configuration fixtures: version requirement, unknown keys, numeric and loopback boundaries, CLI > environment > file > defaults precedence, source-aware relative paths, canonical origins, adapter selection, and control-socket requirements.
- State fixtures: owner-only atomic config/token files, non-empty 256-bit tokens, stopped-only rotation, symbolic-link rejection, live/stale lock handling, inode and instance-ID release ownership, and malformed-config stop recovery.
- Lifecycle fixtures: explicit foreground versus service commands, startup cleanup and port-conflict diagnostics, token-free escaped plist generation, mocked install/start/status/stop/restart/uninstall, state preservation, and unchanged existing LaunchAgents directory permissions.
- Real macOS smoke: an isolated temporary HOME passed LaunchAgent install, start, healthy status, stop, restart, healthy status, stop, and managed uninstall. Configuration and token survived uninstall; the service was confirmed unloaded and all temporary state was removed.
- Independent completion review: Adviser (`gpt-5.6-sol`, medium caller to high reviewer) found no Issue #8 PR blocker. It confirmed source-tree path stability belongs to #10 and structured operations diagnostics belong to #9.

## Issue #9 implementation — 2026-08-12

- Commands: `git diff --check`, `npm run check`, `npm run soak`, and isolated macOS LaunchAgent lifecycle smoke.
- Result: pass; 100 tests, 0 failures.
- Bounded operations fixtures: central credential/content/path redaction; 16 KiB records; 200-record diagnostics ring; 1 MiB JSONL rotation with three generations; fixed metric names, label values, series, and cumulative buckets; 64-event/256 KiB SSE queues; 32 per-agent and 256 global action slots.
- Fault injection: adapter discovery failures/timeouts/disconnects and recovery; child-process exits with a peak of one tracked child; slow SSE writers; queued and active actions during shutdown; and logger EACCES, ENOSPC, and rotation rename failures. Logger sink failures stay in the bounded in-memory diagnostics state, pause retries, and do not escape or recursively log through the failed sink.
- Diagnostics fixtures: authenticated live snapshots and owner-only offline bundles include versions, allowlisted configuration, lifecycle/adapter health, bounded metrics, logging sink state, and recent logs, with credentials, prompts, private paths, URL secrets, and local home paths redacted.
- Full accelerated soak: 28,800 one-second cycles with 1,000 agents passed. Final bounds were 200 recent logs, 7 metric series, 64 maximum pending SSE events, 1 maximum queued action, 0 final handles, 0 final child processes, and 1 peak child process across 43 injected restarts. Heap grew 10,462,016 bytes with a late-cycle slope of 356.83 bytes/cycle; RSS plateaued around 194–214 MiB after expansion.
- Real service recovery: an isolated macOS LaunchAgent install/start/status/stop/restart/uninstall smoke passed with separate application and launchd console logs; the service was confirmed unloaded and temporary state removed.
- Independent review: Adviser (`gpt-5.6-sol`, medium caller to high reviewer) recommended the component boundaries and fixed resource ceilings before implementation. Completion review found logging sink fault coverage as the only blocker; the three fault-injection cases above were added before the final check and soak reruns. Packaging, upgrade, and rollback remain explicitly scoped to Issue #10.

## Issue #10 implementation — 2026-08-12

- Commands: `npm run check`, `git diff --check`, workflow YAML parsing, pinned-dashboard `npm ci && npm run check`, `node scripts/build-release.js`, `shasum -a 256 -c checksums.txt`, extracted install/version checks, dashboard live conformance, and an isolated real macOS LaunchAgent lifecycle smoke.
- Host result: 110 tests passed, 0 failed on Node 24 locally; CI defines the same check on Node 22, 23, and 24.
- Pinned dashboard result: exact commit `f641cb09e144490297fb3fe6759bac42aeb8e799` passed 158 tests, strict type checking, and its production Vite build. Its live conformance runner passed against the extracted candidate (`apiVersion=1`, six demo agents, one healthy adapter, semantic action/SSE revision advancement, and invalid-token rejection).
- Candidate artifact: `agent-host-0.3.0.tar.gz` SHA-256 `aa8bd15f95b7b42eef07573e23f6d9289113ee8d1b61c63667dbade7fae6ceef`. Checksums for the archive, external compatibility manifest, and SPDX SBOM passed. The artifact contains 40 allowlisted runtime files and built dashboard assets; source tests, fixtures, ledgers, `.git`, `.env`, logs, tokens, and local user paths are excluded or rejected by the build scan.
- Lifecycle fixtures: clean install, synthetic 0.2.0 -> 0.3.0 update, explicit rollback, uninstall with `~/.agent-host` preservation, stable launcher generation, version/API/config/dashboard reporting, ownership-safe stale install-lock recovery, competing recovery rejection, and automatic pointer/state restoration after activation failure. Failed restoration retains its durable transaction marker and the next invocation recovers it before proceeding.
- Security/failure fixtures: unsupported Node, incompatible dashboard API, version traversal, symlinks, extra files, modified file checksums, unsafe install roots, unmanaged launchers/plists, static-file symlinks, unauthenticated same-origin API aliases, and failed LaunchAgent reload with old-plist restoration. Node 26 was rejected with the documented Node 22–24 remediation.
- Real macOS artifact smoke: the extracted stable launcher passed init, LaunchAgent install, start, healthy status, stop, restart, healthy status, stop, and uninstall in an isolated temporary HOME. The service was confirmed unloaded, configuration/token preservation was observed before cleanup, and temporary state was removed.
- Release automation: PR CI builds and verifies the pinned integrated candidate plus live cross-repository contract; tag CI checks tag/package/manifest/changelog alignment, repeats host/dashboard/artifact checks, produces SHA-256/SBOM/build provenance, and publishes release files. No tag or GitHub Release was created because merging and release publication remain user-gated.
- Limitation: no previous GitHub release exists, so the first release verifies upgrade/rollback through a synthetic prior artifact and mocked source-installed plist replacement rather than a published predecessor. Starting with the next release, CI must download and exercise the actual previous published artifact.
- Independent review: Adviser identified two rounds of transactional recovery races. The final owned-directory lock uses deterministic inode quarantine for atomic stale takeover and identity-checked cleanup; transaction cleanup failures retain a consistent committed state plus a durable marker for next-run recovery. Targeted installation tests passed 5/5 and final completion re-review returned GO with no remaining Issue #10 blocker.
