import test from "node:test";
import assert from "node:assert/strict";
import { createMacAppFocus, defaultMacAppLocations, MAC_DESKTOP_APPS } from "../src/adapters/mac-app-focus.js";

test("macOS app focus is available only when the application exists", async () => {
  const focus = createMacAppFocus({
    platform: "darwin",
    locateApp: async (app) => app.appName === "Cursor" ? "/Applications/Cursor.app" : undefined,
    execFile: async () => {
      throw new Error("activate should not run during availability");
    },
  });
  assert.equal(focus.supported, true);
  assert.equal(await focus.available(MAC_DESKTOP_APPS.cursor), true);
  assert.equal(await focus.available({ appName: "Missing" }), false);
});

test("macOS app focus activates by application name and hides paths on failure", async () => {
  const calls = [];
  const focus = createMacAppFocus({
    platform: "darwin",
    locateApp: async () => "/private/tmp/SYNTHETIC_CURSOR_PATH/Cursor.app",
    execFile: async (command, args) => {
      calls.push({ command, args });
    },
  });
  assert.deepEqual(await focus.activate(MAC_DESKTOP_APPS.cursor), { ok: true });
  assert.deepEqual(calls, [{ command: "open", args: ["-a", "Cursor"] }]);

  const failing = createMacAppFocus({
    platform: "darwin",
    locateApp: async () => "/private/tmp/SYNTHETIC_CURSOR_PATH/Cursor.app",
    execFile: async () => {
      throw Object.assign(new Error("open failed: /private/tmp/SYNTHETIC_CURSOR_PATH/Cursor.app"), { stderr: "/private/tmp/SYNTHETIC_CURSOR_PATH" });
    },
  });
  assert.deepEqual(await failing.activate(MAC_DESKTOP_APPS.cursor), {
    ok: false,
    code: "desktop_focus_failed",
  });
});

test("macOS app focus stays disabled off darwin and when the app is absent", async () => {
  const linux = createMacAppFocus({
    platform: "linux",
    locateApp: async () => "/Applications/Cursor.app",
    execFile: async () => ({ ok: true }),
  });
  assert.equal(linux.supported, false);
  assert.equal(await linux.available(MAC_DESKTOP_APPS.cursor), false);
  assert.deepEqual(await linux.activate(MAC_DESKTOP_APPS.cursor), {
    ok: false,
    code: "desktop_focus_unsupported",
  });

  const missing = createMacAppFocus({
    platform: "darwin",
    locateApp: async () => undefined,
    execFile: async () => {
      throw new Error("activate should not run when the app is absent");
    },
  });
  assert.equal(await missing.available(MAC_DESKTOP_APPS.cursor), false);
  assert.deepEqual(await missing.activate(MAC_DESKTOP_APPS.cursor), {
    ok: false,
    code: "desktop_focus_unavailable",
  });
});

test("default macOS app locations stay inside Applications folders", () => {
  assert.deepEqual(defaultMacAppLocations("Cursor", { homeDirectory: "/Users/example" }), [
    "/Applications/Cursor.app",
    "/Users/example/Applications/Cursor.app",
  ]);
});
