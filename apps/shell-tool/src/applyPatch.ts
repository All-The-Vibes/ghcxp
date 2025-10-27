import { spawn } from "node:child_process";
import path from "node:path";
import * as vscode from "vscode";
import type { PythonEnvironmentManager } from "./pythonEnv.js";

const PATCH_BEGIN = "*** Begin Patch";
const PATCH_END = "*** End Patch";
const APPLY_PATCH = "apply_patch";
const HEREDOC_PATTERN = /apply_patch\s+<<\s*(['"]?)(?<token>[A-Za-z0-9_-]+)\1/;
const DIRECT_FILE_PATTERN = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
const MOVE_FILE_PATTERN = /^\*\*\* Move to: (.+)$/gm;

export type PatchInvocation = {
	patchText: string;
	changedFiles: string[];
};

export const detectPatchInvocation = (
	command: readonly string[],
): PatchInvocation | undefined => {
	if (command.length === 0) {
		return undefined;
	}

	const direct = detectDirectPatch(command);
	if (direct) {
		return direct;
	}

	return detectHeredocPatch(command);
};

const detectDirectPatch = (
	command: readonly string[],
): PatchInvocation | undefined => {
	if (command[0] !== APPLY_PATCH || command.length < 2) {
		return undefined;
	}

	const candidate = command.slice(1).join("\n");
	if (!candidate.includes(PATCH_BEGIN) || !candidate.includes(PATCH_END)) {
		return undefined;
	}

	const changedFiles = extractPatchPaths(candidate);
	return { patchText: candidate, changedFiles };
};

const detectHeredocPatch = (
	command: readonly string[],
): PatchInvocation | undefined => {
	if (command.length < 2) {
		return undefined;
	}

	const script = command[command.length - 1];
	if (!script.includes(APPLY_PATCH) || !script.includes(PATCH_BEGIN)) {
		return undefined;
	}

	const match = HEREDOC_PATTERN.exec(script);
	if (!match || !match.groups?.token) {
		return undefined;
	}

	const token = match.groups.token;
	const firstNewline = script.indexOf("\n");
	if (firstNewline === -1) {
		return undefined;
	}

	const body = script.slice(firstNewline + 1);
	const lines = body.split(/\r?\n/);
	const closingIndex = lines.lastIndexOf(token);
	if (closingIndex === -1) {
		return undefined;
	}

	const patchLines = lines.slice(0, closingIndex);
	const patchText = patchLines.join("\n");
	if (!patchText.includes(PATCH_BEGIN) || !patchText.includes(PATCH_END)) {
		return undefined;
	}

	const changedFiles = extractPatchPaths(patchText);
	return { patchText, changedFiles };
};

const sanitizePatchPath = (input: string): string => {
	const normalized = input.replace(/\\/g, "/");
	return normalized;
};

const isSafeRelativePath = (input: string): boolean => {
	if (input.startsWith("/") || input.startsWith("\\")) {
		return false;
	}

	const normalized = path.posix.normalize(input);
	if (
		normalized === ".." ||
		normalized.startsWith("../") ||
		normalized.includes("/../")
	) {
		return false;
	}

	return true;
};

const extractPatchPaths = (patch: string): string[] => {
	const files = new Set<string>();
	DIRECT_FILE_PATTERN.lastIndex = 0;
	MOVE_FILE_PATTERN.lastIndex = 0;

	while (true) {
		const directMatch = DIRECT_FILE_PATTERN.exec(patch);
		if (!directMatch) {
			break;
		}
		const rawPath = sanitizePatchPath(directMatch[2].trim());
		if (!isSafeRelativePath(rawPath)) {
			throw new Error(
				`Failed: patch path "${rawPath}" must stay within the workspace.`,
			);
		}
		files.add(rawPath);
	}

	while (true) {
		const moveMatch = MOVE_FILE_PATTERN.exec(patch);
		if (!moveMatch) {
			break;
		}
		const movePath = sanitizePatchPath(moveMatch[1].trim());
		if (!isSafeRelativePath(movePath)) {
			throw new Error(
				`Failed: move target "${movePath}" must stay within the workspace.`,
			);
		}
		files.add(movePath);
	}

	return Array.from(files);
};

const ensurePatchEnvelope = (patchText: string): void => {
	if (
		!patchText.trim().startsWith(PATCH_BEGIN) ||
		!patchText.trim().endsWith(PATCH_END)
	) {
		throw new Error("Failed: invalid patch envelope.");
	}
};

const decodePythonError = (stderr: string): string => {
	if (stderr.includes("ModuleNotFoundError") && stderr.includes("pydantic")) {
		return 'Failed: python environment is missing the "pydantic" module required by apply_patch.py.';
	}
	return `Failed: apply_patch.py error:\n${stderr.trim() || "unknown error"}`;
};

const toTimeoutError = (): Error =>
	new Error("Failed: apply_patch execution timed out.");

export type ApplyPatchResult = {
	stdout: string;
	stderr: string;
};

export class ApplyPatchExecutor {
	private readonly scriptPath: string;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly pythonEnv: PythonEnvironmentManager,
	) {
		this.scriptPath = vscode.Uri.joinPath(
			this.context.extensionUri,
			"resources",
			"apply_patch.py",
		).fsPath;
	}

	async apply(
		patchText: string,
		workspaceRoot: string,
		token: vscode.CancellationToken,
	): Promise<ApplyPatchResult> {
		ensurePatchEnvelope(patchText);
		const runtime = await this.pythonEnv.ensureRuntime(token);
		return new Promise<ApplyPatchResult>((resolve, reject) => {
			const child = spawn(
				runtime.command.executable,
				[...runtime.command.args, this.scriptPath],
				{
					cwd: workspaceRoot,
					env: runtime.env,
				},
			);
			let stdout = "";
			let stderr = "";
			let finished = false;
			let timeoutHandle: NodeJS.Timeout | undefined;

			const disposeCancellation = token.onCancellationRequested(() => {
				if (!finished) {
					child.kill();
				}
			});

			child.stdout?.on("data", (buffer: Buffer) => {
				stdout += buffer.toString("utf8");
			});

			child.stderr?.on("data", (buffer: Buffer) => {
				stderr += buffer.toString("utf8");
			});

			child.on("error", (error) => {
				finished = true;
				disposeCancellation.dispose();
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
				reject(
					new Error(
						`Failed: unable to launch apply_patch.py (${(error as Error).message})`,
					),
				);
			});

			timeoutHandle = setTimeout(() => {
				if (!finished) {
					child.kill();
					reject(toTimeoutError());
				}
			}, 10000);

			child.on("close", (code) => {
				finished = true;
				disposeCancellation.dispose();
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}

				if (code === 0) {
					resolve({ stdout, stderr });
					return;
				}

				reject(new Error(decodePythonError(stderr || stdout)));
			});

			child.stdin?.write(patchText, "utf8", (error) => {
				if (error) {
					finished = true;
					child.kill();
					disposeCancellation.dispose();
					if (timeoutHandle) {
						clearTimeout(timeoutHandle);
					}
					reject(
						new Error(`Failed: unable to write patch data (${error.message})`),
					);
				} else {
					child.stdin?.end();
				}
			});
		});
	}
}
