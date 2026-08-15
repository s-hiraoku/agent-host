# Cursor companion feasibility probe

This diagnostic extension answers one question for issue #27: can a normally installed extension access the Cursor desktop agent-host surface without product patches, private IPC, or special launch flags?

The recorded Cursor 3.15.19 result is No-Go: Cursor restricts the required proposals to built-in extensions. The extension remains in the repository as a reproducible compatibility probe in case Cursor publishes a third-party surface later.

The probe runs after startup and records only API property names, proposal-gate results, built-in extension export names, relevant command identifiers, and host version metadata. It does not read conversations, inspect files, register an agent-host provider, send prompts, or resolve approvals.

## Package and install

```bash
npm install
npm run package
/Applications/Cursor.app/Contents/Resources/app/bin/cursor \
  --install-extension dist/agent-host-cursor-companion-spike.vsix --force
```

Reload Cursor normally. The result is written to the extension's private global storage as `probe-result.json` and shown in the `Agent Host Cursor Companion` output channel. Run `Agent Host: Run Cursor Companion Probe` from the command palette to repeat it.

Do not add `enabledApiProposals`, patch Cursor's `product.json`, or pass `--enable-proposed-api`. A successful result under those conditions would not prove that a stock installed extension can support the bridge.
