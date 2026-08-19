# Cursor SDK injected adapter boundary

`CursorSdkAdapter` is a dependency-free provider for agent-host-owned Cursor agents. The
normal defaults do not register it. The explicit `cursor-sdk-bridge` runtime attaches to
an already-running official `sdk.v1` Bridge on a literal loopback address. Agent Host
does not download, locate, spawn, stop, or package that Bridge and does not install
`@cursor/sdk`.

## External Bridge runtime

The operator must provision the official Bridge independently, pin the same release as
`sdkVersion`, verify its published checksum and licensing, and start it with its own
private auth-token file. Agent Host accepts only a canonical `http://127.0.0.1:<port>` or
`http://[::1]:<port>` origin. Hostnames, remote addresses, TLS endpoints, URL credentials,
paths, queries, fragments, redirects, and proxy discovery are rejected. Startup sends
authenticated `Ping` and `GetVersion` calls and requires `protocolVersion: sdk.v1` plus
the exact configured Bridge version before publishing launch capabilities.

Both credential files must be owner-only regular files. They are independent: the
Bridge bearer token authenticates the local transport, while the Cursor API key is sent
only in the explicit SDK operation. They are read into bounded buffers for each use,
trimmed, and zero-filled after the call. JavaScript and HTTP necessarily materialize
short-lived strings; neither value is added to configuration diagnostics, logs,
provenance, or agent metadata.

Example schema-1 configuration (relative paths resolve from the config directory):

```json
{
  "schemaVersion": 1,
  "enabledAdapters": ["codex", "herdr", "process", "cursor-sdk-bridge"],
  "cursorSdkBridge": {
    "endpoint": "http://127.0.0.1:40555",
    "sdkVersion": "1.0.28",
    "bearerTokenFile": "secrets/cursor-bridge.token",
    "apiKeyFile": "secrets/cursor-api.key",
    "helperPath": "/opt/agent-host/bin/anchored-private-state",
    "storeDirectory": "/opt/agent-host/cursor-store",
    "provenanceFile": "/opt/agent-host/state/501/cursor-provenance.json",
    "timeoutMs": 10000,
    "targets": [
      { "id": "main", "cwd": "/absolute/workspace", "profiles": ["composer-2"] }
    ]
  }
}
```

The first slice exposes create/reconcile/discover only for IDs derived from Agent Host's
durable launch ledger and private provenance. A not-found lookup may `ResumeAgent` that
one exact ID from the configured store. It never calls `ListAgents`, adopts arbitrary
Bridge agents, or correlates desktop conversations. Prompt, read, interrupt, archive,
delete, cloud mode, managed Bridge lifecycle, and existing Cursor desktop sessions remain
out of scope. Transport failures after `CreateAgent` are uncertain and are not retried.

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

Trusted composition must pre-create the dedicated store and provenance directory,
open the provenance directory with
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

The production backend supports Linux and macOS and fails closed elsewhere. It rejects
root execution because root cannot be protected from a hostile process with the same UID.
Build the auditable C helper on the target platform, then install the binary and state
root through a privileged provisioning step:

```sh
npm run native:build -- /tmp/agent-host-anchored-state
sudo install -d -o root -g root -m 0755 /opt/agent-host /opt/agent-host/bin /opt/agent-host/state
sudo install -o root -g root -m 0555 /tmp/agent-host-anchored-state /opt/agent-host/bin/anchored-private-state
sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0700 "/opt/agent-host/state/$(id -u)"
```

Use the platform's root group (`wheel` on typical macOS installations) where it differs.
The builder requires a C11 compiler and refuses to replace an existing output. The
release archive contains the builder and reviewed C source, not a cross-platform binary.
The installed helper must be a root-owned, executable, non-writable regular file. Every
ancestor of both the helper and state directory must be root-owned, group/other
non-writable, and not writable by the effective user (including through an ACL). The
final state directory alone is current-user-owned mode `0700`. Paths under a home,
workspace, `/tmp`, or another user-writable ancestor are rejected rather than accepted
with a pathname-only fallback.

```js
import { openAnchoredPrivateState } from "./src/anchored-private-state.js";

const privateState = await openAnchoredPrivateState(provenanceDirectory, {
  helperPath: "/opt/agent-host/bin/anchored-private-state",
});
const adapter = new CursorSdkAdapter({
  bridge, sdkVersion, storeDirectory, provenanceFile, targets, privateState,
});
await adapter.open();
```

One persistent native helper owns the directory `flock` and performs every read, bounded
write, `0600` temporary creation, file fsync, same-directory rename, directory fsync, and
lock-metadata update for that lease. Node and the helper exchange one sequential request
at a time through a versioned fixed-header binary protocol; basenames are at most 200
bytes and payloads at most 1,000,000 bytes. There is no second mutation process between a
pathname check and a write. The helper opens the canonical state path component by
component with no-follow semantics and compares the protected parent entry with its held
directory identity immediately before mutation.

Unexpected helper exit permanently poisons that private-state object. An in-flight write
is ambiguous and is never retried. A later newly opened object may acquire the kernel
lock and removes only validated, current-user-owned, single-link `0600`
`.agent-host-*.tmp` crash remnants before proceeding. Symlinks, hard links, FIFOs,
unsafe modes, malformed/oversized protocol frames, and unsupported platforms terminate
the session fail-closed. Contention is reported as `instance_already_running`.

Adapter and provenance-store `close()` release the current writer lease without disposing
the injected backend, so a later `open()` creates a fresh persistent helper session.
Adapter `destroy()` is terminal and disposes the backend; a poisoned backend remains
poisoned across `close()` and cannot be reopened. Lock metadata is retained for diagnostics;
release never unlinks a pathname that another process may have replaced.

The protected-parent contract prevents a same-UID process from renaming the final state
directory. It does not claim integrity against a same-UID process that directly edits
files inside a directory it owns. That stronger boundary requires a separate privileged
broker, a separate UID, or an OS mandatory-access-control policy.

## Distribution boundary

Do not add the Cursor SDK to the normal or optional dependency graph, automatically
discover an operator-installed package or Bridge, or package either until all gates
recorded in the Cursor SDK spike are closed. The attach-only runtime is a transport
client, not approval to redistribute Cursor binaries or dependencies. It remains disabled
unless the operator supplies the complete explicit configuration above.

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
The anchored private-state backend and attach transport close only host-side state and
wire prerequisites; they do not approve Cursor SDK or Bridge redistribution.
