# Compatibility policy

The product release, HTTP/SSE API, configuration schema, dashboard, and adapter tools have independent versions. `release-compatibility.json` is the machine-readable source of truth for a release.

- Product releases follow SemVer. Before 1.0, a minor release may contain product-level breaking changes, but it does not silently change an existing wire API.
- API v1 permits additive optional fields and event types. Clients ignore unknown fields/events. Removing or changing existing fields, semantics, authentication, ordering, pagination, or replay guarantees requires a new `/v2` contract.
- Configuration schema 1 remains unchanged in 0.3.0. Future migrations are ordered `N -> N+1` transformations, written atomically after a private backup. Rollback restores the backup only when the post-migration file hash is unchanged; otherwise it stops with manual remediation instructions.
- A deprecated API remains available for at least two minor releases or 90 days, whichever is longer, except for urgent security removal. Deprecations appear in the changelog and response documentation.
- The integrated dashboard is built from the exact commit in the manifest. Build and runtime discovery fail when the host and dashboard have no API version in common.

Supported runtime range: Node 22–24. The currently verified adapters are Codex CLI 0.144.6 and Herdr 0.7.5; the narrow manifest ranges are provisional until additional real-version smoke evidence exists. Unsupported optional adapters must not prevent the host or other adapters from operating.
