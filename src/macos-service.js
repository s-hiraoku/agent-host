import { chmod, lstat, readFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { ensurePrivateDirectory, ensureOwnedDirectory, writePrivateFileAtomic } from "./secure-state.js";

const execFileAsync = promisify(execFile);
export const SERVICE_LABEL = "dev.agent-host";

export function renderLaunchAgent({ nodePath, cliPath, launcherPath, configPath, dashboardDirectory, logFile, errorLogFile = `${logFile}.error` }) {
  const args = launcherPath
    ? [launcherPath, "serve", "--config", configPath]
    : [nodePath, cliPath, "serve", "--config", configPath];
  if (dashboardDirectory) args.push("--dashboard-dir", dashboardDirectory);
  return `${xmlHeader()}<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>${args.map((arg) => `\n    <string>${escapeXml(arg)}</string>`).join("")}\n  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(errorLogFile)}</string>
</dict>
</plist>
`;
}

export function createMacosServiceController(options = {}) {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.();
  const run = options.run ?? (async (args) => execFileAsync("launchctl", args));
  const assertSupported = () => {
    if (platform !== "darwin" || !Number.isInteger(uid)) {
      throw new Error("agent-host service lifecycle currently supports macOS LaunchAgents only; use `agent-host serve` for foreground operation");
    }
  };
  const domain = () => `gui/${uid}`;
  const target = () => `${domain()}/${SERVICE_LABEL}`;
  const isInstalled = async (plistPath) => {
    try {
      const stat = await lstat(plistPath);
      if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
        throw new Error(`unsafe LaunchAgent path: ${plistPath}`);
      }
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  };
  const isRunning = async () => {
    try { await run(["print", target()]); return true; }
    catch { return false; }
  };
  const readManagedPlist = async (plistPath) => {
    const contents = await readFile(plistPath, "utf8");
    if (!contents.includes(`<string>${SERVICE_LABEL}</string>`)) {
      throw new Error(`refusing to replace unmanaged LaunchAgent: ${plistPath}`);
    }
    return contents;
  };
  return {
    async install({ plistPath, nodePath, cliPath, launcherPath, configPath, dashboardDirectory, logFile }) {
      assertSupported();
      const installed = await isInstalled(plistPath);
      const running = installed && await isRunning();
      const previousContents = installed ? await readManagedPlist(plistPath) : undefined;
      await ensureOwnedDirectory(dirname(plistPath));
      await ensurePrivateDirectory(dirname(logFile));
      const contents = renderLaunchAgent({ nodePath, cliPath, launcherPath, configPath, dashboardDirectory, logFile });
      await writePrivateFileAtomic(plistPath, contents, { tightenDirectory: false });
      await chmod(plistPath, 0o600);
      if (running) {
        try {
          await run(["bootout", target()]);
          await run(["bootstrap", domain(), plistPath]);
        }
        catch (error) {
          await writePrivateFileAtomic(plistPath, previousContents, { tightenDirectory: false });
          await chmod(plistPath, 0o600);
          if (!await isRunning()) await run(["bootstrap", domain(), plistPath]).catch(() => {});
          throw error;
        }
      }
      return { installed: true, running, replaced: installed, plistPath };
    },

    async start(plistPath) {
      assertSupported();
      if (!await isInstalled(plistPath)) throw new Error(`LaunchAgent is not installed; run \`agent-host service install\`: ${plistPath}`);
      if (!await isRunning()) await run(["bootstrap", domain(), plistPath]);
      return { installed: true, running: true, plistPath };
    },

    async stop(plistPath) {
      assertSupported();
      if (!await isInstalled(plistPath)) return { installed: false, running: false, plistPath };
      if (await isRunning()) await run(["bootout", target()]);
      return { installed: true, running: false, plistPath };
    },

    async restart(plistPath) {
      assertSupported();
      if (!await isInstalled(plistPath)) throw new Error(`LaunchAgent is not installed; run \`agent-host service install\`: ${plistPath}`);
      if (await isRunning()) await run(["kickstart", "-k", target()]);
      else await run(["bootstrap", domain(), plistPath]);
      return { installed: true, running: true, plistPath };
    },

    async status(plistPath) {
      assertSupported();
      const installed = await isInstalled(plistPath);
      return { installed, running: installed ? await isRunning() : false, plistPath };
    },

    async uninstall(plistPath) {
      assertSupported();
      if (!await isInstalled(plistPath)) return { installed: false, running: false, plistPath };
      if (await isRunning()) await run(["bootout", target()]);
      const stat = await lstat(plistPath);
      if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
        throw new Error(`refusing to remove unsafe LaunchAgent path: ${plistPath}`);
      }
      await readManagedPlist(plistPath);
      await unlink(plistPath);
      return { installed: false, running: false, plistPath };
    },
  };
}

function xmlHeader() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
