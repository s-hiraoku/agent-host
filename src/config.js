import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readPrivateFile } from "./secure-state.js";

export const CONFIG_SCHEMA_VERSION = 1;
export const DEFAULT_ADAPTER_NAMES = ["codex", "herdr", "process"];
export const AVAILABLE_ADAPTER_NAMES = [...DEFAULT_ADAPTER_NAMES, "cursor-desktop", "cursor-sdk-bridge"];
export const ADAPTER_NAMES = AVAILABLE_ADAPTER_NAMES;
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
const CONFIG_KEYS = new Set([
  "schemaVersion",
  "bind",
  "port",
  "refreshMs",
  "adapterTimeoutMs",
  "enabledAdapters",
  "codexTransport",
  "codexSocket",
  "tokenFile",
  "lockFile",
  "logLevel",
  "logFile",
  "dashboardUrl",
  "allowedOrigins",
  "cursorSdkBridge",
]);

export class ConfigurationError extends Error {
  constructor(message, code = "invalid_configuration") {
    super(message);
    this.name = "ConfigurationError";
    this.code = code;
  }
}

export function defaultPaths(homeDirectory = homedir()) {
  const stateDirectory = join(homeDirectory, ".agent-host");
  return {
    stateDirectory,
    configFile: join(stateDirectory, "config.json"),
    tokenFile: join(stateDirectory, "token"),
    lockFile: join(stateDirectory, "agent-host.lock"),
    logFile: join(stateDirectory, "agent-host.log"),
    launchAgentFile: join(homeDirectory, "Library", "LaunchAgents", "dev.agent-host.plist"),
  };
}

export function parseCommandLine(argv = []) {
  const args = [...argv];
  const positionals = [];
  const options = {};
  let command;
  let terminated = false;
  const takeValue = (flag, index) => {
    const value = args[index + 1];
    if (value === undefined) throw new ConfigurationError(`${flag} requires a value`, "invalid_cli_argument");
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (terminated) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      terminated = true;
      continue;
    }
    if (!command && !arg.startsWith("--")) {
      command = arg;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [flag, inline] = arg.split("=", 2);
    const valueFor = () => {
      if (inline !== undefined) return inline;
      const value = takeValue(flag, index);
      index += 1;
      return value;
    };
    switch (flag) {
      case "--config": options.configFile = valueFor(); break;
      case "--bind": options.bind = valueFor(); break;
      case "--port": options.port = valueFor(); break;
      case "--refresh-ms": options.refreshMs = valueFor(); break;
      case "--adapter-timeout-ms": options.adapterTimeoutMs = valueFor(); break;
      case "--enabled-adapters": options.enabledAdapters = valueFor(); break;
      case "--codex-transport": options.codexTransport = valueFor(); break;
      case "--codex-socket": options.codexSocket = valueFor(); break;
      case "--cursor-user-data-dir": options.cursorUserDataDirectory = valueFor(); break;
      case "--cursor-projects-dir": options.cursorProjectsDirectory = valueFor(); break;
      case "--token-file": options.tokenFile = valueFor(); break;
      case "--lock-file": options.lockFile = valueFor(); break;
      case "--log-level": options.logLevel = valueFor(); break;
      case "--log-file": options.logFile = valueFor(); break;
      case "--dashboard-url": options.dashboardUrl = valueFor(); break;
      case "--dashboard-dir": options.dashboardDirectory = valueFor(); break;
      case "--report": options.reportFile = valueFor(); break;
      case "--allowed-origin": {
        options.allowedOrigins ??= [];
        options.allowedOrigins.push(valueFor());
        break;
      }
      case "--json": options.json = true; break;
      default: throw new ConfigurationError(`unknown option: ${flag}`, "invalid_cli_argument");
    }
  }
  return { command: command ?? "serve", positionals, options };
}

export async function loadConfiguration({
  cli = {},
  env = process.env,
  homeDirectory = homedir(),
  allowMissingExplicit = false,
} = {}) {
  const paths = defaultPaths(homeDirectory);
  const configuredPath = cli.configFile ?? env.AGENT_HOST_CONFIG;
  const configFile = configuredPath ? resolve(configuredPath) : paths.configFile;
  let fileConfig = {};
  let configExists = true;
  try {
    fileConfig = JSON.parse(await readPrivateFile(configFile));
  } catch (error) {
    if (error?.code === "ENOENT" && (!configuredPath || allowMissingExplicit)) configExists = false;
    else if (error?.code === "ENOENT") {
      throw new ConfigurationError(`configuration file does not exist: ${configFile}`, "configuration_not_found");
    } else if (error instanceof SyntaxError) {
      throw new ConfigurationError(`configuration file is not valid JSON: ${configFile}`);
    } else {
      throw error;
    }
  }
  validateFileShape(fileConfig, configFile, configExists);
  const environment = environmentConfiguration(env);
  const baseDirectory = dirname(configFile);
  const cursorPaths = defaultCursorDirectories(homeDirectory, env);
  const defaults = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    bind: "127.0.0.1",
    port: 4777,
    refreshMs: 1_500,
    adapterTimeoutMs: 20_000,
    enabledAdapters: [...DEFAULT_ADAPTER_NAMES],
    codexTransport: "owned",
    codexSocket: undefined,
    tokenFile: join(baseDirectory, "token"),
    lockFile: join(baseDirectory, "agent-host.lock"),
    logLevel: "info",
    logFile: join(baseDirectory, "agent-host.log"),
    dashboardUrl: undefined,
    dashboardDirectory: undefined,
    cursorUserDataDirectory: cursorPaths.userDataDirectory,
    cursorProjectsDirectory: cursorPaths.projectsDirectory,
    allowedOrigins: [],
    cursorSdkBridge: undefined,
  };
  const merged = { ...defaults, ...fileConfig, ...environment, ...withoutUndefined(cli) };
  delete merged.configFile;
  delete merged.json;
  delete merged.reportFile;
  merged.tokenFile = resolvePathBySource("tokenFile", { cli, environment, fileConfig, defaults, baseDirectory });
  merged.lockFile = resolvePathBySource("lockFile", { cli, environment, fileConfig, defaults, baseDirectory });
  merged.logFile = resolvePathBySource("logFile", { cli, environment, fileConfig, defaults, baseDirectory });
  if (merged.codexSocket !== undefined) {
    merged.codexSocket = resolvePathBySource("codexSocket", { cli, environment, fileConfig, defaults, baseDirectory });
  }
  if (merged.dashboardDirectory !== undefined) {
    merged.dashboardDirectory = resolvePathBySource("dashboardDirectory", { cli, environment, fileConfig, defaults, baseDirectory });
  }
  merged.cursorUserDataDirectory = resolvePathBySource(
    "cursorUserDataDirectory", { cli, environment, fileConfig, defaults, baseDirectory },
  );
  merged.cursorProjectsDirectory = resolvePathBySource(
    "cursorProjectsDirectory", { cli, environment, fileConfig, defaults, baseDirectory },
  );
  if (merged.cursorSdkBridge !== undefined) {
    merged.cursorSdkBridge = resolveCursorSdkBridge(merged.cursorSdkBridge, baseDirectory);
  }
  const configuration = validateConfiguration(merged);
  return { configuration, configFile, configExists, paths: { ...paths, stateDirectory: dirname(configFile) } };
}

export function serializableConfiguration(configuration) {
  return Object.fromEntries(Object.entries({
    schemaVersion: CONFIG_SCHEMA_VERSION,
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
    allowedOrigins: configuration.allowedOrigins,
    cursorSdkBridge: configuration.cursorSdkBridge,
  }).filter(([, value]) => value !== undefined));
}

function environmentConfiguration(env) {
  const has = (key) => Object.prototype.hasOwnProperty.call(env, key);
  const result = {};
  if (has("AGENT_HOST_BIND")) result.bind = env.AGENT_HOST_BIND;
  if (has("AGENT_HOST_PORT")) result.port = env.AGENT_HOST_PORT;
  if (has("AGENT_HOST_REFRESH_MS")) result.refreshMs = env.AGENT_HOST_REFRESH_MS;
  if (has("AGENT_HOST_ADAPTER_TIMEOUT_MS")) result.adapterTimeoutMs = env.AGENT_HOST_ADAPTER_TIMEOUT_MS;
  if (has("AGENT_HOST_ENABLED_ADAPTERS")) result.enabledAdapters = env.AGENT_HOST_ENABLED_ADAPTERS;
  if (has("AGENT_HOST_CODEX_TRANSPORT")) result.codexTransport = env.AGENT_HOST_CODEX_TRANSPORT;
  if (has("AGENT_HOST_CODEX_SOCKET")) result.codexSocket = env.AGENT_HOST_CODEX_SOCKET;
  if (has("AGENT_HOST_CURSOR_USER_DATA_DIR")) result.cursorUserDataDirectory = env.AGENT_HOST_CURSOR_USER_DATA_DIR;
  if (has("AGENT_HOST_CURSOR_PROJECTS_DIR")) result.cursorProjectsDirectory = env.AGENT_HOST_CURSOR_PROJECTS_DIR;
  if (has("AGENT_HOST_TOKEN_FILE")) result.tokenFile = env.AGENT_HOST_TOKEN_FILE;
  if (has("AGENT_HOST_LOCK_FILE")) result.lockFile = env.AGENT_HOST_LOCK_FILE;
  if (has("AGENT_HOST_LOG_LEVEL")) result.logLevel = env.AGENT_HOST_LOG_LEVEL;
  if (has("AGENT_HOST_LOG_FILE")) result.logFile = env.AGENT_HOST_LOG_FILE;
  if (has("AGENT_HOST_DASHBOARD_URL")) result.dashboardUrl = env.AGENT_HOST_DASHBOARD_URL;
  if (has("AGENT_HOST_DASHBOARD_DIR")) result.dashboardDirectory = env.AGENT_HOST_DASHBOARD_DIR;
  if (has("AGENT_HOST_ALLOWED_ORIGINS")) result.allowedOrigins = splitList(env.AGENT_HOST_ALLOWED_ORIGINS);
  return result;
}

function validateFileShape(value, path, configExists) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`configuration must be a JSON object: ${path}`);
  }
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new ConfigurationError(`unknown configuration key: ${key}`);
  }
  if (configExists && value.schemaVersion === undefined) {
    throw new ConfigurationError(`configuration schemaVersion is required: ${path}`);
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigurationError(`unsupported configuration schemaVersion: ${value.schemaVersion}`);
  }
}

function validateConfiguration(value) {
  const configuration = { ...value };
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(configuration.bind)) {
    throw new ConfigurationError("bind must be 127.0.0.1, localhost, or ::1");
  }
  configuration.port = integer(configuration.port, "port", 1, 65_535);
  configuration.refreshMs = integer(configuration.refreshMs, "refreshMs", 1);
  configuration.adapterTimeoutMs = integer(configuration.adapterTimeoutMs, "adapterTimeoutMs", 1);
  configuration.enabledAdapters = normalizeAdapters(configuration.enabledAdapters);
  if (configuration.enabledAdapters.includes("cursor-sdk-bridge") && !configuration.cursorSdkBridge) {
    throw new ConfigurationError("cursorSdkBridge is required when cursor-sdk-bridge is enabled");
  }
  if (configuration.codexTransport !== "owned" && configuration.codexTransport !== "control") {
    throw new ConfigurationError("codexTransport must be owned or control");
  }
  if (configuration.enabledAdapters.includes("codex") && configuration.codexTransport === "control"
    && !configuration.codexSocket) {
    throw new ConfigurationError("codexSocket is required when codexTransport is control");
  }
  if (!LOG_LEVELS.has(configuration.logLevel)) {
    throw new ConfigurationError("logLevel must be debug, info, warn, or error");
  }
  configuration.allowedOrigins = normalizeOrigins(configuration.allowedOrigins, "allowedOrigins");
  if (configuration.dashboardUrl !== undefined) {
    configuration.dashboardUrl = normalizeOrigin(configuration.dashboardUrl, "dashboardUrl");
    if (!configuration.allowedOrigins.includes(configuration.dashboardUrl)) {
      configuration.allowedOrigins = [...configuration.allowedOrigins, configuration.dashboardUrl];
    }
  }
  return Object.freeze(configuration);
}

function resolveCursorSdkBridge(value, baseDirectory) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError("cursorSdkBridge must be an object");
  }
  const allowed = new Set([
    "endpoint", "sdkVersion", "bearerTokenFile", "apiKeyFile", "helperPath",
    "storeDirectory", "provenanceFile", "timeoutMs", "targets",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ConfigurationError(`unknown cursorSdkBridge key: ${key}`);
  }
  let endpoint;
  try { endpoint = new URL(value.endpoint); }
  catch { throw new ConfigurationError("cursorSdkBridge.endpoint must be a literal loopback HTTP origin"); }
  const literal = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "http:" || !literal || !endpoint.port || endpoint.username || endpoint.password
    || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.origin !== value.endpoint) {
    throw new ConfigurationError("cursorSdkBridge.endpoint must be a literal loopback HTTP origin");
  }
  if (typeof value.sdkVersion !== "string"
    || value.sdkVersion.length > 64
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.sdkVersion)) {
    throw new ConfigurationError("cursorSdkBridge.sdkVersion must be explicit semver");
  }
  if (!Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > 20) {
    throw new ConfigurationError("cursorSdkBridge.targets must contain 1-20 targets");
  }
  const targetIds = new Set();
  const targets = value.targets.map((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)
      || Object.keys(target).some((key) => !["id", "cwd", "profiles"].includes(key))
      || typeof target.id !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(target.id)
      || targetIds.has(target.id) || !Array.isArray(target.profiles) || target.profiles.length < 1
      || target.profiles.length > 20 || new Set(target.profiles).size !== target.profiles.length
      || target.profiles.some((profile) => typeof profile !== "string"
        || !/^[A-Za-z0-9._:-]{1,100}$/.test(profile))) {
      throw new ConfigurationError("cursorSdkBridge.targets contains an invalid or duplicate target");
    }
    targetIds.add(target.id);
    return Object.freeze({
      id: target.id,
      cwd: resolveConfiguredPath(target.cwd, baseDirectory, "cursorSdkBridge.targets.cwd"),
      profiles: Object.freeze([...target.profiles]),
    });
  });
  const bearerTokenFile = resolveConfiguredPath(
    value.bearerTokenFile, baseDirectory, "cursorSdkBridge.bearerTokenFile",
  );
  const apiKeyFile = resolveConfiguredPath(value.apiKeyFile, baseDirectory, "cursorSdkBridge.apiKeyFile");
  if (bearerTokenFile === apiKeyFile) {
    throw new ConfigurationError("cursorSdkBridge bearer token and API key files must be separate");
  }
  return Object.freeze({
    endpoint: endpoint.origin,
    sdkVersion: value.sdkVersion,
    bearerTokenFile,
    apiKeyFile,
    helperPath: resolveConfiguredPath(value.helperPath, baseDirectory, "cursorSdkBridge.helperPath"),
    storeDirectory: resolveConfiguredPath(value.storeDirectory, baseDirectory, "cursorSdkBridge.storeDirectory"),
    provenanceFile: resolveConfiguredPath(value.provenanceFile, baseDirectory, "cursorSdkBridge.provenanceFile"),
    timeoutMs: value.timeoutMs === undefined ? 10_000 : integer(value.timeoutMs, "cursorSdkBridge.timeoutMs", 1, 60_000),
    targets: Object.freeze(targets),
  });
}

function normalizeAdapters(value) {
  const adapters = Array.isArray(value) ? value : splitList(value);
  if (!adapters.length) throw new ConfigurationError("enabledAdapters must contain at least one adapter");
  const unique = new Set();
  for (const adapter of adapters) {
    if (!AVAILABLE_ADAPTER_NAMES.includes(adapter)) throw new ConfigurationError(`unknown enabled adapter: ${adapter}`);
    if (unique.has(adapter)) throw new ConfigurationError(`duplicate enabled adapter: ${adapter}`);
    unique.add(adapter);
  }
  return [...unique];
}

function normalizeOrigins(value, name) {
  const origins = Array.isArray(value) ? value : splitList(value);
  return origins.map((origin) => normalizeOrigin(origin, name));
}

function normalizeOrigin(value, name) {
  if (typeof value !== "string" || value === "") throw new ConfigurationError(`${name} must contain canonical origins`);
  let url;
  try { url = new URL(value); }
  catch { throw new ConfigurationError(`${name} contains an invalid URL: ${value}`); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== value) {
    throw new ConfigurationError(`${name} must use canonical http(s) origins: ${value}`);
  }
  return url.origin;
}

function integer(value, name, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigurationError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function resolveConfiguredPath(value, baseDirectory, name) {
  if (typeof value !== "string" || value === "") throw new ConfigurationError(`${name} must be a non-empty path`);
  return isAbsolute(value) ? value : resolve(baseDirectory, value);
}

function defaultCursorDirectories(homeDirectory, env) {
  let userDataDirectory;
  if (process.platform === "darwin") {
    userDataDirectory = join(homeDirectory, "Library", "Application Support", "Cursor");
  } else if (process.platform === "win32") {
    userDataDirectory = join(env.APPDATA || join(homeDirectory, "AppData", "Roaming"), "Cursor");
  } else {
    userDataDirectory = join(env.XDG_CONFIG_HOME || join(homeDirectory, ".config"), "Cursor");
  }
  return {
    userDataDirectory,
    projectsDirectory: join(homeDirectory, ".cursor", "projects"),
  };
}

function resolvePathBySource(name, { cli, environment, fileConfig, defaults, baseDirectory }) {
  if (cli[name] !== undefined) return resolveConfiguredPath(cli[name], process.cwd(), name);
  if (environment[name] !== undefined) return resolveConfiguredPath(environment[name], process.cwd(), name);
  if (fileConfig[name] !== undefined) return resolveConfiguredPath(fileConfig[name], baseDirectory, name);
  return resolveConfiguredPath(defaults[name], baseDirectory, name);
}

function splitList(value) {
  if (typeof value !== "string") throw new ConfigurationError("list configuration values must be strings or arrays");
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
