import { AgentRegistry } from "./core/registry.js";
import { createRuntimeAdapters } from "./runtime.js";
import { createAgentServer } from "./http/server.js";
import {
  defaultPaths,
  loadConfiguration,
  parseCommandLine,
  serializableConfiguration,
} from "./config.js";
import { acquireInstanceLock, inspectInstanceLock } from "./instance-lock.js";
import { createMacosServiceController } from "./macos-service.js";
import {
  ensurePrivateDirectory,
  readPrivateFile,
  readOrCreateToken,
  rotateToken,
  writePrivateFileAtomic,
} from "./secure-state.js";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { AGENT_HOST_VERSION, OperationsContext } from "./operations/context.js";
import { createRedactor } from "./operations/redact.js";
import { publicReleaseInfo } from "./release-info.js";

const DEFAULT_CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));
const PACKAGED_DASHBOARD_PATH = fileURLToPath(new URL("../dashboard", import.meta.url));

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const processLike = dependencies.processLike ?? process;
  const output = dependencies.output ?? ((value) => console.log(value));
  const errorOutput = dependencies.errorOutput ?? ((value) => console.error(value));
  const parsed = parseCommandLine(argv);
  const print = (value) => output(parsed.options.json ? JSON.stringify(value) : formatResult(value));
  const service = dependencies.service ?? createMacosServiceController({
    platform: dependencies.platform,
    uid: dependencies.uid,
    run: dependencies.runLaunchctl,
  });
  const servicePaths = defaultPaths(dependencies.homeDirectory);
  if (parsed.command === "version") {
    print(publicReleaseInfo());
    return 0;
  }
  if (parsed.command === "start") {
    print(await service.start(servicePaths.launchAgentFile));
    return 0;
  }
  if (parsed.command === "stop") {
    print(await service.stop(servicePaths.launchAgentFile));
    return 0;
  }
  if (parsed.command === "restart") {
    print(await service.restart(servicePaths.launchAgentFile));
    return 0;
  }
  const loaded = await loadConfiguration({
    cli: parsed.options,
    env,
    homeDirectory: dependencies.homeDirectory,
    allowMissingExplicit: parsed.command === "init"
      || (parsed.command === "service" && parsed.positionals[0] === "install"),
  });
  const { configuration, configFile, paths } = loaded;

  if (parsed.command === "init") {
    const result = await initializeState(loaded);
    print(result);
    return 0;
  }
  if (parsed.command === "config") {
    const [operation = "show"] = parsed.positionals;
    if (operation !== "show" && operation !== "validate") {
      throw new Error("usage: agent-host config <show|validate>");
    }
    print({ valid: true, configFile, configuration: serializableConfiguration(configuration) });
    return 0;
  }
  if (parsed.command === "diagnostics") {
    const outputFile = resolve(parsed.positionals[0] ?? join(paths.stateDirectory, "diagnostics.json"));
    const token = env.AGENT_HOST_API_TOKEN?.trim()
      || await readPrivateFile(configuration.tokenFile).then((value) => value.trim()).catch(() => undefined);
    const redact = createRedactor({
      homeDirectory: dependencies.homeDirectory ?? homedir(),
      secrets: token ? [token] : [],
      paths: privatePaths(configuration),
    });
    const diagnosticsFetcher = dependencies.fetchDiagnostics ?? fetchDiagnostics;
    const remote = token ? await diagnosticsFetcher(configuration, token).catch(() => undefined) : undefined;
    let serviceState = { installed: false, running: false, plistPath: paths.launchAgentFile };
    if (!remote && (dependencies.platform ?? process.platform) === "darwin") {
      serviceState = await service.status(paths.launchAgentFile).catch((error) => ({
        installed: false, running: false, error,
      }));
    }
    const bundle = redact(remote ?? {
      generatedAt: new Date().toISOString(),
      versions: {
        agentHost: AGENT_HOST_VERSION,
        ...publicReleaseInfo(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      configuration: diagnosticConfiguration(configuration),
      lock: publicLock(await inspectInstanceLock(configuration.lockFile, dependencies.lockOptions)),
      service: serviceState,
      recentLogs: await readRecentLogs(configuration.logFile),
      state: "offline",
    });
    await writePrivateFileAtomic(outputFile, `${JSON.stringify(bundle, null, 2)}\n`);
    print({ created: true, path: outputFile, source: remote ? "running" : "offline" });
    return 0;
  }
  if (parsed.command === "serve" || parsed.command === "demo") {
    await runForeground({
      configuration,
      demoMode: parsed.command === "demo" || env.AGENT_HOST_DEMO === "1",
      env,
      processLike,
      output,
      makeRegistry: dependencies.makeRegistry,
      makeServer: dependencies.makeServer,
      acquireLock: dependencies.acquireLock,
      operations: dependencies.operations,
      homeDirectory: dependencies.homeDirectory ?? homedir(),
    });
    return 0;
  }
  if (parsed.command === "list") {
    const registry = makeRegistry(configuration, false, dependencies.makeRegistry);
    try {
      await registry.refresh();
      print({ agents: (await registry.listView("recent")).agents });
      return 0;
    } finally { await registry.close(); }
  }
  if (parsed.command === "action") {
    const [id, action, ...rest] = parsed.positionals;
    if (!id || !action) throw new Error("usage: agent-host action <agent-id> <action> [payload-json]");
    const payload = rest.length ? JSON.parse(rest.join(" ")) : undefined;
    const registry = makeRegistry(configuration, false, dependencies.makeRegistry);
    try {
      await registry.refresh();
      const result = await registry.action(id, action, payload);
      print(result);
      return result.ok ? 0 : 1;
    } finally { await registry.close(); }
  }
  if (parsed.command === "status") {
    const lock = await inspectInstanceLock(configuration.lockFile, dependencies.lockOptions);
    let serviceState = { installed: false, running: false, plistPath: paths.launchAgentFile };
    if ((dependencies.platform ?? process.platform) === "darwin") {
      serviceState = await service.status(paths.launchAgentFile);
    }
    let state = lock.state === "running" || serviceState.running ? "running" : "stopped";
    if (lock.state === "stale") state = "stale-lock";
    if (state === "running" && dependencies.healthCheck !== false) {
      const healthy = await (dependencies.healthCheck ?? checkHealth)(configuration).catch(() => false);
      if (!healthy) state = "unhealthy";
    }
    print({ state, lock: publicLock(lock), service: serviceState });
    return state === "running" ? 0 : state === "unhealthy" ? 4 : 3;
  }
  if (parsed.command === "service") {
    const [operation] = parsed.positionals;
    if (operation === "install") {
      await initializeState(loaded);
      print(await service.install({
        plistPath: paths.launchAgentFile,
        nodePath: dependencies.nodePath ?? process.execPath,
        cliPath: dependencies.cliPath ?? DEFAULT_CLI_PATH,
        launcherPath: dependencies.launcherPath ?? env.AGENT_HOST_LAUNCHER_PATH,
        configPath: configFile,
        dashboardDirectory: configuration.dashboardDirectory,
        logFile: `${configuration.logFile}.console`,
      }));
      return 0;
    }
    if (operation === "uninstall") {
      const result = await service.uninstall(paths.launchAgentFile);
      print({ ...result, preserved: [configFile, configuration.tokenFile] });
      return 0;
    }
    throw new Error("usage: agent-host service <install|uninstall>");
  }
  if (parsed.command === "token") {
    if (parsed.positionals[0] !== "rotate") throw new Error("usage: agent-host token rotate");
    if (env.AGENT_HOST_API_TOKEN?.trim()) {
      throw new Error("AGENT_HOST_API_TOKEN overrides the token file; unset it before rotating the persistent token");
    }
    const lock = await inspectInstanceLock(configuration.lockFile, dependencies.lockOptions);
    if (lock.state === "running") {
      throw new Error("stop agent-host before rotating its token, then start it again");
    }
    await rotateToken(configuration.tokenFile);
    print({ rotated: true, tokenFile: configuration.tokenFile, restartRequired: true });
    return 0;
  }
  errorOutput(`unknown command: ${parsed.command}`);
  return 2;
}

async function initializeState({ configuration, configFile, configExists }) {
  await ensurePrivateDirectory(dirname(configFile));
  if (!configExists) {
    await writePrivateFileAtomic(configFile, `${JSON.stringify(serializableConfiguration(configuration), null, 2)}\n`);
  }
  await readOrCreateToken(configuration.tokenFile);
  return { initialized: true, configFile, tokenFile: configuration.tokenFile, configCreated: !configExists };
}

async function runForeground(options) {
  const lock = await (options.acquireLock ?? acquireInstanceLock)(options.configuration.lockFile);
  let registry;
  let server;
  let operations;
  try {
    const token = options.env.AGENT_HOST_API_TOKEN?.trim()
      || await readOrCreateToken(options.configuration.tokenFile);
    operations = options.operations ?? new OperationsContext({
      logFile: options.configuration.logFile,
      logLevel: options.configuration.logLevel,
      homeDirectory: options.homeDirectory,
      secrets: [token],
      paths: privatePaths(options.configuration),
    });
    registry = makeRegistry(options.configuration, options.demoMode, options.makeRegistry, operations);
    server = (options.makeServer ?? createAgentServer)(registry, {
      host: options.configuration.bind,
      port: options.configuration.port,
      refreshMs: options.configuration.refreshMs,
      apiToken: token,
      allowedOrigins: options.configuration.allowedOrigins,
      operations,
      diagnosticsConfiguration: diagnosticConfiguration(options.configuration),
      dashboardDirectory: options.configuration.dashboardDirectory
        ?? (existsSync(PACKAGED_DASHBOARD_PATH) ? PACKAGED_DASHBOARD_PATH : undefined),
    });
    await server.start();
  } catch (error) {
    try {
      if (server) await server.stop();
      else await registry?.close?.();
    } finally {
      operations?.close?.();
      await lock.release();
    }
    if (error?.code === "EADDRINUSE") {
      throw new Error(`port ${options.configuration.port} is already in use on ${options.configuration.bind}`, { cause: error });
    }
    throw error;
  }
  let stopping;
  const stop = () => {
    stopping ??= Promise.resolve().then(async () => {
      try { await server.stop(); }
      finally { await lock.release(); }
    });
    return stopping;
  };
  const displayHost = options.configuration.bind.includes(":")
    ? `[${options.configuration.bind}]`
    : options.configuration.bind;
  options.output(`[agent-host] listening on http://${displayHost}:${options.configuration.port}`);
  options.output(`[agent-host] config ${JSON.stringify(publicConfiguration(options.configuration))}`);
  if (options.demoMode) options.output("[agent-host] deterministic demo mode enabled; live adapters are disabled");
  try { await waitForSignal(options.processLike); }
  finally { await stop(); }
}

function makeRegistry(configuration, demoMode, factory, operations) {
  if (factory) return factory(configuration, demoMode, operations);
  return new AgentRegistry(createRuntimeAdapters({
    demoMode,
    codexTransport: configuration.codexTransport,
    codexSocket: configuration.codexSocket,
    enabledAdapters: configuration.enabledAdapters,
  }), { adapterTimeoutMs: configuration.adapterTimeoutMs, operations });
}

function waitForSignal(processLike) {
  return new Promise((resolve) => {
    const done = () => {
      processLike.removeListener("SIGINT", done);
      processLike.removeListener("SIGTERM", done);
      resolve();
    };
    processLike.once("SIGINT", done);
    processLike.once("SIGTERM", done);
  });
}

async function checkHealth(configuration) {
  const host = configuration.bind === "::1" ? "[::1]" : configuration.bind;
  const response = await fetch(`http://${host}:${configuration.port}/health`, {
    signal: AbortSignal.timeout(750),
  });
  return response.ok;
}

function publicConfiguration(configuration) {
  return {
    bind: configuration.bind,
    port: configuration.port,
    refreshMs: configuration.refreshMs,
    adapterTimeoutMs: configuration.adapterTimeoutMs,
    enabledAdapters: configuration.enabledAdapters,
    codexTransport: configuration.codexTransport,
    logLevel: configuration.logLevel,
  };
}

function diagnosticConfiguration(configuration) {
  return {
    bind: configuration.bind,
    port: configuration.port,
    refreshMs: configuration.refreshMs,
    adapterTimeoutMs: configuration.adapterTimeoutMs,
    enabledAdapters: configuration.enabledAdapters,
    codexTransport: configuration.codexTransport,
    codexSocket: configuration.codexSocket,
    tokenFile: configuration.tokenFile,
    lockFile: configuration.lockFile,
    logLevel: configuration.logLevel,
    logFile: configuration.logFile,
    dashboardUrl: configuration.dashboardUrl,
    dashboardDirectory: configuration.dashboardDirectory,
    allowedOrigins: configuration.allowedOrigins,
  };
}

function privatePaths(configuration) {
  return [
    configuration.codexSocket,
    configuration.tokenFile,
    configuration.lockFile,
    configuration.logFile,
    configuration.dashboardDirectory,
  ]
    .filter(Boolean);
}

async function fetchDiagnostics(configuration, token) {
  const host = configuration.bind === "::1" ? "[::1]" : configuration.bind;
  const response = await fetch(`http://${host}:${configuration.port}/v1/diagnostics`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error(`diagnostics endpoint returned ${response.status}`);
  return (await response.json()).diagnostics;
}

async function readRecentLogs(logFile) {
  const records = [];
  for (const path of [`${logFile}.2`, `${logFile}.1`, logFile]) {
    let content;
    try { content = await readPrivateFile(path); }
    catch (error) { if (error?.code === "ENOENT") continue; else throw error; }
    for (const line of content.split("\n")) {
      if (!line) continue;
      try { records.push(JSON.parse(line)); }
      catch { records.push({ level: "warn", event: "log.unparseable", details: { file: basename(path) } }); }
    }
  }
  return records.slice(-200);
}

function publicLock(lock) {
  return {
    state: lock.state,
    path: lock.path,
    pid: lock.record?.pid,
    startedAt: lock.record?.startedAt,
  };
}

function formatResult(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
