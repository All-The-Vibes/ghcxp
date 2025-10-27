import { spawn } from "node:child_process";
import {
	clearTimeout as clearTimer,
	setTimeout as setTimer,
} from "node:timers";
import * as vscode from "vscode";

const MAX_OUTPUT_CHARS = 12000;
const OUTPUT_TAIL_LINES = 20;

export type CommandRunResult = {
	success: boolean;
	exitCode?: number;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	timedOut: boolean;
	cancelled: boolean;
	engine: "run_in_terminal" | "spawn";
};

export type CommandRunOptions = {
	command: readonly string[];
	workdir: string;
	explanation: string;
	timeoutMs: number;
	toolInvocationToken: unknown;
	token: vscode.CancellationToken;
};

export class CommandRunner {
	private readonly hasRunInTerminal = vscode.lm.tools.some(
		(tool) => tool.name === "run_in_terminal",
	);

	async run(options: CommandRunOptions): Promise<CommandRunResult> {
		if (this.hasRunInTerminal) {
			return this.runViaTerminalTool(options);
		}

		return this.runViaSpawn(options);
	}

	private async runViaTerminalTool(
		options: CommandRunOptions,
	): Promise<CommandRunResult> {
		const shellCommand = createShellCommand(options.command, options.workdir);
		let timedOut = false;
		const cts = new vscode.CancellationTokenSource();
		const disposables: vscode.Disposable[] = [];
		disposables.push(
			options.token.onCancellationRequested(() => {
				cts.cancel();
			}),
		);
		const timer = setTimer(() => {
			timedOut = true;
			cts.cancel();
		}, options.timeoutMs);

		try {
			const toolResult = await vscode.lm.invokeTool(
				"run_in_terminal",
				{
					toolInvocationToken: options.toolInvocationToken as never,
					input: {
						command: shellCommand,
						explanation: options.explanation,
						isBackground: false,
					},
				},
				cts.token,
			);

			const text = extractText(toolResult);
			const exitCode = extractExitCode(toolResult);
			return {
				success: true,
				exitCode: exitCode ?? undefined,
				stdout: text,
				stderr: "",
				stdoutTruncated: isTruncated(text),
				stderrTruncated: false,
				timedOut: false,
				cancelled: false,
				engine: "run_in_terminal",
			};
		} catch (error) {
			if (timedOut) {
				return {
					success: false,
					exitCode: undefined,
					stdout: "",
					stderr: "Command timed out.",
					stdoutTruncated: false,
					stderrTruncated: false,
					timedOut: true,
					cancelled: false,
					engine: "run_in_terminal",
				};
			}

			if (
				cts.token.isCancellationRequested ||
				options.token.isCancellationRequested
			) {
				return {
					success: false,
					exitCode: undefined,
					stdout: "",
					stderr: "Command cancelled.",
					stdoutTruncated: false,
					stderrTruncated: false,
					timedOut: false,
					cancelled: true,
					engine: "run_in_terminal",
				};
			}

			throw error;
		} finally {
			clearTimer(timer);
			for (const disposable of disposables) {
				disposable.dispose();
			}
			cts.dispose();
		}
	}

	private async runViaSpawn(
		options: CommandRunOptions,
	): Promise<CommandRunResult> {
		return new Promise<CommandRunResult>((resolve, reject) => {
			const [executable, ...args] = options.command;
			const child = spawn(executable, args, {
				cwd: options.workdir,
			});

			let stdout = "";
			let stderr = "";
			let stdoutTruncated = false;
			let stderrTruncated = false;
			let finished = false;
			let timedOut = false;
			const timer = setTimer(() => {
				timedOut = true;
				child.kill();
			}, options.timeoutMs);

			const cancellation = options.token.onCancellationRequested(() => {
				child.kill();
			});

			child.stdout?.on("data", (buffer: Buffer) => {
				const next = stdout + buffer.toString("utf8");
				if (next.length > MAX_OUTPUT_CHARS) {
					stdout = next.slice(-MAX_OUTPUT_CHARS);
					stdoutTruncated = true;
				} else {
					stdout = next;
				}
			});

			child.stderr?.on("data", (buffer: Buffer) => {
				const next = stderr + buffer.toString("utf8");
				if (next.length > MAX_OUTPUT_CHARS) {
					stderr = next.slice(-MAX_OUTPUT_CHARS);
					stderrTruncated = true;
				} else {
					stderr = next;
				}
			});

			child.on("error", (error) => {
				if (finished) {
					return;
				}
				finished = true;
				clearTimer(timer);
				cancellation.dispose();
				reject(
					new Error(
						`Failed: unable to launch process (${(error as Error).message})`,
					),
				);
			});

			child.on("close", (code) => {
				if (finished) {
					return;
				}
				finished = true;
				clearTimer(timer);
				cancellation.dispose();

				if (timedOut) {
					resolve({
						success: false,
						exitCode: undefined,
						stdout,
						stderr,
						stdoutTruncated,
						stderrTruncated,
						timedOut: true,
						cancelled: false,
						engine: "spawn",
					});
					return;
				}

				if (options.token.isCancellationRequested) {
					resolve({
						success: false,
						exitCode: code ?? undefined,
						stdout,
						stderr,
						stdoutTruncated,
						stderrTruncated,
						timedOut: false,
						cancelled: true,
						engine: "spawn",
					});
					return;
				}

				resolve({
					success: code === 0,
					exitCode: code ?? undefined,
					stdout,
					stderr,
					stdoutTruncated,
					stderrTruncated,
					timedOut: false,
					cancelled: false,
					engine: "spawn",
				});
			});
		});
	}
}

const createShellCommand = (
	command: readonly string[],
	workdir: string,
): string => {
	const quote = process.platform === "win32" ? quotePwsh : quotePosix;
	const commandSegment = command.map((part) => quote(part)).join(" ");
	if (process.platform === "win32") {
		return `Set-Location -LiteralPath ${quote(workdir)}; ${commandSegment}`;
	}
	return `cd ${quote(workdir)} && ${commandSegment}`;
};

const quotePosix = (value: string): string => {
	if (value.length === 0) {
		return "''";
	}
	if (/[^A-Za-z0-9_@%+=:,./-]/.test(value)) {
		return `'${value.replace(/'/g, `'\\''`)}'`;
	}
	return value;
};

const quotePwsh = (value: string): string => {
	if (value.length === 0) {
		return "''";
	}
	return `'${value.replace(/'/g, "''")}'`;
};

const extractText = (result: vscode.LanguageModelToolResult): string => {
	return result.content
		.map((part) => {
			if (part instanceof vscode.LanguageModelTextPart) {
				return part.value;
			}
			return "";
		})
		.filter((value) => value.length > 0)
		.join("\n");
};

const extractExitCode = (
	result: vscode.LanguageModelToolResult,
): number | undefined => {
	const metadata = (result as { toolMetadata?: { exitCode?: number } })
		.toolMetadata;
	if (metadata && typeof metadata.exitCode === "number") {
		return metadata.exitCode;
	}
	return undefined;
};

const isTruncated = (text: string): boolean => {
	const lines = text.trim().split(/\r?\n/);
	return lines.length > OUTPUT_TAIL_LINES;
};
