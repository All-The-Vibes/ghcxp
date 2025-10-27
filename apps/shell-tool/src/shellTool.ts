import { stat } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
	ApplyPatchExecutor,
	detectPatchInvocation,
	type PatchInvocation,
} from "./applyPatch.js";
import { CommandRunner, type CommandRunResult } from "./commandRunner.js";
import { PythonEnvironmentManager } from "./pythonEnv.js";
import { type ShellToolInput, shellToolInputSchema } from "./schema.js";

export const SHELL_TOOL_NAME = "shell";

const DEFAULT_TIMEOUT_MS = 60000;
const TIMEOUT_CEILING_MS = 120000;
const OUTPUT_TAIL_LINES = 10;
const OUTPUT_TAIL_CHARS = 2000;

type FilesystemMode = "workspace-write" | "read-only" | "danger-full-access";
type NetworkMode = "restricted" | "enabled";
type ApprovalMode = "untrusted" | "on-request" | "on-failure" | "never";

const DEFAULT_POLICY: {
	filesystem: FilesystemMode;
	network: NetworkMode;
	approval: ApprovalMode;
} = {
	filesystem: "workspace-write",
	network: "restricted",
	approval: "on-request",
};

type ApprovalDecision = {
	requireApproval: boolean;
	reason?: string;
};

type ResolvedWorkdir = {
	path: string;
	usedDefault: boolean;
};

export class ShellTool implements vscode.LanguageModelTool<ShellToolInput> {
	public readonly name = SHELL_TOOL_NAME;

	private readonly commandRunner = new CommandRunner();
	private readonly pythonEnv: PythonEnvironmentManager;
	private readonly applyPatchExecutor: ApplyPatchExecutor;
	private busy = false;

	constructor(context: vscode.ExtensionContext) {
		this.pythonEnv = new PythonEnvironmentManager(context);
		this.applyPatchExecutor = new ApplyPatchExecutor(context, this.pythonEnv);
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ShellToolInput>,
	): Promise<vscode.PreparedToolInvocation | undefined> {
		const parsed = shellToolInputSchema.safeParse(options.input);
		if (!parsed.success) {
			throw new Error(
				parsed.error.issues.map((issue) => issue.message).join("; "),
			);
		}

		const folder = ensureWorkspaceFolder();
		const resolved = await resolveWorkdir(folder, parsed.data.workdir);
		const commandPreview = formatCommandPreview(parsed.data.command);
		const message = new vscode.MarkdownString(
			`Run \`${commandPreview}\` from \`${resolved.path}\`?`,
		);
		message.isTrusted = false;

		return {
			invocationMessage: `Running ${commandPreview}`,
			confirmationMessages: {
				title: "Run shell command",
				message,
			},
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ShellToolInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const warnings: string[] = [];
		let parsed: ShellToolInput;
		try {
			parsed = shellToolInputSchema.parse(options.input);
		} catch (error) {
			return this.asResult(`Failed: ${(error as Error).message}`);
		}

		const folder = ensureWorkspaceFolder();
		let resolvedWorkdir: ResolvedWorkdir;
		try {
			resolvedWorkdir = await resolveWorkdir(folder, parsed.workdir);
			if (resolvedWorkdir.usedDefault) {
				warnings.push(`Using default workdir: ${resolvedWorkdir.path}`);
			}
		} catch (error) {
			return this.asResult(`Failed: ${(error as Error).message}`);
		}

		const timeoutMs = Math.min(
			parsed.timeout_ms ?? DEFAULT_TIMEOUT_MS,
			TIMEOUT_CEILING_MS,
		);
		const invocationToken = (options as { toolInvocationToken?: unknown })
			.toolInvocationToken;

		let patchInfo: PatchInvocation | undefined;
		try {
			patchInfo = detectPatchInvocation(parsed.command);
		} catch (error) {
			return this.asResult((error as Error).message);
		}

		if (patchInfo) {
			return this.executePatch(patchInfo, folder.uri.fsPath, token);
		}

		const approvalDecision = evaluateApprovalNeed(parsed, folder.uri.fsPath);
		if (approvalDecision.requireApproval) {
			const allowed = await requestApproval(
				parsed,
				resolvedWorkdir.path,
				approvalDecision.reason,
			);
			if (!allowed) {
				return this.asResult("Failed: approval denied by user.");
			}
		}

		if (this.busy) {
			return this.asResult(
				"Failed: shell tool is already running another command. Please retry in a moment.",
			);
		}

		this.busy = true;
		try {
			const result = await this.commandRunner.run({
				command: parsed.command,
				workdir: resolvedWorkdir.path,
				explanation: buildExplanation(parsed.command),
				timeoutMs,
				toolInvocationToken: invocationToken,
				token,
			});
			return this.asResult(
				formatCommandSummary(
					parsed.command,
					resolvedWorkdir.path,
					result,
					warnings,
					timeoutMs,
				),
			);
		} catch (error) {
			return this.asResult(`Failed: ${(error as Error).message}`);
		} finally {
			this.busy = false;
		}
	}

	private async executePatch(
		patch: PatchInvocation,
		workspaceRoot: string,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		if (this.busy) {
			return this.asResult(
				"Failed: shell tool is already running another command. Please retry in a moment.",
			);
		}

		this.busy = true;
		try {
			await this.applyPatchExecutor.apply(
				patch.patchText,
				workspaceRoot,
				token,
			);
			const changedList =
				patch.changedFiles.length > 0
					? truncateList(patch.changedFiles, 5).join(", ")
					: "(paths unavailable)";
			const summary = `Success. Applied patch via apply_patch.py. Files touched: ${changedList}.`;
			return this.asResult(summary);
		} catch (error) {
			return this.asResult(
				(error as Error).message.startsWith("Failed:")
					? (error as Error).message
					: `Failed: ${(error as Error).message}`,
			);
		} finally {
			this.busy = false;
		}
	}

	private asResult(message: string): vscode.LanguageModelToolResult {
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(message),
		]);
	}
}

const ensureWorkspaceFolder = (): vscode.WorkspaceFolder => {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		throw new Error("Open a workspace folder before invoking the shell tool.");
	}
	return folders[0];
};

const resolveWorkdir = async (
	folder: vscode.WorkspaceFolder,
	requested?: string,
): Promise<ResolvedWorkdir> => {
	const basePath = folder.uri.fsPath;
	if (!requested || requested.trim().length === 0) {
		await ensureDirectory(basePath);
		return { path: basePath, usedDefault: true };
	}

	const candidate = path.isAbsolute(requested)
		? requested
		: path.join(basePath, requested);
	const normalized = path.normalize(candidate);
	if (!isSubPath(normalized, basePath)) {
		throw new Error("Failed: workdir must stay inside the current workspace.");
	}

	await ensureDirectory(normalized);
	return { path: normalized, usedDefault: false };
};

const ensureDirectory = async (directory: string): Promise<void> => {
	try {
		const stats = await stat(directory);
		if (!stats.isDirectory()) {
			throw new Error(`Failed: ${directory} is not a directory.`);
		}
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code === "ENOENT") {
			throw new Error(`Failed: directory ${directory} does not exist.`);
		}
		throw new Error(
			`Failed: unable to access ${directory}: ${nodeError.message}`,
		);
	}
};

const isSubPath = (target: string, base: string): boolean => {
	const normalizedBase = path.resolve(base);
	const normalizedTarget = path.resolve(target);
	if (process.platform === "win32") {
		return normalizedTarget
			.toLowerCase()
			.startsWith(normalizedBase.toLowerCase());
	}
	return normalizedTarget.startsWith(normalizedBase);
};

const buildExplanation = (command: readonly string[]): string => {
	return `Run ${formatCommandPreview(command)}`;
};

const formatCommandPreview = (command: readonly string[]): string => {
	return command.join(" ");
};

const evaluateApprovalNeed = (
	input: ShellToolInput,
	workspaceRoot: string,
): ApprovalDecision => {
	const reasons: string[] = [];
	const normalizedCommand = input.command.map((segment) =>
		segment.toLowerCase(),
	);
	const serialized = normalizedCommand.join(" ");

	if (input.with_escalated_permissions) {
		reasons.push("Escalated permissions requested");
	}

	if (normalizedCommand.includes("sudo")) {
		reasons.push("Command includes sudo");
	}

	if (containsPackageManager(normalizedCommand)) {
		reasons.push("Package manager or system tool requested");
	}

	if (invokesDestructiveRm(normalizedCommand)) {
		reasons.push("Potentially destructive rm invocation");
	}

	if (DEFAULT_POLICY.network === "restricted" && touchesNetwork(serialized)) {
		reasons.push("Network access restricted by policy");
	}

	if (writesOutsideWorkspace(input.command, workspaceRoot)) {
		reasons.push("Detected absolute path outside workspace");
	}

	if (
		DEFAULT_POLICY.filesystem === "read-only" &&
		modifiesFilesystem(normalizedCommand)
	) {
		reasons.push("Filesystem set to read-only");
	}

	return {
		requireApproval: reasons.length > 0,
		reason: reasons[0],
	};
};

const containsPackageManager = (command: readonly string[]): boolean => {
	const candidates = [
		"apt",
		"apt-get",
		"yum",
		"dnf",
		"pacman",
		"apk",
		"brew",
		"npm",
		"pnpm",
		"yarn",
		"pip",
		"pip3",
		"gem",
		"cargo",
		"kubectl",
		"docker",
		"helm",
		"systemctl",
		"launchctl",
	];
	return command.some((segment) => candidates.includes(segment));
};

const invokesDestructiveRm = (command: readonly string[]): boolean => {
	if (!command.includes("rm")) {
		return false;
	}
	return command.some(
		(segment) => segment.includes("-rf") || segment.includes("--recursive"),
	);
};

const touchesNetwork = (serialized: string): boolean => {
	return /\b(curl|wget|http|https|scp|ssh|ftp|telnet|nc)\b/.test(serialized);
};

const writesOutsideWorkspace = (
	command: readonly string[],
	workspaceRoot: string,
): boolean => {
	return command.some((segment) => {
		if (segment.startsWith("/")) {
			return !isSubPath(segment, workspaceRoot);
		}
		if (/^[A-Za-z]:\\/.test(segment)) {
			return !isSubPath(segment, workspaceRoot);
		}
		return false;
	});
};

const modifiesFilesystem = (command: readonly string[]): boolean => {
	const verbs = ["touch", "mv", "cp", "chmod", "chown", "dd"];
	return command.some((segment) => verbs.includes(segment));
};

const requestApproval = async (
	input: ShellToolInput,
	workdir: string,
	reason: string | undefined,
): Promise<boolean> => {
	const justification = input.justification ?? "(not provided)";
	const detail = [
		`Command: ${formatCommandPreview(input.command)}`,
		`Workdir: ${workdir}`,
		`Justification: ${justification}`,
	];
	if (reason) {
		detail.unshift(`Reason: ${reason}`);
	}

	const selection = await vscode.window.showWarningMessage(
		"Shell tool approval required",
		{ modal: true, detail: detail.join("\n") },
		"Allow",
		"Deny",
	);
	return selection === "Allow";
};

const formatCommandSummary = (
	command: readonly string[],
	workdir: string,
	result: CommandRunResult,
	warnings: readonly string[],
	timeoutMs: number,
): string => {
	const snippet = tailSnippet(result.stdout || result.stderr);

	if (result.timedOut) {
		return withWarnings(
			`Failed: timeout after ${timeoutMs} ms.${snippet ? ` Last output:\n${snippet}` : ""}\nCommand: ${formatCommandPreview(command)}\nWorkdir: ${workdir}`,
			warnings,
		);
	}

	if (result.cancelled) {
		return withWarnings(
			`Failed: command cancelled.${snippet ? ` Last output:\n${snippet}` : ""}\nCommand: ${formatCommandPreview(command)}\nWorkdir: ${workdir}`,
			warnings,
		);
	}

	if (!result.success) {
		const exitInfo =
			typeof result.exitCode === "number"
				? `exit ${result.exitCode}`
				: "exit unknown";
		return withWarnings(
			`Failed (${exitInfo}): ${snippet || "(no output)"}\nCommand: ${formatCommandPreview(command)}\nWorkdir: ${workdir}`,
			warnings,
		);
	}

	const exitInfo =
		typeof result.exitCode === "number"
			? `Exit ${result.exitCode}`
			: "Exit unknown";
	return withWarnings(
		`Success. ${exitInfo}. ${snippet ? `Tail:\n${snippet}` : "(no output)"}\nCommand: ${formatCommandPreview(command)}\nWorkdir: ${workdir}`,
		warnings,
	);
};

const tailSnippet = (text: string): string => {
	if (!text || text.trim().length === 0) {
		return "";
	}

	const lines = text.trim().split(/\r?\n/);
	const tail = lines.slice(-OUTPUT_TAIL_LINES).join("\n");
	if (tail.length > OUTPUT_TAIL_CHARS) {
		return tail.slice(-OUTPUT_TAIL_CHARS);
	}
	return tail;
};

const withWarnings = (message: string, warnings: readonly string[]): string => {
	if (!warnings.length) {
		return message;
	}
	const formatted = warnings.map((warning) => `- ${warning}`).join("\n");
	return `${message}\nWarnings:\n${formatted}`;
};

const truncateList = (values: readonly string[], max: number): string[] => {
	if (values.length <= max) {
		return [...values];
	}
	const head = values.slice(0, max - 1);
	return [...head, `...(+${values.length - head.length} more)`];
};
