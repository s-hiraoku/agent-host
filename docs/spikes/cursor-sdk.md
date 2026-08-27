# Cursor SDK adapter feasibility

Issue: [#32](https://github.com/s-hiraoku/agent-host/issues/32)

Parent epic: [#26](https://github.com/s-hiraoku/agent-host/issues/26)

Related desktop API tracker: [#31](https://github.com/s-hiraoku/agent-host/issues/31)

## Decision

**No-Go for a production `cursor-sdk` adapter under the current agent-host API.**

The supported SDK surface is sufficient to investigate agent-host-owned agents, but
agent-host currently has no explicit provider-neutral operation for creating or launching
an agent. Discovery must not create agents, and adopting arbitrary entries returned by
`Agent.list()` would not prove agent-host ownership. A production adapter therefore needs
a separately reviewed launch contract and ownership registry first.

This does not change the desktop decision. `cursor-sdk:*` agents are a separate integration
surface from the observer's `cursor-desktop:*` records and must never be deduplicated or
presented as control of pre-existing Cursor IDE conversations.

## 2026-08-17 dependency gate

The launch contract now exists, but the latest inspected SDK release remains blocked from
the supported runtime. `@cursor/sdk@1.0.28` resolves through
`@connectrpc/connect-node@1.7.0` to `undici@5.29.0`. That transport version is affected by
the High-severity [GHSA-v9p9-hfj2-hcw8](https://github.com/advisories/GHSA-v9p9-hfj2-hcw8),
plus the Moderate
[GHSA-2mjp-6q6p-2qxm](https://github.com/advisories/GHSA-2mjp-6q6p-2qxm). npm reports no
supported fix for the SDK dependency graph. Forcing Undici across its major-version
boundary is not an accepted compatibility or security remedy.

Consequently agent-host does not declare, dynamically discover, or package the Cursor
SDK. The dependency-free `CursorSdkAdapter` is only an explicit bridge-injection boundary
for deterministic contract tests and separately risk-accepted integrations. Normal
runtime construction never registers it. A supported provider remains blocked until an
upstream SDK release has an acceptable audited transport graph and its license/TOS and
release-distribution requirements are approved.

## Evidence snapshot

Inspected the published npm tarball for `@cursor/sdk@1.0.28` on 2026-08-16 without
installing it as a project dependency or executing an agent. The package requires Node
`>=22.13`; the tarball reports SHA-1 `e30d9e3dda4775e644621fc2c8cbca26cb70d227`
and npm integrity
`sha512-bO7Ld00xXV5kFB9WDeBiyADgon3r/BQXc9qZ4sHlXX9ZQpzIkTfHrYU7g278pcHTuz+l/vPcPcc7JByeRWHeqA==`.

The checked public declarations expose the following surface. These are type-level
observations, not live runtime guarantees:

- `Agent.create`, `resume`, `list`, `listRuns`, `getRun`, `cancelRun`, and
  `messages.list`;
- run-scoped `supports`, `stream`, `conversation`, `wait`, `cancel`, status changes,
  terminal result, usage, and request IDs;
- explicit local/cloud list modes and cloud caller metadata;
- local agent, run, checkpoint, and append-only run-event stores;
- user, assistant, tool-call, status, request, task, and usage stream messages;
- create/send idempotency keys and local tool allow/deny lists.

The package also documents important constraints:

- the first-party high-level package surface evaluated here emphasized cloud lifecycle,
  while the separately published `sdk.v1` 1.0.28 Bridge contract includes local
  `DeleteAgent` with explicit cwd/API-key operation options;
- local list operations are scoped by `cwd` or an explicit store;
- tool allow/deny restrictions are not persisted and must be supplied again on resume;
- local agents can execute shell/edit/delete tools and mutate their workspace;
- cloud usage exposes billed token and dollar-cost data;
- interactive `Cursor.auth.login()` persists a key under the user's Cursor state by
  default, which agent-host must not invoke implicitly.

The repeatable declaration-only probe is:

```sh
mkdir -p /tmp/cursor-sdk
npm --cache /tmp/agent-host-npm-cache pack @cursor/sdk@1.0.28 --pack-destination /tmp/cursor-sdk
tar -xzf /tmp/cursor-sdk/cursor-sdk-1.0.28.tgz -C /tmp/cursor-sdk
node scripts/probe-cursor-sdk-package.mjs /tmp/cursor-sdk/package
```

It reads only an allowlist of bounded regular manifest/declaration files, rejects linked
files, emits no source text or filesystem paths, and exits nonzero when an expected public
symbol disappears.

## Contract mapping

| SDK concept | Candidate agent-host mapping | Decision |
| --- | --- | --- |
| durable SDK agent | public agent record | Only after ownership registry proof |
| SDK run | active/previous turn of one agent | Do not create a public record per run |
| `Agent.list` | discovery input | Filter to registry-owned IDs only |
| `Agent.listRuns` / `getRun` | status and history evidence | Bounded; reject agent/run mismatch |
| `messages.list` / `Run.conversation` | `read` | User/assistant text only; tool data omitted |
| `SDKAgent.send` | `prompt` | Requires ownership, resume proof, and idempotency |
| `Run.cancel` / `Agent.cancelRun` | `interrupt` | Exact active run only |
| run stream/status listener | working/terminal transitions | Generation-scoped; disconnect becomes unknown |
| SDK approvals | approve/reject | Unsupported by the inspected public surface |
| desktop navigation | focus | Unsupported |
| cloud archive/delete | lifecycle management | Outside current action API and initial adapter scope |

## Required launch and ownership boundary

The next design must introduce an explicit, authenticated, idempotent launch operation.
It must not overload `prompt` on a synthetic record and must never run during discovery.
The result must record a durable ownership entry before advertising the agent.

A candidate identity is:

```text
cursor-sdk:<owner-scope-hash>:<local|cloud>:<sdk-agent-id>
```

The owner-only registry should retain only the SDK agent ID, runtime, creation request ID,
workspace/project opaque ID, verified SDK version, and lifecycle timestamps. It must not
store API keys, prompts, messages, raw environment variables, or cloud credentials.
Cloud creation metadata should carry an agent-host instance/request marker so restart
reconciliation can prove provenance. Local reconciliation must use an explicit isolated
SDK store owned by agent-host rather than scanning the user's default SDK store.

## Capability rules

- Default: both local and cloud SDK modes disabled.
- Discovery: registry-owned IDs only; never create, resume, retry, or repair implicitly.
- `working`: only while the exact current run has documented running evidence.
- `idle`: only after explicit successful completion.
- `error`: only after an explicit terminal error.
- `unknown`: missing agent/run, SDK drift, disconnect, replay gap, ownership mismatch, or
  uncertain delivery.
- `read`: bounded user/assistant text only when replay is complete.
- `prompt`: only after an ownership-verified resume and with a unique SDK idempotency key.
- `interrupt`: only when the active run ID is exact and `supports("cancel")` is true.
- `approve`, `reject`, `focus`, arbitrary adoption, archive, and delete: disabled initially.

Every resume must reapply the pinned model/tool restrictions because the SDK does not
persist tool allow/deny settings. A transport generation change invalidates all action
handles and capabilities.

## Security and cost boundary

Local mode is workspace-mutating code execution. A future implementation needs an
explicit allowlisted workspace, a separately owned SDK state root, conservative tool
policy, no subagents by default, and an action audit that excludes prompts and paths.

Cloud mode is external and potentially billable. It needs a separate enable flag,
explicit API-key injection, request-level idempotency, duplicate-charge handling, usage
bounds, and clear confirmation at launch. Agent-host must not call interactive login,
persist credentials, or silently fall back to a stored Cursor key.

No live local or cloud agent was created during this spike. That avoided workspace
mutation, external execution, and token charges while still validating the published
contract. A later disposable local smoke may run only against a synthetic workspace.
Live cloud testing requires separate explicit approval.

## Next gate

Proceed with a focused launch-contract design issue, not a production SDK adapter issue.
That issue must define authenticated/idempotent create semantics, ownership persistence,
runtime and cost confirmation, status/action correlation, and rollback on partial creation.
Only after that contract is accepted should a fixture-backed `cursor-sdk` adapter be
implemented.
