import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MAC_DESKTOP_APPS = Object.freeze({
  cursor: Object.freeze({ appName: "Cursor" }),
  claude: Object.freeze({ appName: "Claude" }),
  chatgpt: Object.freeze({ appName: "ChatGPT" }),
});

export function defaultMacAppLocations(appName, {
  homeDirectory = homedir(),
} = {}) {
  return [
    join("/Applications", `${appName}.app`),
    join(homeDirectory, "Applications", `${appName}.app`),
  ];
}

export function createMacAppFocus({
  platform = process.platform,
  execFile = execFileAsync,
  locateApp,
  homeDirectory,
} = {}) {
  const resolve = locateApp ?? (async (app) => {
    for (const path of defaultMacAppLocations(app.appName, { homeDirectory })) {
      try {
        await access(path, constants.F_OK);
        return path;
      } catch {
        // Try the next documented location. Absence is not an error.
      }
    }
  });

  return {
    supported: platform === "darwin",
    async available(app) {
      if (platform !== "darwin" || !app?.appName) return false;
      return Boolean(await resolve(app));
    },
    async activate(app) {
      if (platform !== "darwin" || !app?.appName) {
        return { ok: false, code: "desktop_focus_unsupported" };
      }
      if (!await resolve(app)) {
        return { ok: false, code: "desktop_focus_unavailable" };
      }
      try {
        await execFile("open", ["-a", app.appName], { timeout: 5_000 });
        return { ok: true };
      } catch {
        return { ok: false, code: "desktop_focus_failed" };
      }
    },
  };
}
