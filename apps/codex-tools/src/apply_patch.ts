/* apply_patch.ts
 * TypeScript + Zod port of ghcxp/apps/shell-tool/resources/apply_patch.py
 * Aimed to be behaviorally identical, including assertion vs DiffError semantics.
 */
/* eslint-disable no-console */

import * as fs from "fs";
import { z } from "zod";

/* ----------------------------- Errors & Utils ---------------------------- */

export class DiffError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DiffError";
	}
}

function hasOwn(obj: object, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

// Python-like assert: raises AssertionError (not DiffError), with optional message.
function pyAssert(condition: unknown, message?: string): asserts condition {
	if (!condition) {
		const error = new Error(message ?? "");
		(error as { name: string }).name = "AssertionError";
		throw error;
	}
}

function startsWithAny(text: string, prefixes?: string[] | null): boolean {
	if (!prefixes || prefixes.length === 0) return false;
	return prefixes.some((prefix) => text.startsWith(prefix));
}

function rstripSpaces(text: string): string {
	return text.replace(/\s+$/u, "");
}

function sliceLikePython<T>(arr: T[], start: number, end: number): T[] {
	const len = arr.length;
	const normStart = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
	const normEnd = end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
	if (normEnd <= normStart) return [];
	return arr.slice(normStart, normEnd);
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/* --------------------------- Zod Schemas & Types ------------------------- */

export enum ActionTypeEnum {
	ADD = "add",
	DELETE = "delete",
	UPDATE = "update",
}

export const ActionTypeSchema = z.nativeEnum(ActionTypeEnum);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const FileChangeSchema = z.object({
	type: ActionTypeSchema,
	old_content: z.string().nullable().optional().default(null),
	new_content: z.string().nullable().optional().default(null),
	move_path: z.string().nullable().optional().default(null),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

export const CommitSchema = z.object({
	changes: z.record(z.string(), FileChangeSchema),
});
export type Commit = z.infer<typeof CommitSchema>;

export const ChunkSchema = z.object({
	orig_index: z.number().int().default(-1),
	del_lines: z.array(z.string()).default([]),
	ins_lines: z.array(z.string()).default([]),
});
export type Chunk = z.infer<typeof ChunkSchema>;

export const PatchActionSchema = z.object({
	type: ActionTypeSchema,
	new_file: z.string().nullable().optional().default(null),
	chunks: z.array(ChunkSchema).default([]),
	move_path: z.string().nullable().optional().default(null),
});
export type PatchAction = z.infer<typeof PatchActionSchema>;

export const PatchSchema = z.object({
	actions: z.record(z.string(), PatchActionSchema),
});
export type Patch = z.infer<typeof PatchSchema>;

/* --------------------------- assemble_changes ---------------------------- */

export function assemble_changes(
	orig: Record<string, string | null | undefined>,
	dest: Record<string, string | null | undefined>,
): Commit {
	const commit = CommitSchema.parse({ changes: {} });
	// Python dict parity: remove prototype from the mapping container
	Object.setPrototypeOf(commit.changes as object, null);

	const allPaths = Array.from(
		new Set([...Object.keys(orig), ...Object.keys(dest)]),
	).sort();

	const getOrNull = (
		obj: Record<string, string | null | undefined>,
		key: string,
	) =>
		Object.prototype.hasOwnProperty.call(obj, key)
			? obj[key] ?? null
			: null;

	for (const path of allPaths) {
		const old_content = getOrNull(orig, path);
		const new_content = getOrNull(dest, path);
		if (old_content !== new_content) {
			if (old_content !== null && new_content !== null) {
				commit.changes[path] = FileChangeSchema.parse({
					type: ActionTypeEnum.UPDATE,
					old_content,
					new_content,
				});
			} else if (new_content) {
				commit.changes[path] = FileChangeSchema.parse({
					type: ActionTypeEnum.ADD,
					new_content,
				});
			} else if (old_content) {
				commit.changes[path] = FileChangeSchema.parse({
					type: ActionTypeEnum.DELETE,
					old_content,
				});
			} else {
				pyAssert(false);
			}
		}
	}
	return commit;
}

/* -------------------------------- Parser --------------------------------- */

class Parser {
	current_files: Record<string, string>;
	lines: string[];
	index: number;
	patch: Patch;
	fuzz: number;

	constructor(params: {
		current_files?: Record<string, string>;
		lines?: string[];
		index?: number;
		patch?: Patch;
	}) {
		// Null-proto dicts to mirror Python dict behavior
		this.current_files =
			params.current_files ?? (Object.create(null) as Record<string, string>);
		this.lines = params.lines ?? [];
		this.index = params.index ?? 0;
		this.patch = params.patch ?? PatchSchema.parse({ actions: {} });
		Object.setPrototypeOf(this.patch.actions as object, null);
		this.fuzz = 0;
	}

	is_done(prefixes?: string[] | null): boolean {
		if (this.index >= this.lines.length) return true;
		if (prefixes && startsWithAny(this.lines[this.index] ?? "", prefixes)) {
			return true;
		}
		return false;
	}

	startswith(prefix: string | string[] | null | undefined): boolean {
		pyAssert(
			this.index < this.lines.length,
			`Index: ${this.index} >= ${this.lines.length}`,
		);
		const line = this.lines[this.index];
		if (Array.isArray(prefix)) return startsWithAny(line, prefix);
		if (typeof prefix === "string") return line.startsWith(prefix);
		return false;
	}

	read_str(prefix = "", returnEverything = false): string {
		pyAssert(
			this.index < this.lines.length,
			`Index: ${this.index} >= ${this.lines.length}`,
		);
		const line = this.lines[this.index];
		if (line.startsWith(prefix)) {
			const text = returnEverything ? line : line.slice(prefix.length);
			this.index += 1;
			return text;
		}
		return "";
	}

	parse(): void {
		while (!this.is_done(["*** End Patch"])) {
			let filePath = this.read_str("*** Update File: ");
			if (filePath) {
				if (hasOwn(this.patch.actions, filePath)) {
					throw new DiffError(`Update File Error: Duplicate Path: ${filePath}`);
				}
				const move_to = this.read_str("*** Move to: ");
				if (!hasOwn(this.current_files, filePath)) {
					throw new DiffError(`Update File Error: Missing File: ${filePath}`);
				}
				const text = this.current_files[filePath];
				const action = this.parse_update_file(text);
				action.move_path = move_to;
				this.patch.actions[filePath] = action;
				continue;
			}

			filePath = this.read_str("*** Delete File: ");
			if (filePath) {
				if (hasOwn(this.patch.actions, filePath)) {
					throw new DiffError(`Delete File Error: Duplicate Path: ${filePath}`);
				}
				if (!hasOwn(this.current_files, filePath)) {
					throw new DiffError(`Delete File Error: Missing File: ${filePath}`);
				}
				this.patch.actions[filePath] = PatchActionSchema.parse({
					type: ActionTypeEnum.DELETE,
				});
				continue;
			}

			filePath = this.read_str("*** Add File: ");
			if (filePath) {
				if (hasOwn(this.patch.actions, filePath)) {
					throw new DiffError(`Add File Error: Duplicate Path: ${filePath}`);
				}
				this.patch.actions[filePath] = this.parse_add_file();
				continue;
			}

			throw new DiffError(`Unknown Line: ${this.lines[this.index]}`);
		}
		if (!this.startswith("*** End Patch")) {
			throw new DiffError("Missing End Patch");
		}
		this.index += 1;
	}

	parse_update_file(text: string): PatchAction {
		const action = PatchActionSchema.parse({
			type: ActionTypeEnum.UPDATE,
		});
		const lines = text.split("\n");
		let idx = 0;

		while (
			!this.is_done([
				"*** End Patch",
				"*** Update File:",
				"*** Delete File:",
				"*** Add File:",
				"*** End of File",
			])
		) {
			const def_str = this.read_str("@@ ");
			let section_str = "";
			if (!def_str) {
				if (this.lines[this.index] === "@@") {
					section_str = this.lines[this.index];
					this.index += 1;
				}
			}
			if (!(def_str || section_str || idx === 0)) {
				throw new DiffError(`Invalid Line:\n${this.lines[this.index]}`);
			}

			if (def_str.trim()) {
				let found = false;
				if (!lines.slice(0, idx).some((line) => line === def_str)) {
					for (let i = idx; i < lines.length; i++) {
						if (lines[i] === def_str) {
							idx = i + 1;
							found = true;
							break;
						}
					}
				}
				if (
					!found &&
					!lines.slice(0, idx).some((line) => line.trim() === def_str.trim())
				) {
					for (let i = idx; i < lines.length; i++) {
						if (lines[i].trim() === def_str.trim()) {
							idx = i + 1;
							this.fuzz += 1;
							found = true;
							break;
						}
					}
				}
			}

			const [next_chunk_context, chunks, end_patch_index, eof] =
				peek_next_section(this.lines, this.index);
			const next_chunk_text = next_chunk_context.join("\n");
			const [newIndex, fuzz] = find_context(
				lines,
				next_chunk_context,
				idx,
				eof,
			);
			if (newIndex === -1) {
				if (eof) {
					throw new DiffError(`Invalid EOF Context ${idx}:\n${next_chunk_text}`);
				}
				throw new DiffError(`Invalid Context ${idx}:\n${next_chunk_text}`);
			}
			this.fuzz += fuzz;

			for (const chunk of chunks) {
				(chunk as any).orig_index += newIndex; // mutation mirrors Python
				action.chunks.push(chunk);
			}
			idx = newIndex + next_chunk_context.length;
			this.index = end_patch_index;
			continue;
		}

		return action;
	}

	parse_add_file(): PatchAction {
		const lines: string[] = [];
		while (
			!this.is_done([
				"*** End Patch",
				"*** Update File:",
				"*** Delete File:",
				"*** Add File:",
			])
		) {
			let line = this.read_str();
			if (!line.startsWith("+")) {
				throw new DiffError(`Invalid Add File Line: ${line}`);
			}
			line = line.slice(1);
			lines.push(line);
		}
		return PatchActionSchema.parse({
			type: ActionTypeEnum.ADD,
			new_file: lines.join("\n"),
		});
	}
}

/* ------------------------ Context & Section Helpers ---------------------- */

function find_context_core(
	lines: string[],
	context: string[],
	start: number,
): [number, number] {
	if (context.length === 0) {
		console.log("context is empty");
		return [start, 0];
	}

	for (let i = start; i < lines.length; i++) {
		const window = sliceLikePython(lines, i, i + context.length);
		if (arraysEqual(window, context)) return [i, 0];
	}

	for (let i = start; i < lines.length; i++) {
		const window = sliceLikePython(lines, i, i + context.length).map(
			(line) => rstripSpaces(line),
		);
		const ctx = context.map((line) => rstripSpaces(line));
		if (arraysEqual(window, ctx)) return [i, 1];
	}

	for (let i = start; i < lines.length; i++) {
		const window = sliceLikePython(lines, i, i + context.length).map((line) =>
			line.trim(),
		);
		const ctx = context.map((line) => line.trim());
		if (arraysEqual(window, ctx)) return [i, 100];
	}

	return [-1, 0];
}

function find_context(
	lines: string[],
	context: string[],
	start: number,
	eof: boolean,
): [number, number] {
	if (eof) {
		const preferStart = lines.length - context.length;
		let [newIndex, fuzz] = find_context_core(lines, context, preferStart);
		if (newIndex !== -1) return [newIndex, fuzz];
		[newIndex, fuzz] = find_context_core(lines, context, start);
		return [newIndex, fuzz + 10000];
	}
	return find_context_core(lines, context, start);
}

function peek_next_section(
	lines: string[],
	index: number,
): [string[], Chunk[], number, boolean] {
	const old: string[] = [];
	let del_lines: string[] = [];
	let ins_lines: string[] = [];
	const chunks: Chunk[] = [];
	let mode: "keep" | "add" | "delete" = "keep";
	const orig_index = index;

	while (index < lines.length) {
		let line = lines[index];
		if (
			line.startsWith("@@") ||
			line.startsWith("*** End Patch") ||
			line.startsWith("*** Update File:") ||
			line.startsWith("*** Delete File:") ||
			line.startsWith("*** Add File:") ||
			line.startsWith("*** End of File")
		) {
			break;
		}
		if (line === "***") {
			break;
		}
		if (line.startsWith("***")) {
			throw new DiffError(`Invalid Line: ${line}`);
		}
		index += 1;
		const last_mode: "keep" | "add" | "delete" = mode;

		if (line === "") line = " ";
		const ch0 = line[0];

		if (ch0 === "+") {
			mode = "add";
		} else if (ch0 === "-") {
			mode = "delete";
		} else if (ch0 === " ") {
			mode = "keep";
		} else {
			throw new DiffError(`Invalid Line: ${line}`);
		}

		line = line.slice(1);

		if (mode === "keep" && last_mode !== mode) {
			if (ins_lines.length || del_lines.length) {
				chunks.push(
					ChunkSchema.parse({
						orig_index: old.length - del_lines.length,
						del_lines,
						ins_lines,
					}),
				);
			}
			del_lines = [];
			ins_lines = [];
		}

		if (mode === "delete") {
			del_lines.push(line);
			old.push(line);
		} else if (mode === "add") {
			ins_lines.push(line);
		} else {
			old.push(line);
		}
	}

	if (ins_lines.length || del_lines.length) {
		chunks.push(
			ChunkSchema.parse({
				orig_index: old.length - del_lines.length,
				del_lines,
				ins_lines,
			}),
		);
		del_lines = [];
		ins_lines = [];
	}

	if (index < lines.length && lines[index] === "*** End of File") {
		index += 1;
		return [old, chunks, index, true];
	}

	if (index === orig_index) {
		// Match Python's exact message (no fallback token)
		throw new DiffError(`Nothing in this section - index=${index} ${lines[index]}`);
	}

	return [old, chunks, index, false];
}

/* ------------------------------ Top-level API ---------------------------- */

export function text_to_patch(
	text: string,
	orig: Record<string, string>,
): [Patch, number] {
	const lines = text.trim().split("\n");
	if (
		lines.length < 2 ||
		!lines[0].startsWith("*** Begin Patch") ||
		lines[lines.length - 1] !== "*** End Patch"
	) {
		throw new DiffError("Invalid patch text");
	}

	const parser = new Parser({
		current_files: orig,
		lines,
		index: 1,
	});
	parser.parse();
	return [parser.patch, parser.fuzz];
}

export function identify_files_needed(text: string): string[] {
	const lines = text.trim().split("\n");
	const result = new Set<string>();
	for (const line of lines) {
		if (line.startsWith("*** Update File: ")) {
			result.add(line.slice("*** Update File: ".length));
		}
		if (line.startsWith("*** Delete File: ")) {
			result.add(line.slice("*** Delete File: ".length));
		}
	}
	return Array.from(result);
}

function getUpdatedFile(text: string, action: PatchAction, filePath: string): string {
	pyAssert(action.type === ActionTypeEnum.UPDATE);
	const orig_lines = text.split("\n");
	const dest_lines: string[] = [];
	let orig_index = 0;
	let dest_index = 0;

	for (const chunk of action.chunks) {
		if (chunk.orig_index > orig_lines.length) {
			const message = `_get_updated_file: ${filePath}: chunk.orig_index ${chunk.orig_index} > len(lines) ${orig_lines.length}`;
			console.log(message);
			throw new DiffError(message);
		}
		if (orig_index > chunk.orig_index) {
			throw new DiffError(
				`_get_updated_file: ${filePath}: orig_index ${orig_index} > chunk.orig_index ${chunk.orig_index}`,
			);
		}
		pyAssert(orig_index <= chunk.orig_index);

		dest_lines.push(...orig_lines.slice(orig_index, chunk.orig_index));
		const delta = chunk.orig_index - orig_index;
		orig_index += delta;
		dest_index += delta;

		if (chunk.ins_lines && chunk.ins_lines.length) {
			for (const ins of chunk.ins_lines) {
				dest_lines.push(ins);
			}
			dest_index += chunk.ins_lines.length;
		}

		orig_index += chunk.del_lines.length;
	}

	dest_lines.push(...orig_lines.slice(orig_index));
	const delta = orig_lines.length - orig_index;
	orig_index += delta;
	dest_index += delta;

	pyAssert(orig_index === orig_lines.length);
	pyAssert(dest_index === dest_lines.length);

	return dest_lines.join("\n");
}

export function patch_to_commit(
	patch: Patch,
	orig: Record<string, string>,
): Commit {
	const commit = CommitSchema.parse({ changes: {} });
	// Mirror Python dict for the mapping container
	Object.setPrototypeOf(commit.changes as object, null);

	for (const [filePath, action] of Object.entries(patch.actions) as [string, PatchAction][]) {
		if (action.type === ActionTypeEnum.DELETE) {
			commit.changes[filePath] = FileChangeSchema.parse({
				type: ActionTypeEnum.DELETE,
				old_content: orig[filePath],
			});
		} else if (action.type === ActionTypeEnum.ADD) {
			commit.changes[filePath] = FileChangeSchema.parse({
				type: ActionTypeEnum.ADD,
				new_content: action.new_file,
			});
		} else if (action.type === ActionTypeEnum.UPDATE) {
			const new_content = getUpdatedFile(orig[filePath], action, filePath);
			commit.changes[filePath] = FileChangeSchema.parse({
				type: ActionTypeEnum.UPDATE,
				old_content: orig[filePath],
				new_content,
				move_path: action.move_path ?? null,
			});
		}
	}
	return commit;
}

/* ---------------------------- File Operations ---------------------------- */

export type OpenFn = (path: string) => string;
export type WriteFn = (path: string, content: string) => void;
export type RemoveFn = (path: string) => void;

export function load_files(paths: string[], open_fn: OpenFn): Record<string, string> {
	// Null-proto to mimic Python's dict behavior
	const orig: Record<string, string> = Object.create(null);
	for (const filePath of paths) {
		orig[filePath] = open_fn(filePath);
	}
	return orig;
}

export function apply_commit(
	commit: Commit,
	write_fn: WriteFn,
	remove_fn: RemoveFn,
): void {
	for (const [filePath, change] of Object.entries(commit.changes) as [string, FileChange][]) {
		if (change.type === ActionTypeEnum.DELETE) {
			remove_fn(filePath);
		} else if (change.type === ActionTypeEnum.ADD) {
			write_fn(filePath, change.new_content as string);
		} else if (change.type === ActionTypeEnum.UPDATE) {
			if (change.move_path) {
				write_fn(change.move_path, change.new_content as string);
				remove_fn(filePath);
			} else {
				write_fn(filePath, change.new_content as string);
			}
		}
	}
}

export function process_patch(
	text: string,
	open_fn: OpenFn,
	write_fn: WriteFn,
	remove_fn: RemoveFn,
): string {
	pyAssert(text.startsWith("*** Begin Patch"));
	const paths = identify_files_needed(text);
	const orig = load_files(paths, open_fn);
	const [patch] = text_to_patch(text, orig);
	const commit = patch_to_commit(patch, orig);
	apply_commit(commit, write_fn, remove_fn);
	return "Done!";
}

/* ---------------------------- Default IO funcs --------------------------- */

export function open_file(path: string): string {
	return fs.readFileSync(path, { encoding: "utf8" });
}

export function write_file(path: string, content: string): void {
	if (path.startsWith("/")) {
		console.log("We do not support absolute paths.");
		return;
	}
	if (path.includes("/")) {
		const parent = path.split("/").slice(0, -1).join("/");
		if (parent) fs.mkdirSync(parent, { recursive: true });
	}
	fs.writeFileSync(path, content, { encoding: "utf8" });
}

export function remove_file(path: string): void {
	fs.unlinkSync(path);
}

/* --------------------------------- CLI ----------------------------------- */

export function main(): void {
	const patch_text = fs.readFileSync(0, { encoding: "utf8" });
	if (!patch_text) {
		console.log("Please pass patch text through stdin");
		return;
	}
	try {
		const result = process_patch(patch_text, open_file, write_file, remove_file);
		console.log(result);
	} catch (error) {
		if (error instanceof DiffError) {
			console.log(String(error.message));
			return;
		}
		throw error;
	}
}

if (require.main === module) {
	main();
}