# Client conformance fixtures

These versioned, provider-neutral fixtures let dashboard and SDK implementations
exercise snapshot, action, approval, adapter-failure, event-reconnect, and versioned
repository-association behavior
without reading private agent sessions. `large-list.json` contains exactly 1,000
sanitized agent summaries for rendering and pagination performance tests.

`repository-associations.json` covers host and adapter capability negotiation, zero,
one, multiple, private, candidate, stale, unavailable, partial, and changed-association
semantics. Repository events contain only agent/revision coordinates. Subscribe before
the first association fetch, then refetch after every reconnect or sequence gap because
SSE is not replayed.

The SSE endpoint does not promise replay. On every `ready` event, compare its
`revision` and `sequence` with local state. After a disconnect or sequence gap,
fetch a fresh snapshot before applying subsequent events.

Run the host conformance implementation with:

```bash
npm run conformance
```

Clients in other languages can consume the JSON files directly and implement the
same expectations. Fixtures intentionally omit local paths, session content,
credentials, raw provider metadata, and personal data.
