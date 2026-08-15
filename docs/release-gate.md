# Integrated v0.3.0 release gate

Snapshot: 2026-08-12. This document evaluates the backend-owned evidence for
[Issue #11](https://github.com/s-hiraoku/agent-host/issues/11). `PASS` means the
criterion has reproducible evidence, `PARTIAL` means only candidate or automated
evidence exists, and `BLOCKED` requires a published release, a real provider, a
machine restart, or independent daily use.

## Decision

The integrated artifact is suitable for controlled MVP evaluation that excludes
file-change approvals, global sort/facets, and stable project-scoped association,
but the stable daily-driver release is **NO-GO**. PRs
[#19](https://github.com/s-hiraoku/agent-host/pull/19) and
[#20](https://github.com/s-hiraoku/agent-host/pull/20) are still open, no `v0.3.0`
release has been published, and the real-environment gates below have not been run.
Issue #11 must remain open.

## Acceptance matrix

| Area | Criterion | Status | Evidence or remaining gate |
| --- | --- | --- | --- |
| Setup | Install the released host and dashboard on a clean supported Mac without cloning | BLOCKED | The integrated candidate installs from an extracted archive, but no GitHub Release exists yet. Repeat on a clean Mac using only published files. |
| Setup | New user reaches the first agent within ten minutes | BLOCKED | Instructions exist in [install.md](install.md); an independent timed run is required. |
| Setup | Start, stop, status, restart, update, rollback, and uninstall | PARTIAL | Real isolated macOS candidate smoke covers the service lifecycle and uninstall. Automated release tests cover update and rollback, including recovery faults. Repeat the complete workflow with published artifacts. |
| Setup | Auto-start survives a machine restart | BLOCKED | The generated LaunchAgent uses `RunAtLoad` and `KeepAlive`, but no reboot/login-cycle result is recorded. |
| Setup | Secrets use documented safe permissions | PASS | Owner-only token/config/diagnostics tests, symlink rejection, stopped-only token rotation, and memory-only dashboard onboarding pass. See [install.md](install.md). |
| Agents | Real Herdr discovery, detail, prompt, interrupt, focus, and read | BLOCKED | Adapter fixtures pass, but no recorded real Herdr action smoke covers the complete list. |
| Agents | Supported live Codex session without duplicate history/process records | PARTIAL | A real Codex 0.144.6 control-socket smoke verified live and persisted lists; deduplication is fixture-tested. Repeat with the release candidate during normal work. |
| Agents | Codex prompt, steer, interrupt, completion, failure, and approvals | PARTIAL | Protocol and race fixtures cover the semantic flows. The host now exposes fail-closed sanitized file-change context, but the pinned dashboard has not adopted it and the real smoke did not cover every action/state. |
| Agents | Unsupported providers remain detection-only | PASS | Process records never advertise semantic control; capability-denial and reconciliation fixtures pass. |
| Agents | Adapter failure/recovery is visible and actionable | PASS | Circuit, timeout, recovery, diagnostics, metrics, and semantic health-event tests pass; the dashboard's adapter-failure scenario passes conformance. |
| Client | Search, filtering, pagination, details, live updates, and actions at 1,000 agents | PARTIAL | The pinned dashboard CI performance, browser E2E, unit, and live-conformance jobs pass against the 1,000-agent contract. The host now publishes global sort, revision-consistent facets, project IDs, and fail-closed file-change context, but the pinned dashboard must adopt and verify them. |
| Client | Error and lifecycle states are understandable | PASS | The pinned dashboard CI covers blocked, completed, error, disconnected, stale, unauthorized, and incompatible states. |
| Client | Reconnect and event-gap recovery preserve context and avoid duplicate actions | PASS | Host SSE/idempotency tests and dashboard E2E/conformance pass. Clients resnapshot after a gap because v1 deliberately has no replay log. |
| Client | Preferences survive restart without insecure token/session persistence | PASS | Dashboard persistence and security tests pass; the token remains memory-only and is not embedded in built assets. |
| Client | Critical keyboard and accessibility workflows | PASS | The pinned dashboard accessibility job passes, including its browser workflow checks. |
| Safety | Origin, authentication, content type, body size, audit, and token rotation | PASS | Host security and lifecycle suites pass, including alias-route authentication and static-asset isolation. |
| Safety | Slow adapters and SSE clients remain bounded | PASS | Single-flight discovery, timeout/circuit, and 64-event/256 KiB SSE backpressure tests pass. |
| Safety | Overnight-equivalent soak remains bounded | PASS | The 28,800-cycle accelerated soak finished with bounded logs, metrics, SSE and action queues, zero final handles/children, and no unbounded late heap trend. |
| Safety | Diagnostics are useful and redact secrets/private content | PASS | Authenticated and offline diagnostics, fixed field allowlists, central redaction, rotation, and EACCES/ENOSPC/rename degradation tests pass. |
| Safety | Shutdown during refresh, actions, approval, and SSE is clean | PASS | Deadline, abort, queued/active action, adapter, listener, and slow-writer shutdown fixtures pass. |
| Release | Both repositories pass required automated checks | PASS | The [pinned dashboard CI](https://github.com/s-hiraoku/agent-host-dashboard/actions/runs/31591117758) and [Issue #11 host CI](https://github.com/s-hiraoku/agent-host/actions/runs/31596025732) are green. The host run covers Node 22/23/24, the pinned integrated artifact, extracted installation, and live cross-repository conformance. |
| Release | Host/dashboard/API versions are pinned or negotiated | PASS | [compatibility.md](compatibility.md) and `release-compatibility.json` pin product, API, config, Node, adapter, and exact dashboard commit versions. |
| Release | Install, upgrade, incompatibility, rollback, and uninstall use release artifacts | PARTIAL | Extracted candidate and synthetic 0.2.0-to-0.3.0 fixtures pass. There is no prior published release, so the first historical upgrade baseline starts with v0.3.0. |
| Release | Notes include limitations and supported versions | PASS | `CHANGELOG.md`, [compatibility.md](compatibility.md), and the limitations below record supported versions, dashboard contract adoption, platform, provider, SSE, token, project-ID, and first-upgrade boundaries. |
| Release | A release candidate succeeds in normal daily work | BLOCKED | Requires user-owned normal work after an RC is published; automated demo and isolated smoke runs do not satisfy this gate. |

## Reproducible evidence

- Host verification details, exact fixture counts, soak measurements, injected
  failures, real Codex transport smoke, real LaunchAgent smokes, artifact checksum,
  and the first-release upgrade limitation are recorded in the
  [repository verification ledger](https://github.com/s-hiraoku/agent-host/blob/main/ledger/verification.md).
- The pinned dashboard commit is
  `f641cb09e144490297fb3fe6759bac42aeb8e799`. Its CI run passed build/unit,
  browser E2E, accessibility, performance, contract, and live conformance.
- That performance run recorded 385 ms to ready, 66 ms to filter, 108 ms to select,
  960 DOM elements, and 50 rendered rows for the 1,000-agent fixture. Production
  assets totalled 247,652 bytes raw and 75,478 bytes gzip. The measurements are
  attached to the pinned dashboard CI run and reproduced by its
  `e2e/performance.spec.ts` and `scripts/check-assets.mjs` gates.
- PR #20 builds that exact dashboard commit, bundles it with the host, verifies
  checksums, installs the extracted artifact, starts the stable launcher, and runs
  the dashboard's live HTTP/SSE conformance suite against it.
- The Issue #10 candidate archive was
  `agent-host-0.3.0.tar.gz`, SHA-256
  `aa8bd15f95b7b42eef07573e23f6d9289113ee8d1b61c63667dbade7fae6ceef`.
  Issue #11 changes supersede it; its final candidate hash belongs in the verification
  ledger or CI artifact metadata rather than this packaged document. Neither archive
  is a published release asset.

## Required external close-out

1. Review and merge PRs #19 and #20 in dependency order, then close their issues.
2. Publish a v0.3.0 release candidate with archive, checksums, SPDX SBOM, and build
   provenance; do not publish stable yet.
3. On a clean supported Mac, use only the published instructions and assets to time
   first-agent setup, run the full lifecycle, and verify auto-start after restart.
4. Update the pinned dashboard to consume and verify the host's allowlisted global
   sorting, revision-consistent provider/status facets, sanitized file-change approval
   context, and stable local project association. Verify the file-approval public
   context before attempting the real Codex approval flow.
5. Record real Herdr actions and real Codex prompt/steer/interrupt/completion/failure/
   approval flows through the integrated dashboard.
6. Use the RC for normal daily work, record problems and limitations, rerun both
   repositories' final CI, then make the stable-release decision.

## Known limitations

- The archive is a Node.js source distribution, not an Apple-signed application;
  Node 22, 23, or 24 must already be installed.
- The managed background service is macOS LaunchAgent-specific. Foreground serving
  is portable, but other service managers are not included.
- Herdr semantic approve/reject is not supported. Providers without an explicit safe
  control transport are detection-only.
- The host candidate now exposes global sort, revision-consistent facets, sanitized
  file-change approval context, and stable local project IDs. The pinned dashboard
  predates that additive contract and must not claim those workflows until it consumes
  and verifies the new fields.
- Local project IDs group equal normalized working directories on one machine. They do
  not identify a remote repository or remain stable if that directory is moved.
- Shared Codex control requires an explicitly configured Unix socket. The host does
  not discover or manage another App Server.
- SSE v1 has no replay log. A reconnect or sequence gap requires a fresh snapshot.
- Dashboard onboarding keeps the bearer token in memory only, so the user must enter
  it again after a page reload.
- Because no predecessor release exists, v0.3.0 uses a synthetic prior artifact for
  upgrade/rollback tests. The next release must test the actual published v0.3.0
  artifact.
