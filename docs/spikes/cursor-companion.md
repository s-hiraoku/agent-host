# Cursor companion feasibility spike

Issue: [#27](https://github.com/s-hiraoku/agent-host/issues/27)
Parent epic: [#26](https://github.com/s-hiraoku/agent-host/issues/26)

## Decision status

**No-Go for semantic control through a stock companion extension.**

Verified on Cursor 3.15.19 (VS Code 1.128.0) on 2026-08-15. The packaged extension installed and activated normally without product patches, development mode, or proposed-API launch flags. Cursor exposed the `vscode.cursor` object, but rejected both the `cursorAgentHostEnabled` getter and `acquireAgentHostRuntime()` because the required proposals are available only to built-in extensions.

The built-in `anysphere.cursor-agent-host` extension was also absent from the normal workspace extension host's extension registry. Relevant internal command identifiers were visible, but there was no stock semantic surface for listing or watching sessions. Generic command invocation therefore cannot satisfy the identity, status, or capability contract.

## Known evidence

- Cursor 3.15.19 includes a built-in `anysphere.cursor-agent-host` extension.
- The built-in extension declares the private `cursorAgentHost` proposal and registers an agent-host provider inside Cursor.
- Cursor's internal surface contains session list/watch, message, interrupt, and interaction-response operations.
- The public Cursor CLI and SDK control their own agent runtimes; they do not establish attachment to arbitrary desktop IDE sessions.
- Cursor's main application socket is not a documented desktop-agent control transport.

The existence of Cursor's internal operations does not make them available to a normally installed third-party extension. The probe intentionally requested no proposed APIs and recorded the actual proposal-gate result.

## Probe safety boundary

The extension may enumerate API property names, activate the already-installed built-in agent-host extension, attempt the read-only `cursorAgentHostEnabled` getter and runtime acquisition, and list command identifiers. It must not register a provider or runtime, read conversation content, send a prompt, interrupt a turn, resolve an interaction, patch Cursor files, or connect to private IPC.

## Go/No-Go record

Record the following after running the packaged extension:

| Check | Result |
| --- | --- |
| Stock extension installs and activates | Pass |
| `cursorAgentHost` proposal is available | Fail — built-in extensions only |
| Built-in agent-host exports are visible | Fail — isolated from the workspace extension host |
| Existing sessions can be listed | Blocked by proposal gate |
| Session changes can be watched | Blocked by proposal gate |
| Follow-up messages can be sent | Blocked by proposal gate |
| Active turns can be interrupted | Blocked by proposal gate |
| Stable identity survives restart | Not testable without session access |
| Pending interactions can be resolved | Blocked by proposal gate |
| Exact session can be focused | No semantic session surface |

## Decision

Do not build a production companion extension on Cursor's private proposals, do not patch `product.json`, and do not connect directly to the private main IPC socket. Those paths would turn an explicit product boundary into an unversioned, unsupported control transport.

Proceed with an opt-in `cursor-desktop` artifact observer. It may provide metadata and a bounded `read` capability after parser safety is proven, but it must not infer `working` from process presence or an unterminated transcript. Semantic capabilities remain unavailable until Cursor publishes a supported API that can attach to existing desktop sessions.
