# Decisions

## 2026-08-09

- Deliver backend work as dependency-ordered focused PRs instead of one cross-cutting PR.
- Keep dashboard implementation out of this repository; expose a provider-neutral versioned HTTP/SSE contract instead.
- Start with issue #2 because refresh health, browser security, discovery defaults, fixtures, and dashboard integration depend on the API/event contract.
- Use GitHub issue #11 as the cross-repository daily-driver release gate.
- Treat provider-native metadata as non-semantic and non-public. Adapter authors must lift client-visible mutable state into canonical fields.
- Use a snapshot `revision` for pagination consistency and a separate event `sequence` for ordered SSE delivery.
- Keep successful action result core fields provider-neutral while treating optional `data` as an opaque adapter extension.
- Define readiness as "the bounded initial refresh cycle completed"; adapter failures make readiness degraded but do not make the usable local API permanently unready.
- Apply each adapter's successful discovery as soon as it completes instead of waiting for the slowest adapter's timeout.
- Abort cooperative discovery on timeout. Keep a non-cooperative timed-out flight tracked until it settles so refresh timers cannot duplicate it, and ignore its late result.
- Keep `/health` and aggregate `/ready` public, but require a bearer token for every `/v1/*` route so agent paths and adapter diagnostics are not exposed to other local processes.
- Reject non-loopback service binding and cross-origin browser requests by default. Allow dashboard origins only through an exact runtime allowlist.
- Persist an auto-generated token atomically in an owner-only file instead of printing it to service logs.
- Require an idempotency key on every action, cache in-flight/completed results for a bounded TTL, and serialize actions per agent so dashboard retries and double-clicks cannot duplicate or race mutations.
