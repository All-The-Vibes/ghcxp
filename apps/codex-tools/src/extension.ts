import { ExtensionContext, lm, OutputChannel, window } from "vscode";
import {
	APPLY_PATCH_TOOL_NAME,
	ApplyPatchTool,
} from "./applyPatchTool.js";
import {
	PlanTool,
	UPDATE_PLAN_TOOL_NAME,
} from "./planTool.js";
import { SHELL_TOOL_NAME, ShellTool } from "./shellTool.js";

let outputChannel: OutputChannel;

export const activate = (context: ExtensionContext): void => {
	outputChannel = window.createOutputChannel("Codex Tools");

	const shellTool = new ShellTool(context, outputChannel);
	const applyPatchTool = new ApplyPatchTool(context, outputChannel);
	const planTool = new PlanTool(context, outputChannel);

	context.subscriptions.push(
		lm.registerTool(SHELL_TOOL_NAME, shellTool),
		lm.registerTool(APPLY_PATCH_TOOL_NAME, applyPatchTool),
		lm.registerTool(UPDATE_PLAN_TOOL_NAME, planTool),
	);

	outputChannel.appendLine("Extension activated.");
};

export const deactivate = (): void => {
	outputChannel.appendLine("Extension deactivated.");
};