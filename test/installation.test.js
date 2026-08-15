import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  installRelease, installationStatus, rollbackRelease, uninstallRelease,
} from "../src/installation.js";

test("versioned install updates atomically, rolls back, and preserves user state on uninstall", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-install-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const prefix = join(home, ".local", "share", "agent-host");
  const binDirectory = join(home, ".local", "bin");
  const userState = join(home, ".agent-host", "config.json");
  await mkdir(join(home, ".agent-host"), { recursive: true });
  await writeFile(userState, "user-owned-state");
  const first = await fixtureRelease(home, "0.2.0");
  const second = await fixtureRelease(home, "0.3.0");

  assert.equal((await installRelease({ source: first, prefix, binDirectory })).current, "0.2.0");
  assert.equal((await installRelease({ source: second, prefix, binDirectory })).previous, "0.2.0");
  assert.deepEqual(await installationStatus(prefix), {
    installed: true, schemaVersion: 1, current: "0.3.0", previous: "0.2.0",
  });
  assert.equal((await lstat(join(prefix, "current"))).isSymbolicLink(), true);
  assert.match(await readFile(join(binDirectory, "agent-host"), "utf8"), /current\/src\/cli\.js/);

  const rolledBack = await rollbackRelease({ prefix, binDirectory });
  assert.equal(rolledBack.current, "0.2.0");
  const removed = await uninstallRelease({ prefix, binDirectory });
  assert.equal(removed.removed, true);
  assert.equal(await readFile(userState, "utf8"), "user-owned-state");
});

test("failed activation restores the previous release pointer and state", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-install-failure-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const prefix = join(home, "install");
  const binDirectory = join(home, "bin");
  const first = await fixtureRelease(home, "0.2.0");
  const second = await fixtureRelease(home, "0.3.0");
  await installRelease({ source: first, prefix, binDirectory });
  const invalidBin = join(home, "not-a-directory");
  await mkdir(join(invalidBin, "agent-host"), { recursive: true });

  await assert.rejects(installRelease({ source: second, prefix, binDirectory: invalidBin }));
  assert.equal((await installationStatus(prefix)).current, "0.2.0");
  assert.match(await readFile(join(binDirectory, "agent-host"), "utf8"), /current\/src\/cli\.js/);
  assert.equal(await readFile(join(prefix, "current", "package.json"), "utf8"), JSON.stringify({ version: "0.2.0" }));
});

test("failed transaction recovery preserves its marker and succeeds on the next run", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-install-recovery-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const prefix = join(home, "install");
  const binDirectory = join(home, "bin");
  const first = await fixtureRelease(home, "0.2.0");
  const second = await fixtureRelease(home, "0.3.0");
  await installRelease({ source: first, prefix, binDirectory });
  await installRelease({ source: second, prefix, binDirectory });
  await writeFile(join(prefix, "install-state.json"), JSON.stringify({
    schemaVersion: 1, current: "0.2.0", previous: null,
  }));
  await writeFile(join(prefix, "install-transaction.json"), JSON.stringify({
    schemaVersion: 1, from: "0.2.0", to: "0.3.0",
  }));
  await rm(join(binDirectory, "agent-host"));
  await mkdir(join(binDirectory, "agent-host"));

  await assert.rejects(installRelease({ source: second, prefix, binDirectory }));
  await lstat(join(prefix, "install-transaction.json"));
  await rm(join(binDirectory, "agent-host"), { recursive: true });
  const recovered = await installRelease({ source: second, prefix, binDirectory });
  assert.equal(recovered.current, "0.3.0");
  await assert.rejects(lstat(join(prefix, "install-transaction.json")), { code: "ENOENT" });
});

test("transaction cleanup failure keeps committed state consistent and recovers next time", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-install-cleanup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const prefix = join(home, "install");
  const binDirectory = join(home, "bin");
  const first = await fixtureRelease(home, "0.2.0");
  const second = await fixtureRelease(home, "0.3.0");
  await installRelease({ source: first, prefix, binDirectory });

  await assert.rejects(installRelease({
    source: second,
    prefix,
    binDirectory,
    beforeTransactionClear() { throw new Error("injected transaction cleanup failure"); },
  }), /cleanup failure/);
  assert.equal((await installationStatus(prefix)).current, "0.3.0");
  assert.equal(JSON.parse(await readFile(join(prefix, "current", "package.json"), "utf8")).version, "0.3.0");
  await lstat(join(prefix, "install-transaction.json"));
  assert.equal((await installRelease({ source: second, prefix, binDirectory })).current, "0.3.0");
  await assert.rejects(lstat(join(prefix, "install-transaction.json")), { code: "ENOENT" });
});

test("transaction recovery refuses missing completion and rollback targets without mutation", async (t) => {
  for (const selected of ["to", "from"]) {
    await t.test(`missing ${selected} release`, async (t) => {
      const home = await mkdtemp(join(tmpdir(), `agent-host-install-missing-${selected}-`));
      t.after(() => rm(home, { recursive: true, force: true }));
      const prefix = join(home, "install");
      const binDirectory = join(home, "bin");
      const first = await fixtureRelease(home, "0.2.0");
      const second = await fixtureRelease(home, "0.3.0");
      await installRelease({ source: first, prefix, binDirectory });
      await installRelease({ source: second, prefix, binDirectory });
      await writeFile(join(prefix, "install-state.json"), JSON.stringify({
        schemaVersion: 1,
        current: selected === "to" ? "0.3.0" : "0.2.0",
        previous: null,
      }));
      await writeFile(join(prefix, "install-transaction.json"), JSON.stringify({
        schemaVersion: 1, from: "0.2.0", to: "0.3.0",
      }));
      const currentBefore = await readlink(join(prefix, "current"));
      await rm(join(prefix, "releases", selected === "to" ? "0.3.0" : "0.2.0"), { recursive: true });
      const launcherBefore = await readFile(join(binDirectory, "agent-host"), "utf8");

      await assert.rejects(
        installRelease({ source: second, prefix, binDirectory }),
        new RegExp(`cannot recover install transaction because release ${selected === "to" ? "0.3.0" : "0.2.0"}`),
      );
      await lstat(join(prefix, "install-transaction.json"));
      assert.equal(await readFile(join(binDirectory, "agent-host"), "utf8"), launcherBefore);
      assert.equal(await readlink(join(prefix, "current")), currentBefore);
    });
  }
});

test("installer rejects incompatible dashboard releases, links, unsafe roots, and concurrent transactions", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agent-host-install-invalid-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const binDirectory = join(home, "bin");
  const incompatible = await fixtureRelease(home, "0.3.0", { dashboardApiVersions: ["2"] });
  await assert.rejects(
    installRelease({ source: incompatible, prefix: join(home, "incompatible"), binDirectory }),
    /incompatible/,
  );
  const linked = await fixtureRelease(home, "0.3.1");
  await symlink("package.json", join(linked, "linked-package"));
  await assert.rejects(
    installRelease({ source: linked, prefix: join(home, "linked"), binDirectory }),
    /symbolic link/,
  );
  const unsafe = join(home, "unsafe");
  await mkdir(unsafe, { mode: 0o777 });
  await chmod(unsafe, 0o777);
  const safeSource = await fixtureRelease(home, "0.3.3");
  await assert.rejects(installRelease({ source: safeSource, prefix: unsafe, binDirectory }), /group\/world writable/);

  const valid = await fixtureRelease(home, "0.3.2");
  const locked = join(home, "locked");
  await mkdir(join(locked, ".install-lock"), { recursive: true });
  await assert.rejects(installRelease({ source: valid, prefix: locked, binDirectory }), /in progress/);

  const incomplete = join(home, "incomplete-lock");
  await mkdir(join(incomplete, ".install-lock"), { recursive: true });
  await writeFile(join(incomplete, ".install-lock", "owner.json"), "{");
  const old = new Date(Date.now() - 10_000);
  await utimes(join(incomplete, ".install-lock"), old, old);
  assert.equal((await installRelease({
    source: valid, prefix: incomplete, binDirectory: join(home, "incomplete-bin"),
  })).current, "0.3.2");

  const stale = join(home, "stale-lock");
  await mkdir(stale, { recursive: true });
  await mkdir(join(stale, ".install-lock"));
  await writeFile(join(stale, ".install-lock", "owner.json"), JSON.stringify({ pid: 999_999_999 }));
  let staleQuarantine;
  assert.equal((await installRelease({
    source: valid,
    prefix: stale,
    binDirectory,
    async beforeTransactionClear() {
      const entries = await import("node:fs/promises").then(({ readdir }) => readdir(stale));
      const quarantine = entries.find((entry) => entry.startsWith(".install-lock.stale-"));
      assert.ok(quarantine);
      staleQuarantine = join(stale, quarantine);
      await lstat(staleQuarantine);
    },
  })).current, "0.3.2");
  await assert.rejects(lstat(staleQuarantine), { code: "ENOENT" });
  const contested = join(home, "contested-lock");
  await mkdir(contested, { recursive: true });
  const contestedLock = join(contested, ".install-lock");
  await mkdir(contestedLock);
  await writeFile(join(contestedLock, "owner.json"), JSON.stringify({ pid: 999_999_999 }));
  const contestedStat = await lstat(contestedLock);
  const quarantine = `${contestedLock}.stale-${contestedStat.dev}-${contestedStat.ino}`;
  await mkdir(quarantine);
  await writeFile(join(quarantine, "owner.json"), "occupied");
  await assert.rejects(
    installRelease({ source: valid, prefix: contested, binDirectory }),
    /acquired the stale install lock/,
  );

  const tampered = await fixtureRelease(home, "0.3.4");
  await writeFile(join(tampered, "dashboard", "index.html"), "tampered after manifest");
  await assert.rejects(
    installRelease({ source: tampered, prefix: join(home, "tampered"), binDirectory }),
    /checksum mismatch/,
  );
  const unexpected = await fixtureRelease(home, "0.3.5");
  await writeFile(join(unexpected, "unexpected.txt"), "not allowlisted");
  await assert.rejects(
    installRelease({ source: unexpected, prefix: join(home, "unexpected"), binDirectory }),
    /file allowlist/,
  );
  const traversal = await fixtureRelease(home, "0.3.6");
  await writeFile(join(traversal, "release-compatibility.json"), JSON.stringify({
    productVersion: "../../escape", apiVersions: ["1"], dashboard: { apiVersions: ["1"] },
  }));
  await assert.rejects(
    installRelease({ source: traversal, prefix: join(home, "traversal"), binDirectory }),
    /invalid release version/,
  );
  const unmanagedBin = join(home, "unmanaged-bin");
  await mkdir(unmanagedBin);
  await writeFile(join(unmanagedBin, "agent-host"), "#!/bin/sh\necho user-owned\n");
  await assert.rejects(
    installRelease({ source: valid, prefix: join(home, "unmanaged-launcher"), binDirectory: unmanagedBin }),
    /unmanaged launcher/,
  );
  assert.match(await readFile(join(unmanagedBin, "agent-host"), "utf8"), /user-owned/);
});

async function fixtureRelease(home, version, options = {}) {
  const root = join(home, `release-${version}-${Math.random().toString(16).slice(2)}`);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "dashboard"), { recursive: true });
  await writeFile(join(root, "src", "cli.js"), "#!/usr/bin/env node\n");
  await writeFile(join(root, "dashboard", "index.html"), "<!doctype html><title>dashboard</title>");
  await writeFile(join(root, "package.json"), JSON.stringify({ version }));
  await writeFile(join(root, "release-compatibility.json"), JSON.stringify({
    productVersion: version,
    apiVersions: ["1"],
    dashboard: { apiVersions: options.dashboardApiVersions ?? ["1"] },
  }));
  const files = ["dashboard/index.html", "package.json", "release-compatibility.json", "src/cli.js"];
  const entries = [];
  for (const path of files) {
    const contents = await readFile(join(root, path));
    entries.push({ path, bytes: contents.length, sha256: createHash("sha256").update(contents).digest("hex") });
  }
  await writeFile(join(root, "release-files.json"), JSON.stringify({ schemaVersion: 1, files: entries }));
  return root;
}
