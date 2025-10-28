import * as fs from "node:fs";
import path from "node:path";
import { CancellationToken, ExtensionContext, FileType, LanguageModelTextPart, LanguageModelTool, LanguageModelToolInvocationOptions, LanguageModelToolInvocationPrepareOptions, LanguageModelToolResult, MarkdownString, OutputChannel, PreparedToolInvocation, Uri, workspace, WorkspaceFolder } from "vscode";
import { DiffError, process_patch } from "./apply_patch.js";
import { type ApplyPatchToolInput, applyPatchToolInputSchema } from "./schema.js";

export const APPLY_PATCH_TOOL_NAME = "apply_patch";

export class ApplyPatchTool
	implements LanguageModelTool<ApplyPatchToolInput>
{
	public readonly name = APPLY_PATCH_TOOL_NAME;

	constructor(_context: ExtensionContext, _outputChannel: OutputChannel) {}

	async prepareInvocation(
		options: LanguageModelToolInvocationPrepareOptions<ApplyPatchToolInput>,
	): Promise<PreparedToolInvocation | undefined> {
		const parsed = applyPatchToolInputSchema.safeParse(options.input);
		if (!parsed.success) {
			throw new Error(
				parsed.error.issues.map((issue) => issue.message).join("; "),
			);
		}

		const folder = ensureWorkspaceFolder();
		const resolved = await resolveWorkdir(folder, parsed.data.workdir);
		const touched = listPatchPaths(parsed.data.patch);
		const preview =
			touched.length > 0
				? touched.length > 5
					? `${touched.slice(0, 4).join(", ")}, … (+${
							touched.length - 4
					  } more)`
					: touched.join(", ")
				: "(paths unavailable)";
		const message = new MarkdownString(
			`Apply patch to \`${preview}\` from \`${resolved.path}\`?`,
		);
		message.isTrusted = false;

		return {
			invocationMessage: `Applying patch (${touched.length} file(s))`,
			confirmationMessages: {
				title: "Apply Codex patch",
				message,
			},
		};
	}

	async invoke(
		options: LanguageModelToolInvocationOptions<ApplyPatchToolInput>,
		_token: CancellationToken,
	): Promise<LanguageModelToolResult> {
		let parsed: ApplyPatchToolInput;
		try {
			parsed = applyPatchToolInputSchema.parse(options.input);
		} catch (error) {
			return this.asResult(`Failed: ${(error as Error).message}`);
		}

		const folder = ensureWorkspaceFolder();
		let resolvedWorkdir: ResolvedWorkdir;
		try {
			resolvedWorkdir = await resolveWorkdir(folder, parsed.workdir);
		} catch (error) {
			return this.asResult(`Failed: ${(error as Error).message}`);
		}

		try {
			const message = applyPatchToWorkspace(parsed.patch, resolvedWorkdir.path);
			// Exactly what Python prints on success: "Done!"
			return this.asResult(message);
		} catch (error) {
			// Mirror Python's main(): only DiffError is converted to output text.
			// Non-DiffError exceptions propagate (tool failure), matching Python.
			if (error instanceof DiffError) {
				return this.asResult(error.message);
			}
			throw error;
		}
	}

	private asResult(message: string): LanguageModelToolResult {
		return new LanguageModelToolResult([
			new LanguageModelTextPart(message),
		]);
	}
}

/* ---------- helpers ---------- */

const ensureWorkspaceFolder = (): WorkspaceFolder => {
	const folders = workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		throw new Error("Open a workspace folder before invoking apply_patch.");
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
		await ensureDirectoryExists(basePath);
		return { path: basePath, usedDefault: true };
	}

	const candidate = path.isAbsolute(requested)
		? requested
		: path.join(basePath, requested);
	const normalized = path.resolve(candidate);
	if (!isSubPath(normalized, path.resolve(basePath))) {
		throw new Error("Failed: workdir must stay inside the current workspace.");
	}

	await ensureDirectoryExists(normalized);
	return { path: normalized, usedDefault: false };
};

const ensureDirectoryExists = async (directory: string): Promise<void> => {
	try {
		const stats = await workspace.fs.stat(Uri.file(directory));
		if ((stats.type & FileType.Directory) === 0) {
			throw new Error(`Failed: ${directory} is not a directory.`);
		}
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code === "ENOENT") {
			throw new Error(`Failed: directory ${directory} does not exist.`);
		}
		throw error;
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

const listPatchPaths = (patch: string): string[] => {
	const files = new Set<string>();
	const directFilePattern = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
	const moveFilePattern = /^\*\*\* Move to: (.+)$/gm;

	let match: RegExpExecArray | null;
	while ((match = directFilePattern.exec(patch))) {
		files.add(sanitizePatchPath(match[2].trim()));
	}
	while ((match = moveFilePattern.exec(patch))) {
		files.add(sanitizePatchPath(match[1].trim()));
	}
	return Array.from(files);
};

const sanitizePatchPath = (input: string): string => input.replace(/\\/g, "/");

const applyPatchToWorkspace = (patchText: string, workspaceRoot: string): string => {
	const root = path.resolve(workspaceRoot);

	const resolveRelative = (relative: string): string => {
		const normalized = sanitizePatchPath(relative.trim());
		const full = path.resolve(root, normalized);
		if (!isSubPath(full, root)) {
			throw new DiffError(`Path escapes workspace: ${relative}`);
		}
		return full;
	};

	// Python open_file: read text; let ENOENT bubble as a generic error (non-DiffError).
	const openFn = (relative: string): string => {
		// For safety, still constrain reads into the workspace.
		const full = resolveRelative(relative);
		return fs.readFileSync(full, "utf8"); // throws if missing
	};

	// Python write_file: print and return (no exception) for absolute paths.
	const writeFn = (relative: string, content: string): void => {
		if (path.isAbsolute(relative)) {
			console.log("We do not support absolute paths.");
			return;
		}
		const full = resolveRelative(relative);
		const dir = path.dirname(full);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(full, content, "utf8");
	};

	// Python remove_file: os.remove; let errors bubble.
	const removeFn = (relative: string): void => {
		const full = resolveRelative(relative);
		fs.unlinkSync(full); // throws if not present
	};

	// Use the same top-level flow as Python; this returns "Done!" on success.
	return process_patch(patchText, openFn, writeFn, removeFn);
};