import { CancellationToken, ExtensionContext, LanguageModelTextPart, LanguageModelTool, LanguageModelToolInvocationOptions, LanguageModelToolInvocationPrepareOptions, LanguageModelToolResult, lm, MarkdownString, OutputChannel, PreparedToolInvocation, Uri, workspace, WorkspaceFolder } from "vscode";
import {
	type UpdatePlanToolInput,
	updatePlanToolInputSchema,
} from "./schema.js";

export const UPDATE_PLAN_TOOL_NAME = "update_plan";

type Totals = { pending: number; in_progress: number; completed: number };

export class PlanTool
	implements LanguageModelTool<UpdatePlanToolInput>
{
	public readonly name = UPDATE_PLAN_TOOL_NAME;

	constructor(private readonly context: ExtensionContext, _outputChannel: OutputChannel) {}

	async prepareInvocation(
		options: LanguageModelToolInvocationPrepareOptions<UpdatePlanToolInput>,
	): Promise<PreparedToolInvocation | undefined> {
		const parsed = updatePlanToolInputSchema.safeParse(options.input);
		if (!parsed.success) {
			throw new Error(
				parsed.error.issues.map((issue) => issue.message).join("; "),
			);
		}

		const folder = ensureWorkspaceFolder();
		const totals = countStatuses(parsed.data.plan);
		const message = new MarkdownString(
			`Update plan in \`PLAN.md\` (pending: ${totals.pending}, in-progress: ${totals.in_progress}, done: ${totals.completed}) at \`${folder.uri.fsPath}\` and sync with the native TODO tool if available?`,
		);
		message.isTrusted = false;

		return {
			invocationMessage: `Updating plan (${parsed.data.plan.length} step(s))`,
			confirmationMessages: {
				title: "Update Plan",
				message,
			},
		};
	}

	async invoke(
		options: LanguageModelToolInvocationOptions<UpdatePlanToolInput>,
		token: CancellationToken,
	): Promise<LanguageModelToolResult> {
		let parsed: UpdatePlanToolInput;
		try {
			parsed = updatePlanToolInputSchema.parse(options.input);
		} catch (error) {
			return this.asResult(`Failed: ${(error as Error).message}`);
		}

		const folder = ensureWorkspaceFolder();

		try {
			const planUri = Uri.joinPath(folder.uri, "PLAN.md");
			const content = renderPlanMarkdown(parsed);
			await workspace.fs.writeFile(
				planUri,
				new TextEncoder().encode(content),
			);

			await this.trySyncTodoTool(parsed, options, token);

			const totals = countStatuses(parsed.plan);
			const statusSummary =
				totals.completed > 0 || totals.in_progress > 0 || totals.pending > 0
					? `pending: ${totals.pending}, in-progress: ${totals.in_progress}, done: ${totals.completed}`
					: "empty plan";

			return this.asResult(
				`Success. Updated PLAN.md and attempted TODO sync (${statusSummary}).`,
			);
		} catch (error) {
			const msg =
				(error as Error).message?.startsWith("Failed:")
					? (error as Error).message
					: `Failed: ${(error as Error).message}`;
			return this.asResult(msg);
		}
	}

	private async trySyncTodoTool(
		input: UpdatePlanToolInput,
		options: LanguageModelToolInvocationOptions<UpdatePlanToolInput>,
		token: CancellationToken,
	): Promise<void> {
		const name = findTodoToolName();
		if (!name) {
			return;
		}

		const invocationToken = (options as { toolInvocationToken?: unknown })
			.toolInvocationToken;

		const shapes: unknown[] = [
			{
				items: input.plan.map((step) => ({
					title: step.step,
					done: step.status === "completed",
					description:
						input.explanation && input.explanation.trim().length > 0
							? input.explanation
							: undefined,
				})),
			},
			{
				text: renderTodoMarkdown(input),
			},
			{
				todos: input.plan.map((step) => ({
					text: step.step,
					done: step.status === "completed",
				})),
			},
		];

		for (const shape of shapes) {
			try {
				await lm.invokeTool(
					name,
					{
						toolInvocationToken: invocationToken as never,
						input: shape as never,
					},
					token,
				);
				return;
			} catch {
				// Ignore mismatches and try the next projection.
			}
		}
	}

	private asResult(message: string): LanguageModelToolResult {
		return new LanguageModelToolResult([
			new LanguageModelTextPart(message),
		]);
	}
}

const ensureWorkspaceFolder = (): WorkspaceFolder => {
	const folders = workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		throw new Error("Open a workspace folder before using update_plan.");
	}
	return folders[0];
};

const countStatuses = (steps: UpdatePlanToolInput["plan"]): Totals => {
	let pending = 0;
	let in_progress = 0;
	let completed = 0;
	for (const step of steps) {
		if (step.status === "pending") {
			pending++;
		} else if (step.status === "in_progress") {
			in_progress++;
		} else if (step.status === "completed") {
			completed++;
		}
	}
	return { pending, in_progress, completed };
};

const renderPlanMarkdown = (input: UpdatePlanToolInput): string => {
	const lines: string[] = [];
	lines.push("# Plan");
	lines.push("");
	lines.push(`_Last updated: ${new Date().toISOString()}_`);
	lines.push("");
	if (input.explanation && input.explanation.trim().length > 0) {
		lines.push(input.explanation.trim());
		lines.push("");
	}
	for (const step of input.plan) {
		const check = step.status === "completed" ? "x" : " ";
		const suffix = step.status === "in_progress" ? " _(in progress)_" : "";
		lines.push(`- [${check}] ${step.step}${suffix}`);
	}
	lines.push("");
	return lines.join("\n");
};

const renderTodoMarkdown = (input: UpdatePlanToolInput): string => {
	const lines: string[] = [];
	if (input.explanation && input.explanation.trim().length > 0) {
		lines.push(input.explanation.trim());
		lines.push("");
	}
	for (const step of input.plan) {
		const check = step.status === "completed" ? "x" : " ";
		const suffix = step.status === "in_progress" ? " (in progress)" : "";
		lines.push(`- [${check}] ${step.step}${suffix}`);
	}
	return lines.join("\n");
};

const findTodoToolName = (): string | undefined => {
	const preferred = new Set(["todo_list", "todo", "github.copilot.todo"]);
	for (const tool of lm.tools) {
		if (preferred.has(tool.name)) {
			return tool.name;
		}
	}
	const fuzzy = lm.tools.find((tool) => /todo/i.test(tool.name));
	return fuzzy?.name;
};
