import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";

type PythonCandidate = {
	command: string;
	args?: string[];
};

type ResolvedPython = {
	executable: string;
	args: string[];
};

export type PythonRuntime = {
	command: ResolvedPython;
	env: NodeJS.ProcessEnv;
};

const PYTHON_CANDIDATES: PythonCandidate[] = [
	{ command: "python3" },
	{ command: "python" },
	{ command: "py", args: ["-3"] },
];

const INSTALL_TIMEOUT_MS = 60_000;

export class PythonEnvironmentManager {
	private pythonCommand?: Promise<ResolvedPython>;
	private installPromise?: Promise<void>;

	constructor(private readonly context: vscode.ExtensionContext) {}

	async ensureRuntime(token: vscode.CancellationToken): Promise<PythonRuntime> {
		const command = await this.resolvePython();
		await this.ensureDependencies(command, token);
		const libDir = this.getLibDir();
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PYTHONPATH: libDir + path.delimiter + (process.env.PYTHONPATH ?? ""),
			PYTHONUTF8: "1",
		};
		return { command, env };
	}

	private async resolvePython(): Promise<ResolvedPython> {
		if (!this.pythonCommand) {
			this.pythonCommand = this.detectPython();
		}
		return this.pythonCommand;
	}

	private async detectPython(): Promise<ResolvedPython> {
		const failures: string[] = [];
		for (const candidate of PYTHON_CANDIDATES) {
			try {
				await this.probePython(candidate);
				return { executable: candidate.command, args: candidate.args ?? [] };
			} catch (error) {
				const label = [candidate.command, ...(candidate.args ?? [])].join(" ");
				failures.push(`${label}: ${(error as Error).message}`);
			}
		}
		throw new Error(
			`Failed: unable to locate python interpreter (${failures.join("; ")})`,
		);
	}

	private probePython(candidate: PythonCandidate): Promise<void> {
		return new Promise((resolve, reject) => {
			const args = [...(candidate.args ?? []), "--version"];
			const child = spawn(candidate.command, args);
			child.on("error", (error) => reject(error));
			child.on("close", (code) => {
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`exit ${code ?? "unknown"}`));
				}
			});
		});
	}

	private async ensureDependencies(
		command: ResolvedPython,
		token: vscode.CancellationToken,
	): Promise<void> {
		const marker = path.join(this.getLibDir(), ".installed");
		if (existsSync(marker)) {
			return;
		}

		if (!this.installPromise) {
			this.installPromise = this.installDependencies(command, marker, token);
		}
		await this.installPromise;
	}

	private async installDependencies(
		command: ResolvedPython,
		markerPath: string,
		token: vscode.CancellationToken,
	): Promise<void> {
		await mkdir(this.getLibDir(), { recursive: true });
		await mkdir(path.dirname(markerPath), { recursive: true });

		const requirementsUri = vscode.Uri.joinPath(
			this.context.extensionUri,
			"resources",
			"python",
			"requirements.txt",
		);
		const installArgs = [
			...command.args,
			"-m",
			"pip",
			"install",
			"--disable-pip-version-check",
			"--no-warn-script-location",
			"--upgrade",
			"--target",
			this.getLibDir(),
			"-r",
			requirementsUri.fsPath,
		];

		await this.runProcess(command.executable, installArgs, token);
		await writeFile(markerPath, new Date().toISOString(), "utf8");
	}

	private runProcess(
		executable: string,
		args: string[],
		token: vscode.CancellationToken,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn(executable, args, { timeout: INSTALL_TIMEOUT_MS });
			let stderr = "";

			const subscription = token.onCancellationRequested(() => {
				child.kill();
			});

			child.stderr?.on("data", (buffer: Buffer) => {
				stderr += buffer.toString("utf8");
			});

			child.on("error", (error) => {
				subscription.dispose();
				reject(error);
			});

			child.on("close", (code) => {
				subscription.dispose();
				if (code === 0) {
					resolve();
				} else if (token.isCancellationRequested) {
					reject(new Error("Failed: dependency installation cancelled."));
				} else {
					reject(
						new Error(
							`Failed: pip install exited with code ${code}. ${stderr.trim()}`,
						),
					);
				}
			});
		});
	}

	private getLibDir(): string {
		return path.join(this.context.globalStorageUri.fsPath, "python-lib");
	}
}
