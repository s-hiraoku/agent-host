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

## Credential source contract

Construct an opaque source with `createCursorSdkCredentialSource(secretOrCallback)` and
pass it as `credentialSource`. The argument must be either an explicit UTF-8 secret or a
callback that returns one. Credentials shorter than 8 bytes, larger than 16 KiB, empty,
missing, or represented by any other value are rejected. A callback receives only the
operation's abort signal and is invoked once per bridge call; there is no environment,
Cursor state, interactive-login, or default-profile fallback. Each source is single-owner
and can be assigned to only one adapter so one adapter cannot erase another's credential.

The adapter supplies the bridge a transient `Buffer` in `input.credential`. A bridge may
materialize the SDK's required string only inside that call and must not retain or log it.
The per-call buffer is zero-filled in a `finally` block, and a fixed source's retained
buffer is zero-filled by terminal `destroy()`. Ordinary `close()` remains reversible and
retains the source so `open()` can safely restore the adapter; `destroy()` closes active
work, disposes the source, and permanently rejects another `open()`. Concurrent
`destroy()` calls share the same in-flight shutdown. JavaScript strings
cannot be reliably zeroed, so callers should prefer a callback backed by a secret provider
when practical and must call `destroy()` when the composition is permanently discarded.

Credential sources have no enumerable properties and serialize as `{}`. The adapter
uses the shared redactor on bridge results, replaces bridge and callback exceptions with
bounded credential-free errors, and never trusts a public error `code` as proof that an
exception originated inside the credential boundary. It never writes credentials to launch
provenance or agent metadata. Trusted composition must still keep the source and bridge out
of generic configuration, diagnostic, and structured logging.

Result redaction runs before identity validation and preserves the adapter's bounded
bridge fields (`agentId`, `status`, `name`, and `lastActivityAt`); a credential-bearing
identity is redacted and therefore rejected rather than trusted. This credential contract
does not approve an SDK dependency, bridge implementation, normal-runtime registration,
distribution model, or use of `Cursor.auth.login()`.

Trusted composition must pre-create the dedicated store and provenance parent as
owner-only canonical directories, open the provenance parent with
`openAnchoredPrivateState`, inject that scoped backend, and call `open()` successfully
before registering the adapter.
The adapter does not recursively create either directory. The injected state capabilities
must keep every mutation anchored to the validated provenance directory, must not prepare
its parent path, and must fail closed if that identity changes. This explicit capability
boundary uses the repository's small POSIX helper because Node's pathname APIs do not
provide portable `openat` semantics against concurrent same-user path replacement.
Capabilities remain
absent if opening fails. Every bridge invocation rechecks both the configured workspace
and pre-created store identities and fails closed after replacement, symlink, or
store-permission drift; the separately reviewed bridge owns its store mutation boundary.

When directly composed with `AgentRegistry`, the adapter:

- advertises opaque configured targets and local mode only;
- requires both `localMutation` and `externalBillable` confirmation;
- writes private intent before invoking the bridge;
- derives the provider agent ID from the durable launch attempt;
- reconciles observationally and never recreates an unconfirmed attempt;
- requires exact agreement among the launch ledger, private provenance, and injected
  dedicated-store bridge;
- requires an opaque, explicit credential source for every create or reconciliation
  bridge call and never exposes that source through launch capabilities;
- discovers no ordinary or pre-existing Cursor agents;
- leaves read, prompt, interrupt, approval, focus, archive, delete, and cloud operations
  absent. Read remains gated on durable exact-run provenance rather than agent ID alone.

The private provenance file contains opaque target/profile identifiers, exact SDK
version, the bridge namespace, a hash-derived store scope, canonical-target digest, launch and attempt IDs,
and derived agent IDs. It does not contain workspace or store paths, prompts, messages,
credentials, or provider responses.

## Anchored private-state backend

The production backend supports Linux and macOS and fails closed elsewhere. Build its
auditable C helper on the target platform, outside a workspace and before dropping its
write bits:

```sh
npm run native:build -- /absolute/private/bin/agent-host-anchored-state
```

The builder requires a C11 compiler and refuses to replace an existing output. The
release archive includes both the builder and `native/anchored-private-state.c`; it does
not contain a cross-platform executable. Treat the resulting absolute helper path as
trusted code and protect its parent directory from untrusted writers.
The backend rejects helper symlinks, non-canonical paths, writable binaries, and identity
changes observed before each invocation. Node cannot execute an already-open executable
descriptor portably on both supported platforms, so this helper pathname is a distinct
code-trust boundary: use a root-owned immutable binary and root-owned parent when a
hostile process with the same UID is in scope.

```js
import { openAnchoredPrivateState } from "./src/anchored-private-state.js";

const privateState = await openAnchoredPrivateState(provenanceDirectory, {
  helperPath: "/absolute/private/bin/agent-host-anchored-state",
});
const adapter = new CursorSdkAdapter({
  bridge, sdkVersion, storeDirectory, provenanceFile, targets, privateState,
});
await adapter.open();
```

The backend holds the validated directory descriptor for its lifetime. Reads, exclusive
0600 temporary creation, file fsync, same-directory rename, directory fsync, and writer
locking all execute relative to that descriptor. Writer exclusion uses a kernel lock on
a separately opened descriptor for the anchored directory inode, so replacing the
metadata basename cannot create a second writer. Lock metadata is intentionally retained;
release closes the directory lock and never unlinks a pathname that may have been
replaced. `close()` releases all leases and the directory
descriptor. Inputs are basename-only and bounded; symlinks, non-regular files, unsafe
ownership or modes, and accessible directories are rejected.

## Supported-runtime gate

Do not add the Cursor SDK to the normal or optional dependency graph, automatically
discover an operator-installed package, or register this adapter in the standard runtime
until all gates recorded in the Cursor SDK spike are closed. In particular, the pinned
SDK's transport dependency currently has unremediated High-severity advisories, release
artifacts do not package dependencies, and SDK redistribution still requires explicit
license/TOS review. A production integration must also supply and validate the anchored
private-state capability; this repository intentionally provides only fixture plumbing.

Release builds enforce disabled-policy schema v1 at three independent boundaries: the
source `package.json`, the complete staged tree, and the contents of the final tar archive
after extraction. The policy rejects `@cursor/sdk`, `@cursor/sdk-*`, Cursor SDK bridge
bundles, dependency aliases that resolve to those packages, and every `node_modules`
entry. Generic minified dashboard bundles are not identified by filename: the release
compatibility record pins the dashboard package and lockfile hashes plus the exact sorted
set of built files, byte lengths, and SHA-256 hashes. Both staging and final archive
verification enforce that attestation, and final verification compares the embedded
compatibility record byte-for-byte with the trusted source record before using it.
Updating dashboard inputs or output therefore requires an explicit reviewed compatibility
change; enabling a provider also requires a reviewed policy-version change. This negative
artifact proof only establishes absence from a disabled release; it does not approve the
SDK's license/TOS, dependency risk, credentials, transport, or redistribution.
The anchored private-state backend closes only the provenance-storage prerequisite; it
does not close these SDK runtime gates.
