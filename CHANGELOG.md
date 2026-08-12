# Changelog

This project follows [Semantic Versioning](https://semver.org/). Breaking wire changes use a new API path instead of silently changing an existing API version.

## 0.3.0 - 2026-08-12

- Add the versioned v1 HTTP/SSE contract, secure browser action API, live Codex control, deterministic demo mode, and bounded discovery.
- Add strict configuration, private state, macOS LaunchAgent lifecycle, operational diagnostics, circuit recovery, backpressure, and accelerated soak coverage.
- Add an integrated host/dashboard release artifact, stable versioned installation layout, atomic update/rollback pointer, checksums, SBOM, and release CI.

Known limitations: macOS LaunchAgent automation is the only managed background-service integration. Codex 0.144.6 and Herdr 0.7.5 are the currently verified adapter versions. Published-release upgrade evidence begins after the first v0.3.0 release is created.
