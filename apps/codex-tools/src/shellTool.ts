import * as fs from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { CancellationToken, ExtensionContext, LanguageModelTextPart, LanguageModelTool, LanguageModelToolInvocationOptions, LanguageModelToolInvocationPrepareOptions, LanguageModelToolResult, MarkdownString, OutputChannel, PreparedToolInvocation, workspace, WorkspaceFolder } from "vscode";
import { DiffError, process_patch } from "./apply_patch.js";
import { CommandRunner } from "./commandRunner.js";
import { type ShellToolInput, shellToolInputSchema } from "./schema.js";

export const SHELL_TOOL_NAME = "shell";

const DEFAULT_TIMEOUT_MS = 60000;
const TIMEOUT_CEILING_MS = 120000;
const OUTPUT_TAIL_LINES = 10;
const OUTPUT_TAIL_CHARS = 2000;

export class ShellTool implements LanguageModelTool<ShellToolInput> {
	public readonly name = SHELL_TOOL_NAME;

	private readonly commandRunner = new CommandRunner();
	private busy = false;

	constructor(_context: ExtensionContext, _outputChannel: OutputChannel) {}

	async prepareInvocation(
		options: LanguageModelToolInvocationPrepareOptions<ShellToolInput>,
	): Promise<PreparedToolInvocation | undefined> {
		const parsed = shellToolInputSchema.safeParse(options.input);
		if (!parsed.success) {
			throw new Error(
				parsed.error.issues.map((issue) => issue.message).join("; "),
			);
		}

		const folder = ensureWorkspaceFolder();
		const resolved = await resolveWorkdir(folder, parsed.data.workdir);
		const commandPreview = formatCommandPreview(parsed.data.command);
		const message = new MarkdownString(
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
		options: LanguageModelToolInvocationOptions<ShellToolInput>,
		token: CancellationToken,
	): Promise<LanguageModelToolResult> {
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

		if (this.busy) {
			return this.asResult(
				"Failed: shell tool is already running another command. Please retry in a moment.",
			);
		}

		// --- Intercept Codex-style "apply_patch <<'PATCH' ... PATCH" heredocs
		const intercepted = tryExtractApplyPatchInvocation(parsed.command);
		if (intercepted) {
			this.busy = true;
			try {
				// If the script included a leading "cd ... &&/;" apply it, but sandbox to workspace
				const effectiveRoot = await resolveWorkdirFromCd(
					resolvedWorkdir.path,
					intercepted.cdWorkdir,
				);

				// Workspace-scoped IO shims mirroring Python's behaviors
				const openFn = (rel: string): string => {
					const full = resolveInsideWorkspace(effectiveRoot, rel);
					return fs.readFileSync(full, "utf8"); // bubble ENOENT like Python open()
				};
				const writeFn = (rel: string, content: string): void => {
					// Python write_file: if absolute path is requested, print and return (no throw)
					if (path.isAbsolute(rel)) {
						console.log("We do not support absolute paths.");
						return;
					}
					const full = resolveInsideWorkspace(effectiveRoot, rel);
					const dir = path.dirname(full);
					if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
					fs.writeFileSync(full, content, "utf8");
				};
				const removeFn = (rel: string): void => {
					const full = resolveInsideWorkspace(effectiveRoot, rel);
					fs.unlinkSync(full); // bubble errors like Python os.remove
				};

				// Perform the patch (bit-identical logic & messages)
				const msg = process_patch(intercepted.patch, openFn, writeFn, removeFn); // "Done!" on success
				// Produce a synthetic shell summary to keep UX consistent with other commands
				const fakeResult: CommandRunResult = {
					success: true,
					exitCode: 0,
					timedOut: false,
					cancelled: false,
					stdout: `${msg}\n`,
					stderr: "",
					stdoutTruncated: false,
					stderrTruncated: false,
					engine: "run_in_terminal"
				};
				return this.asResult(
					formatCommandSummary(
						parsed.command,
						effectiveRoot,
						fakeResult,
						warnings,
						timeoutMs,
					),
				);
			} catch (error) {
				// For parity with Python's main(): show DiffError message as the command "output"
				if (error instanceof DiffError) {
					const fakeResult: CommandRunResult = {
						success: false,
						exitCode: 1,
						timedOut: false,
						cancelled: false,
						stdout: "",
						stderr: String(error.message),
						stdoutTruncated: false,
						stderrTruncated: false,
						engine: "run_in_terminal"
					};
					return this.asResult(
						formatCommandSummary(
							parsed.command,
							resolvedWorkdir.path,
							fakeResult,
							warnings,
							timeoutMs,
						),
					);
				}
				return this.asResult(`Failed: ${(error as Error).message}`);
			} finally {
				this.busy = false;
			}
		}

		// --- Fallback: run the command normally
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

	private asResult(message: string): LanguageModelToolResult {
		return new LanguageModelToolResult([
			new LanguageModelTextPart(message),
		]);
	}
}

/* ----------------------------- helpers & IO ------------------------------ */

const ensureWorkspaceFolder = (): WorkspaceFolder => {
	const folders = workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		throw new Error("Open a workspace folder before invoking the shell tool.");
	}
	return folders[0];
};

type ResolvedWorkdir = { path: string; usedDefault: boolean };

const resolveWorkdir = async (
	folder: WorkspaceFolder,
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

type CommandRunResult = import("./commandRunner.js").CommandRunResult;

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
	if (!text || text.trim().length === 0) return "";
	const lines = text.trim().split(/\r?\n/);
	const tail = lines.slice(-OUTPUT_TAIL_LINES).join("\n");
	if (tail.length > OUTPUT_TAIL_CHARS) {
		return tail.slice(-OUTPUT_TAIL_CHARS);
	}
	return tail;
};

const withWarnings = (message: string, warnings: readonly string[]): string => {
	if (!warnings.length) return message;
	const formatted = warnings.map((w) => `- ${w}`).join("\n");
	return `${message}\nWarnings:\n${formatted}`;
};

/* ------------------------ apply_patch interception ----------------------- */

type ApplyPatchInvocation = {
	patch: string;
	cdWorkdir?: string;
};

/**
 * Detect "apply_patch <<'PATCH' ... PATCH" within typical Codex patterns:
 *   - bash -lc 'apply_patch <<'\''PATCH'\''
 *   - sh -lc "apply_patch <<'PATCH'"
 *   - (optionally) leading "cd <dir> &&/; " inside the -lc script
 */
const tryExtractApplyPatchInvocation = (
	command: readonly string[],
): ApplyPatchInvocation | null => {
	// Preferred: bash|sh|zsh -lc "<script>"
	for (let i = 0; i < command.length - 2; i++) {
		const prog = command[i];
		const flag = command[i + 1];
		const scriptArg = command[i + 2];
		if (
			/^(?:ba)?sh|zsh$/i.test(path.basename(prog)) &&
			(flag === "-lc" || flag === "-c") &&
			typeof scriptArg === "string" &&
			scriptArg.length > 0
		) {
			const decoded = decodeShellScriptArg(scriptArg);
			const extracted = extractPatchAndCd(decoded);
			if (extracted) return extracted;
		}
	}

	// Fallback: look for heredoc in any argument (rare)
	for (const arg of command) {
		if (typeof arg !== "string") continue;
		const extracted = extractPatchAndCd(arg);
		if (extracted) return extracted;
	}

	return null;
};

const decodeShellScriptArg = (arg: string): string => {
	// If wrapped in single quotes, strip and unescape the classic: '\''  ->  '
	if (arg.startsWith("'") && arg.endsWith("'") && arg.length >= 2) {
		const inner = arg.slice(1, -1);
		return inner.replace(/'\\''/g, "'"); // turn Bash single-quote hack into a literal '
	}
	// If wrapped in double quotes, do a conservative unescape of a few common sequences
	if (arg.startsWith('"') && arg.endsWith('"') && arg.length >= 2) {
		let inner = arg.slice(1, -1);
		inner = inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		inner = inner.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\'/g, "'");
		return inner;
	}
	return arg;
};

/**
 * Extract a leading "cd <dir> && " (or ";") and the apply_patch heredoc body.
 * Supports: apply_patch <<'PATCH'\n ... \nPATCH
 */
const extractPatchAndCd = (script: string): ApplyPatchInvocation | null => {
	// Optional leading cd: cd <dir> (with or without quotes) then && or ; (allow whitespace)
	// Examples: cd /path && apply_patch <<'PATCH' ... or cd "my path"; apply_patch <<'PATCH' ...
	const cdMatch =
		/^\s*cd\s+(?:(['"])(?<qdir>.*?)\1|(?<ndir>[^\s;&|]+))\s*(?:&&|;)\s*/m.exec(
			script,
		);
	const cdWorkdir =
		(cdMatch?.groups?.qdir?.trim() || cdMatch?.groups?.ndir?.trim()) ?? undefined;

	// Find heredoc: apply_patch << 'MARK'  \n  ...body...  \nMARK
	const re = new RegExp(
		String.raw`apply_patch\s*<<\s*(?:['"])?([A-Za-z0-9_]+)(?:['"])?[ \t]*\r?\n([\s\S]*?)\r?\n\1(?=[\r\n;]|$)`,
		"m",
	);
	const m = re.exec(script);
	if (!m) return null;

	const patch = m[2];
	return { patch, cdWorkdir };
};

const resolveWorkdirFromCd = async (
	baseWorkdir: string,
	cdWorkdir?: string,
): Promise<string> => {
	if (!cdWorkdir || cdWorkdir.trim() === "") return baseWorkdir;
	const candidate = path.isAbsolute(cdWorkdir)
		? cdWorkdir
		: path.resolve(baseWorkdir, cdWorkdir);
	const normalized = path.resolve(candidate);
	if (!isSubPath(normalized, baseWorkdir)) {
		throw new Error("Failed: workdir must stay inside the current workspace.");
	}
	await ensureDirectory(normalized);
	return normalized;
};

const resolveInsideWorkspace = (root: string, relative: string): string => {
	const normalized = relative.replace(/\\/g, "/").trim();
	const full = path.resolve(root, normalized);
	if (!isSubPath(full, root)) {
		throw new DiffError(`Path escapes workspace: ${relative}`);
	}
	return full;
};