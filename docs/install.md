# Install, update, rollback, and remove

Release archives contain agent-host and a dashboard built from the pinned compatible dashboard commit. They require Node 22, 23, or 24 and do not require cloning either repository. Release archives are source distributions; they are not Apple-signed applications.

Download `agent-host-0.3.0.tar.gz` and `checksums.txt` from the same GitHub release, then verify before extraction:

```bash
shasum -a 256 -c checksums.txt
tar -xzf agent-host-0.3.0.tar.gz
node agent-host-0.3.0/scripts/manage-installation.js install agent-host-0.3.0
~/.local/bin/agent-host init
~/.local/bin/agent-host service install
~/.local/bin/agent-host start
```

Open `http://127.0.0.1:4777/`, copy the private token from `~/.agent-host/token` into the dashboard onboarding screen, and keep it out of URLs, browser storage, logs, and assets.

To update, verify and extract the new release, then run its manager with `update`. The new immutable release is staged before the atomic `current` pointer changes. The stable launcher and LaunchAgent path do not change:

```bash
node agent-host-NEW/scripts/manage-installation.js update agent-host-NEW
~/.local/bin/agent-host service install
~/.local/bin/agent-host restart
```

If readiness fails, switch back and restart:

```bash
~/.local/share/agent-host/current/scripts/manage-installation.js rollback
~/.local/bin/agent-host restart
```

To remove managed code, first stop and unload the service. Configuration, token, logs, and diagnostics under `~/.agent-host` are deliberately preserved and must be removed separately only if no longer wanted:

```bash
~/.local/bin/agent-host stop
~/.local/bin/agent-host service uninstall
node ~/.local/share/agent-host/current/scripts/manage-installation.js uninstall
```

The install manager rejects unsupported Node versions, concurrent install transactions, unsafe writable install roots, symlinks inside a release, mismatched package/manifest versions, and host/dashboard API incompatibility. GitHub build provenance plus the published checksum improves artifact integrity; a checksum hosted by the same release is not an independent signature.
