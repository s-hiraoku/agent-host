import * as vscode from "vscode";
import { runCursorCompanionProbe } from "./probe.js";

let output;

async function runAndPersist(context) {
  output ??= vscode.window.createOutputChannel("Agent Host Cursor Companion");
  const result = await runCursorCompanionProbe(vscode);
  const encoded = new TextEncoder().encode(`${JSON.stringify(result, null, 2)}\n`);
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  const destination = vscode.Uri.joinPath(context.globalStorageUri, "probe-result.json");
  await vscode.workspace.fs.writeFile(destination, encoded);
  output.clear();
  output.appendLine(JSON.stringify(result, null, 2));
  output.appendLine(`Probe result saved to ${destination.fsPath}`);
  return result;
}

export async function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand(
    "agentHost.cursorCompanion.runProbe",
    () => runAndPersist(context),
  ));
  try {
    await runAndPersist(context);
  } catch (error) {
    output ??= vscode.window.createOutputChannel("Agent Host Cursor Companion");
    output.appendLine(`Probe failed: ${String(error?.message ?? error)}`);
  }
}

export function deactivate() {
  output?.dispose();
  output = undefined;
}
