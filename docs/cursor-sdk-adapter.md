# Cursor SDK injected adapter boundary

`CursorSdkAdapter` is dependency-free preparation for an agent-host-owned Cursor agent
provider. It is not registered by `createRuntimeAdapters`, does not load undeclared npm
packages, and is not a supported instruction for installing `@cursor/sdk` into an
agent-host release.

The boundary accepts only an explicitly injected bridge namespace with an exact
`sdkVersion` and two operations: create a deterministic local agent ID and inspect that
exact ID in a dedicated store. The integration owner is
responsible for supplying a separately reviewed bridge and credentials; the adapter does
not perform interactive login or read Cursor's default credentials or stores.

Trusted composition must call `open()` successfully before registering the adapter. That
step acquires the private provenance writer lease and validates the complete bounded state;
capabilities remain absent if opening fails.

When directly composed with `AgentRegistry`, the adapter:

- advertises opaque configured targets and local mode only;
- requires both `localMutation` and `externalBillable` confirmation;
- writes private intent before invoking the bridge;
- derives the provider agent ID from the durable launch attempt;
- reconciles observationally and never recreates an unconfirmed attempt;
- requires exact agreement among the launch ledger, private provenance, and injected
  dedicated-store bridge;
- discovers no ordinary or pre-existing Cursor agents;
- leaves read, prompt, interrupt, approval, focus, archive, delete, and cloud operations
  absent. Read remains gated on durable exact-run provenance rather than agent ID alone.

The private provenance file contains opaque target/profile identifiers, exact SDK
version, bridge/store namespace hashes, canonical-target digest, launch and attempt IDs,
and derived agent IDs. It does not contain workspace or store paths, prompts, messages,
credentials, or provider responses.

## Supported-runtime gate

Do not add the Cursor SDK to the normal or optional dependency graph, automatically
discover an operator-installed package, or register this adapter in the standard runtime
until all gates recorded in the Cursor SDK spike are closed. In particular, the pinned
SDK's transport dependency currently has unremediated High-severity advisories, release
artifacts do not package dependencies, and SDK redistribution still requires explicit
license/TOS review.
