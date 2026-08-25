import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  serializePrivateReport,
  validatePrivateReportDestination,
} from "../src/private-report.js";

test("private report destination rejects protected state and symbolic links", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-private-report-"));
  t.after(() => rm(directory, { recursive: true }));
  const credential = join(directory, "credential");
  const store = join(directory, "store");
  const linked = join(directory, "linked-report");
  await writeFile(credential, "secret", { mode: 0o600 });
  await mkdir(store);
  await symlink(credential, linked);
  await assert.rejects(validatePrivateReportDestination(credential, { exactPaths: [credential] }), /protected/);
  await assert.rejects(validatePrivateReportDestination(join(store, "report.json"), {
    directoryPaths: [store],
  }), /protected/);
  await assert.rejects(validatePrivateReportDestination(linked), /real file/);
  assert.equal(await validatePrivateReportDestination(join(directory, "report.json")), join(directory, "report.json"));
});

test("private report destination rejects a protected path reached through a directory alias", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-private-report-alias-"));
  t.after(() => rm(directory, { recursive: true }));
  const actual = join(directory, "actual");
  const alias = join(directory, "alias");
  await mkdir(join(actual, "nested"), { recursive: true });
  await symlink(actual, alias);
  const credential = join(actual, "nested", "credential");
  await writeFile(credential, "secret", { mode: 0o600 });
  await assert.rejects(
    validatePrivateReportDestination(join(alias, "nested", "credential"), { exactPaths: [credential] }),
    /protected/,
  );
});

test("private report serialization enforces a final UTF-8 byte limit", () => {
  assert.throws(() => serializePrivateReport({ value: "x".repeat(5_000) }), /size limit/);
  assert.doesNotThrow(() => serializePrivateReport({ schemaVersion: 1, overall: "pass" }));
});

test("private report destination rejects a directory writable outside the owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-private-report-writable-"));
  t.after(() => rm(directory, { recursive: true }));
  await chmod(directory, 0o770);
  await assert.rejects(validatePrivateReportDestination(join(directory, "report.json")), /group or other/);
});
