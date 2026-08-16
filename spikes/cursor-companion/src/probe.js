const RELEVANT_COMMAND = /(?:agent|composer|chat|cursor).*(?:session|turn|prompt|interrupt|approve|focus)|(?:session|turn|prompt|interrupt|approve|focus).*(?:agent|composer|chat|cursor)/i;
const MAX_COMMANDS = 200;
const MAX_PROPERTIES = 200;

function errorView(error) {
  const message = String(error?.message ?? error).replace(/\s+/g, " ").trim().slice(0, 500);
  return {
    name: String(error?.name ?? "Error").slice(0, 100),
    code: typeof error?.code === "string" ? error.code.slice(0, 100) : undefined,
    category: /only available for built-in extensions/i.test(message) ? "builtin-only-proposal" : undefined,
    message,
  };
}

function propertyNames(value) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return [];
  const names = new Set();
  let current = value;
  for (let depth = 0; current && current !== Object.prototype && depth < 4; depth += 1) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name !== "constructor") names.add(name);
    }
    current = Object.getPrototypeOf(current);
  }
  return [...names].sort().slice(0, MAX_PROPERTIES);
}

async function attempt(operation) {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: errorView(error) };
  }
}

function valueSummary(value) {
  if (value === null) return { type: "null" };
  const type = typeof value;
  if (type !== "object" && type !== "function") return { type, value: type === "string" ? value.slice(0, 200) : value };
  return { type, properties: propertyNames(value) };
}

async function inspectCursorApi(vscode) {
  const cursor = vscode.cursor;
  if (!cursor) return { present: false, properties: [], checks: {} };

  const enabled = await attempt(() => cursor.cursorAgentHostEnabled);
  const runtime = typeof cursor.acquireAgentHostRuntime === "function"
    ? await attempt(() => cursor.acquireAgentHostRuntime())
    : { ok: false, error: { name: "Unavailable", message: "acquireAgentHostRuntime is not a function" } };

  return {
    present: true,
    properties: propertyNames(cursor),
    checks: {
      cursorAgentHostEnabled: enabled.ok
        ? { ok: true, result: valueSummary(enabled.value) }
        : enabled,
      acquireAgentHostRuntime: runtime.ok
        ? { ok: true, result: valueSummary(runtime.value) }
        : runtime,
    },
    mutatingChecksSkipped: ["registerAgentHostProvider", "registerAgentHostRuntime"],
  };
}

async function inspectBuiltinExtension(vscode) {
  const extension = vscode.extensions.getExtension("anysphere.cursor-agent-host");
  if (!extension) return { installed: false };
  const activation = await attempt(() => extension.activate());
  return {
    installed: true,
    active: extension.isActive,
    extensionPathKind: typeof extension.extensionPath,
    declaredProposals: Array.isArray(extension.packageJSON?.enabledApiProposals)
      ? [...extension.packageJSON.enabledApiProposals].sort()
      : [],
    activation: activation.ok
      ? { ok: true, exports: propertyNames(activation.value) }
      : activation,
  };
}

export async function runCursorCompanionProbe(vscode, now = () => new Date()) {
  const commands = await attempt(() => vscode.commands.getCommands(true));
  const relevantCommands = commands.ok && Array.isArray(commands.value)
    ? commands.value.filter((command) => RELEVANT_COMMAND.test(command)).sort().slice(0, MAX_COMMANDS)
    : [];

  return {
    schemaVersion: 1,
    recordedAt: now().toISOString(),
    host: {
      appName: vscode.env.appName,
      appHost: vscode.env.appHost,
      appRootKind: typeof vscode.env.appRoot,
      remoteName: vscode.env.remoteName ?? null,
      vscodeVersion: vscode.version,
    },
    cursorApi: await inspectCursorApi(vscode),
    builtinAgentHost: await inspectBuiltinExtension(vscode),
    commands: commands.ok
      ? { ok: true, relevant: relevantCommands, truncated: relevantCommands.length >= MAX_COMMANDS }
      : commands,
  };
}
