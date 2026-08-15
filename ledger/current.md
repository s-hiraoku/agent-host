# Current objective

Publish Issue #23's stable, versioned, provider-neutral repository association contract as a focused ready-for-review pull request. Preserve explicit capability/state negotiation, bounded sanitized data, independent revision/SSE behavior, privacy, language-neutral fixtures, and live demo conformance. Do not merge without explicit user authorization.

## Success criteria

- Issue #23 capability, endpoint, adapter boundary, revision, and SSE semantics are documented and tested.
- Zero, one, multiple, private, candidate, stale, partial, unavailable, unsupported, and changed cases have sanitized fixtures.
- The live demo conformance client proves the authenticated host contract without provider-specific imports.
- The change is delivered through a regular ready-for-review PR with complete checks and review follow-up.
- No PR is merged without explicit user authorization.

## Plan

- [x] #2 Stable v1 API and semantic event contract
- [x] #3 Single-flight refresh and adapter health
- [x] #4 Secure browser-facing local action API
- [x] #5 Useful discovery defaults and deduplication
- [x] #6 Demo adapter and conformance fixtures
- [x] #7 Supported live-session integration
- [x] #8 Configuration and service lifecycle
- [x] #9 Operational resilience and diagnostics
- [x] #10 Packaging, versioning, and updates
- [x] Inspect Issue #23 and the dashboard `RepositoryContextSource` boundary
- [x] Define the repository association v1 contract and privacy/revision rules
- [x] Implement the contract, demo source, fixtures, conformance, tests, and documentation
- [ ] Verify, independently review, and open the ready PR
- [ ] Follow CI and review feedback through PR Guardian

## Current step

- Branch: `codex/issue-23-repository-associations`
- Issue: https://github.com/s-hiraoku/agent-host/issues/23
- Base: `main` at `2ae0b6a` (PR #22 merge)
- PR: https://github.com/s-hiraoku/agent-host/pull/25
- Next: audit current-head CI, bot/human feedback, and review threads; apply any actionable findings without merging.

## Progress notes

- 2026-08-09: Synchronized local `main` to merge commit `8baf8a1`, created the Issue #2 branch, and confirmed the baseline `npm run check` passes with 11 tests.
- 2026-08-09: Implemented the Issue #2 v1 summary/detail/action/error/event contracts, semantic revisions, bounded pagination and filters, documentation, and a 1,000-agent response-size fixture. Adviser completion review identified event coverage, deterministic ordering, an SSE subscription race, maximum-page verification, and compatibility documentation gaps; all were addressed. `npm run check` passes with 16 tests.
- 2026-08-09: Addressed all initial PR #12 feedback: SSE events now use controlled agent views, transient adapter failures retain last-known agents, malformed IDs and oversized bodies return stable 4xx errors, cwd cursor filters are normalized, and scale assertions are recorded. `npm run check` passes with 17 tests.
- 2026-08-09: Opened ready PR #12 for Issue #2. Implemented Issue #3 with single-flight concurrent refreshes, incremental healthy-adapter updates, bounded timeout/cancellation, retained last-good agents, adapter health/readiness APIs and events, prompt HTTP startup, and safe shutdown. Adviser review identified aggregate-apply latency and late-completion proof gaps; incremental apply plus timeout/shutdown/retry/listener-cleanup tests addressed them. After rebasing the PR #12 feedback fixes, `npm run check` passes with 26 tests.
- 2026-08-09: Opened ready PR #13 for Issue #3 and addressed its late timed-out-flight review finding. Implemented Issue #4 with loopback-only binding, bearer authentication for every `/v1/*` route, aggregate-only public readiness, exact Host/Origin checks, explicit CORS preflight, safe generated-token storage, bounded secret-free action audit events, mandatory idempotency keys, replay suppression, and per-agent action serialization. Six-pass security review findings and the PR review's slow-action TTL finding were incorporated; `npm run check` passes with 30 tests.
- 2026-08-09: Opened ready PR #14 for Issue #4 and resolved its idempotency TTL review finding. Implemented Issue #5 with recent/active/historical/raw views, 100-thread normal Codex discovery, a separate lazy history cache, provider activity timestamps, exact-PID rich/process reconciliation, raw-only low-confidence matches, deterministic activity sorting, and non-destructive process capabilities. A 1,116-record sanitized fixture reduces to 26 default records while retaining all raw records.
- 2026-08-09: PR Guardian found that #13 and #14 were merged into already-merged stacked branches rather than `main`, so PR #15 was rebased onto current `main` to carry Issues #3-#5 as the integration PR. It also found and addressed invalid adapter timeout configuration, raw-only cursor invalidation, and stale historical/live overlays. `npm run check` passes with 36 tests.
- 2026-08-09: Current-head Codex and CodeRabbit review added boundary findings covering live-only historical cursors, token-file replacement ordering, history retry TTL, Bearer scheme casing, configuration validation, bounded provider responses, and hot-path reconciliation. The fixes plus deterministic non-timing TTL coverage pass `npm run check` with 38 tests.
- 2026-08-09: Confirmed PR #15 merged into `main`, then implemented Issue #6 from that merge commit. Opt-in demo mode replaces all live adapters with six deterministic states, predictable prompt/interrupt/approval transitions, sanitized language-neutral fixtures, a checked-in 1,000-agent scale fixture, and a reusable live HTTP/SSE client conformance runner.
- 2026-08-09: Confirmed PR #16 merged into `main`, then implemented Issue #7. Explicit control mode connects through the official Codex Unix control proxy, subscribes loaded threads, propagates live status and approvals, scopes state/actions to connection generations, marks records stale on loss, and keeps unsupported Codex processes raw-only.
- 2026-08-12: Confirmed PR #17 merged as `187773c`, synchronized `main`, and created `codex/issue-8-service-lifecycle`. Began Issue #8 with a modular plan for configuration, secure state/token storage, instance ownership, testable CLI lifecycle commands, and a macOS LaunchAgent integration.
- 2026-08-12: Completed Issue #8 implementation: strict versioned configuration, secure token lifecycle, race-aware instance ownership, foreground and LaunchAgent lifecycle commands, selective adapters, documentation, and isolated service smoke coverage. The full 82-test suite and a real macOS launchctl install/start/status/stop/restart/uninstall smoke passed; the test service and temporary state were removed. Adviser completion review found no PR blocker and kept logging/diagnostics in #9 and installed-path stability in #10.
- 2026-08-12: Opened regular ready-for-review PR #18 for Issue #8. Merge remains gated on explicit user authorization.
- 2026-08-12: PR #18 is mergeable and its CodeRabbit status completed successfully, but the bot skipped an actual review due to its 58-minute usage limit; there are no review threads. Created dependent branch `codex/issue-9-operational-resilience` without merging. Issue #9 Adviser design review selected split redaction/logger/metrics/diagnostics components with fixed retention, circuit-breaker state in the registry, bounded SSE/action queues, deadline-bounded shutdown, and separate app JSONL versus LaunchAgent console logs.
- 2026-08-12: User merged PR #18 as `443461a`. Rebasing the Issue #9 branch onto that merge required no conflict; all in-progress #9 changes were preserved.
- 2026-08-12: Completed Issue #9 implementation with centrally redacted bounded JSONL logging and metrics, authenticated/offline diagnostics, per-adapter circuit backoff and recovery, bounded SSE/action queues, abort-aware actions, deadline-bounded shutdown, and an eight-hour-equivalent accelerated soak. Adviser completion review identified untested logging sink failures; EACCES, ENOSPC, and rotation-rename fault injection now proves failures degrade into bounded diagnostics rather than terminating the host. The final 100-test suite and 28,800-cycle soak pass.
- 2026-08-12: Opened regular ready-for-review PR #19 for Issue #9. Merge remains gated on explicit user authorization; packaging and upgrade work continues separately under Issue #10.
- 2026-08-12: Began Issue #10 on a dependent branch. Adviser review selected an integrated source artifact containing host plus built assets from a pinned dashboard commit, same-origin serving through the existing listener, immutable version directories behind an atomic pointer, a stable LaunchAgent launcher, checksums/SBOM/provenance, and transactional rollback while preserving `~/.agent-host` state.
- 2026-08-12: Completed Issue #10 implementation and candidate verification. The exact pinned dashboard commit passed 158 tests/build/live conformance; the host passed 110 tests; extracted-artifact install/version and real macOS LaunchAgent lifecycle passed. Adviser completion review found stale-lock takeover and transaction-cleanup recovery races; deterministic inode quarantine, ownership-safe release, durable recovery markers, Node 23 CI, and fault-injection tests resolved every blocker. Adviser re-review returned GO.
- 2026-08-12: Opened regular ready-for-review stacked PR #20 for Issue #10 with base PR #19. No release tag or GitHub Release was created; merging and publication remain explicitly user-gated.
- 2026-08-12: PR #20's first integrated-artifact run failed before dashboard checkout because escaped nested quotes made the compatibility-manifest shell expression invalid. A focused CI fix now passes Node 22/23/24 and the pinned-dashboard build, extracted install, and live conformance job at run 31594311951.
- 2026-08-12: Evaluated every Issue #11 acceptance item. Implemented the remaining additive backend contracts for global sort, revision-consistent facets, stable local project association, and fail-closed sanitized file-change approval context. Stable release remains NO-GO pending dashboard adoption and CI, dependency merges, a published RC, clean-Mac timed setup and reboot, complete real Herdr/Codex workflows, and normal daily use. The evidence and external close-out checklist are recorded in `docs/release-gate.md`.
- 2026-08-12: Opened regular ready-for-review stacked PR #21 for the Issue #11 backend contracts and release-gate evidence. Adviser returned GO after malicious-adapter, wrong-turn, path-safety, and bounded-state findings were fixed. Issue #11 deliberately remains open for dashboard adoption and real-environment release gates.
- 2026-08-15: Oriented Issue #23 against the current host API and dashboard `RepositoryContextSource`. Adviser design review led to explicit adapter unsupported/unavailable states, forge-neutral coordinates, a separate repository revision, redacted no-replay SSE invalidation, strict bounds, no-store responses, and worktree path rejection.
- 2026-08-15: Implemented the authenticated capability/detail contract, normalized adapter boundary, deterministic demo coverage, privacy-safe change event, language-neutral fixtures, live HTTP/SSE conformance, focused tests, and documentation. Full verification and completion review remain before PR creation.
- 2026-08-15: Final verification passed with 113 tests, 2 live conformance tests, and a 2,000-cycle/1,000-agent quick soak. A fresh Adviser completion review found no blocker; its documentation and prompt-independence follow-ups were applied and reverified. Opened regular ready-for-review PR #25; merge remains user-gated.
