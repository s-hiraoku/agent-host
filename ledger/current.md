# Current objective

Deliver the `agent-host` backend roadmap in dependency order from GitHub issues #2 through #10, with focused ready-for-review pull requests, local and CI verification, review follow-up, and a final integrated daily-driver release assessment against issue #11. The dashboard repository is owned by another agent and is out of scope here except for documented API compatibility and integration dependencies.

## Success criteria

- Issues #2 through #10 are implemented or have a concrete externally owned blocker.
- Each coherent change is delivered through a regular ready-for-review PR.
- Tests, documentation, CI, and review threads are complete for every delivered PR.
- Backend evidence required by issue #11 is recorded and linked.
- No PR is merged without explicit user authorization.

## Plan

- [x] #2 Stable v1 API and semantic event contract
- [x] #3 Single-flight refresh and adapter health
- [x] #4 Secure browser-facing local action API
- [x] #5 Useful discovery defaults and deduplication
- [ ] #6 Demo adapter and conformance fixtures
- [ ] #7 Supported live-session integration
- [ ] #8 Configuration and service lifecycle
- [ ] #9 Operational resilience and diagnostics
- [ ] #10 Packaging, versioning, and updates
- [ ] #11 Backend portion of integrated release gate

## Current step

- Branch: `codex/issue-5-discovery-views`
- Issue: https://github.com/s-hiraoku/agent-host/issues/5
- Base PR: https://github.com/s-hiraoku/agent-host/pull/14
- Next: complete review and verification, then open a ready-for-review stacked PR against the Issue #4 branch.

## Progress notes

- 2026-08-09: Synchronized local `main` to merge commit `8baf8a1`, created the Issue #2 branch, and confirmed the baseline `npm run check` passes with 11 tests.
- 2026-08-09: Implemented the Issue #2 v1 summary/detail/action/error/event contracts, semantic revisions, bounded pagination and filters, documentation, and a 1,000-agent response-size fixture. Adviser completion review identified event coverage, deterministic ordering, an SSE subscription race, maximum-page verification, and compatibility documentation gaps; all were addressed. `npm run check` passes with 16 tests.
- 2026-08-09: Addressed all initial PR #12 feedback: SSE events now use controlled agent views, transient adapter failures retain last-known agents, malformed IDs and oversized bodies return stable 4xx errors, cwd cursor filters are normalized, and scale assertions are recorded. `npm run check` passes with 17 tests.
- 2026-08-09: Opened ready PR #12 for Issue #2. Implemented Issue #3 with single-flight concurrent refreshes, incremental healthy-adapter updates, bounded timeout/cancellation, retained last-good agents, adapter health/readiness APIs and events, prompt HTTP startup, and safe shutdown. Adviser review identified aggregate-apply latency and late-completion proof gaps; incremental apply plus timeout/shutdown/retry/listener-cleanup tests addressed them. After rebasing the PR #12 feedback fixes, `npm run check` passes with 26 tests.
- 2026-08-09: Opened ready PR #13 for Issue #3 and addressed its late timed-out-flight review finding. Implemented Issue #4 with loopback-only binding, bearer authentication for every `/v1/*` route, aggregate-only public readiness, exact Host/Origin checks, explicit CORS preflight, safe generated-token storage, bounded secret-free action audit events, mandatory idempotency keys, replay suppression, and per-agent action serialization. Six-pass security review findings and the PR review's slow-action TTL finding were incorporated; `npm run check` passes with 30 tests.
- 2026-08-09: Opened ready PR #14 for Issue #4 and resolved its idempotency TTL review finding. Implemented Issue #5 with recent/active/historical/raw views, 100-thread normal Codex discovery, a separate lazy history cache, provider activity timestamps, exact-PID rich/process reconciliation, raw-only low-confidence matches, deterministic activity sorting, and non-destructive process capabilities. A 1,116-record sanitized fixture reduces to 26 default records while retaining all raw records; `npm run check` passes with 35 tests.
