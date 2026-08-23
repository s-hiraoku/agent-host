# Compatibility policy

The product release, HTTP/SSE API, configuration schema, dashboard, and adapter tools have independent versions. `release-compatibility.json` is the machine-readable source of truth for a release.

- Product releases follow SemVer. Before 1.0, a minor release may contain product-level breaking changes, but it does not silently change an existing wire API.
- API v1 permits additive optional fields and event types. Clients ignore unknown fields/events. Removing or changing existing fields, semantics, authentication, ordering, pagination, or replay guarantees requires a new `/v2` contract.
- API v1 list queries support allowlisted global sorting and return facet counts tied to the same opaque view revision as the page. Optional `project` associations and sanitized approval `context` are additive; clients must treat `actionable: false` approvals as display-only and never infer provider-native data.
- API v1 includes an additive authenticated launch extension discovered through
  `capabilities.launches`. Its request, risk-confirmation, durable state, error, and
  `launch.updated` event meanings are part of the v1 compatibility boundary. Providers
  and modes remain optional; clients must not infer launch support from discovery.
- Configuration schema 1 remains unchanged in 0.3.0. Future migrations are ordered `N -> N+1` transformations, written atomically after a private backup. Rollback restores the backup only when the post-migration file hash is unchanged; otherwise it stops with manual remediation instructions.
- A deprecated API remains available for at least two minor releases or 90 days, whichever is longer, except for urgent security removal. Deprecations appear in the changelog and response documentation.
- The integrated dashboard is built from the exact commit in the manifest. Build and runtime discovery fail when the host and dashboard have no API version in common.

Supported runtime range: Node 22–24. The currently verified adapters are Codex CLI
0.144.6–0.147.0, Herdr 0.7.5, and the read-only Cursor desktop artifact schema observed
in Cursor 3.15.19 on macOS. Codex 0.144.6 remains the control-socket protocol smoke;
0.147.0 was confirmed healthy in host-owned App Server dogfood. The Cursor adapter is opt-in and depends on `node:sqlite`, which was added in Node 22.5 and no longer requires the experimental flag from Node 22.13. On older Node 22 minors the optional adapter reports `cursor_sqlite_unavailable`; it does not prevent the host or other adapters from operating. Cursor's artifact format is not a public compatibility API, so schema changes may degrade sessions to `unknown`, disable `read`, or mark the adapter unavailable rather than guessing.

The Cursor adapter does not attach to live IDE agent sessions and cannot claim semantic
control. On macOS it may advertise app-level `focus` when `Cursor.app` is installed;
that action activates the application and does not target a conversation. The process
adapter may advertise the same app-level `focus` for running `Claude.app` and
`ChatGPT.app` main processes only. Its
`workspaceCandidate` is Cursor's encoded local project key with low
confidence, not a verified cwd or repository association. `raw` view still exposes only
the normalized v1 agent model, never raw Cursor artifacts.

One configured/default Cursor profile is supported per agent-host process. Artifact roots,
directories, files, ownership, containment, and final-file no-follow behavior are checked,
but same-user path replacement remains outside the threat model because Node does not expose
the required descriptor-relative traversal for eliminating that TOCTOU class portably.

The opt-in `cursor-sdk-bridge` adapter supports only agent-host-owned local agents over an
explicit, operator-managed official `sdk.v1` Bridge. It pins and probes the exact Bridge
version, accepts literal loopback origins only, and uses the durable owned-discovery
boundary. No Cursor package or binary is shipped. SDK agents are not correlated with
existing desktop conversations. Prompt is limited to a currently owned local agent and,
after the first run, requires exact terminal-run proof. Interrupt is advertised only for
the exact durable run ID observed from that prompt's Bridge stream and revalidated as
running, including after Agent Host restart. A durable run-scoped fence prevents repeated
cancellation after an accepted or ambiguous result. Read is limited to the exact terminal run ID durably bound to
that owned agent after an Agent Host prompt; it returns bounded user/assistant text only.
It does not list, infer, or stream runs and cannot read arbitrary existing Cursor desktop
sessions. Approval, focus, archive, delete, and cloud mode are not advertised. See
`docs/cursor-sdk-adapter.md` and `docs/spikes/cursor-sdk.md`.
