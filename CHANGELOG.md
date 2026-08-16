# Changelog

This project follows [Semantic Versioning](https://semver.org/). Breaking wire changes use a new API path instead of silently changing an existing API version.

## Unreleased

- Add an opt-in, read-only `cursor-desktop` adapter for bounded discovery and safe text reads from local Cursor desktop artifacts.
- Add fail-closed duplicate, partial, corrupt, symlink, ownership, size, and scan-limit handling; no Cursor mutation capability is advertised.
- Add optional low-confidence `workspaceCandidate` metadata to API v1 summaries and details.

## 0.3.0 - 2026-08-12

- Add the versioned v1 HTTP/SSE contract, secure browser action API, live Codex control, deterministic demo mode, and bounded discovery.
- Add strict configuration, private state, macOS LaunchAgent lifecycle, operational diagnostics, circuit recovery, backpressure, and accelerated soak coverage.
- Add an integrated host/dashboard release artifact, stable versioned installation layout, atomic update/rollback pointer, checksums, SBOM, and release CI.
- Add allowlisted global agent sorting, revision-consistent provider/status facets, stable local project associations, and fail-closed sanitized file-change approval context to API v1.

Known limitations: macOS LaunchAgent automation is the only managed background-service integration. Codex 0.144.6 and Herdr 0.7.5 are the currently verified adapter versions. The pinned dashboard predates the additive sort/facet/project/file-approval fields and must not claim those workflows until it adopts and verifies them. Local project IDs do not identify remote repositories and change when the working directory moves. Published-release upgrade evidence begins after the first v0.3.0 release is created.
