# Current objective

Deliver the `agent-host` backend roadmap in dependency order from GitHub issues #2 through #10, with focused ready-for-review pull requests, local and CI verification, review follow-up, and a final integrated daily-driver release assessment against issue #11. The dashboard repository is owned by another agent and is out of scope here except for documented API compatibility and integration dependencies.

## Success criteria

- Issues #2 through #10 are implemented or have a concrete externally owned blocker.
- Each coherent change is delivered through a regular ready-for-review PR.
- Tests, documentation, CI, and review threads are complete for every delivered PR.
- Backend evidence required by issue #11 is recorded and linked.
- No PR is merged without explicit user authorization.

## Plan

- [ ] #2 Stable v1 API and semantic event contract
- [ ] #3 Single-flight refresh and adapter health
- [ ] #4 Secure browser-facing local action API
- [ ] #5 Useful discovery defaults and deduplication
- [ ] #6 Demo adapter and conformance fixtures
- [ ] #7 Supported live-session integration
- [ ] #8 Configuration and service lifecycle
- [ ] #9 Operational resilience and diagnostics
- [ ] #10 Packaging, versioning, and updates
- [ ] #11 Backend portion of integrated release gate

## Current step

- Branch: `codex/issue-2-api-contract`
- Issue: https://github.com/s-hiraoku/agent-host/issues/2
- Next: commit the verified implementation, open a ready-for-review PR, and monitor CI/review feedback.

## Progress notes

- 2026-08-09: Synchronized local `main` to merge commit `8baf8a1`, created the Issue #2 branch, and confirmed the baseline `npm run check` passes with 11 tests.
- 2026-08-09: Implemented the Issue #2 v1 summary/detail/action/error/event contracts, semantic revisions, bounded pagination and filters, documentation, and a 1,000-agent response-size fixture. Adviser completion review identified event coverage, deterministic ordering, an SSE subscription race, maximum-page verification, and compatibility documentation gaps; all were addressed. `npm run check` passes with 16 tests.
- 2026-08-09: Addressed all initial PR #12 feedback: SSE events now use controlled agent views, transient adapter failures retain last-known agents, malformed IDs and oversized bodies return stable 4xx errors, cwd cursor filters are normalized, and scale assertions are recorded. `npm run check` passes with 17 tests.
