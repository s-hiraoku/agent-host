# Decisions

## 2026-08-09

- Deliver backend work as dependency-ordered focused PRs instead of one cross-cutting PR.
- Keep dashboard implementation out of this repository; expose a provider-neutral versioned HTTP/SSE contract instead.
- Start with issue #2 because refresh health, browser security, discovery defaults, fixtures, and dashboard integration depend on the API/event contract.
- Use GitHub issue #11 as the cross-repository daily-driver release gate.
- Treat provider-native metadata as non-semantic and non-public. Adapter authors must lift client-visible mutable state into canonical fields.
- Use a snapshot `revision` for pagination consistency and a separate event `sequence` for ordered SSE delivery.
- Keep successful action result core fields provider-neutral while treating optional `data` as an opaque adapter extension.
