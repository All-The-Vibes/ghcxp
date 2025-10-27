import * as vscode from "vscode";
import { SHELL_TOOL_NAME, ShellTool } from "./shellTool.js";

export const activate = (context: vscode.ExtensionContext): void => {
	const shellTool = new ShellTool(context);
	context.subscriptions.push(
		vscode.lm.registerTool(SHELL_TOOL_NAME, shellTool),
	);
};

export const deactivate = (): void => {
	// Nothing to clean up because tool registration is tied to the extension context.
};
