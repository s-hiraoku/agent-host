# Client conformance fixtures

These versioned, provider-neutral fixtures let dashboard and SDK implementations
exercise snapshot, action, approval, adapter-failure, and event-reconnect behavior
without reading private agent sessions. `large-list.json` contains exactly 1,000
sanitized agent summaries for rendering and pagination performance tests.

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
