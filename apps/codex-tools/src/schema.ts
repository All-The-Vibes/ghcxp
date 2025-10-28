import { z } from "zod";

const COMMAND_LIMIT = 64;
const JUSTIFICATION_LIMIT = 140;

/* ---------- shell tool ---------- */

export const shellToolInputSchema = z
	.object({
		command: z
			.array(z.string().min(1, "command entries must be non-empty"))
			.min(1, "command must include at least one entry")
			.max(COMMAND_LIMIT, `command cannot exceed ${COMMAND_LIMIT} entries`),
		workdir: z.string().min(1, "workdir cannot be empty").optional(),
		timeout_ms: z
			.number()
			.int("timeout_ms must be an integer")
			.min(250, "timeout_ms must be at least 250ms")
			.max(120000, "timeout_ms cannot exceed 120000ms")
			.optional(),
		// Kept for compatibility with Codex-like prompts; GHCP handles approvals natively.
		with_escalated_permissions: z.boolean().optional(),
		justification: z
			.string()
			.max(
				JUSTIFICATION_LIMIT,
				`justification must be <= ${JUSTIFICATION_LIMIT} characters`,
			)
			.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.with_escalated_permissions &&
			(!value.justification || value.justification.trim().length === 0)
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"justification is required when with_escalated_permissions is true",
				path: ["justification"],
			});
		}
	});

export type ShellToolInput = z.infer<typeof shellToolInputSchema>;

/* ---------- apply_patch tool ---------- */

export const applyPatchToolInputSchema = z
	.object({
		patch: z.string().min(1, "patch cannot be empty"),
		workdir: z.string().min(1, "workdir cannot be empty").optional(),
		timeout_ms: z
			.number()
			.int("timeout_ms must be an integer")
			.min(250, "timeout_ms must be at least 250ms")
			.max(120000, "timeout_ms cannot exceed 120000ms")
			.optional(),
	})
	.strict();

export type ApplyPatchToolInput = z.infer<typeof applyPatchToolInputSchema>;

/* ---------- update_plan tool ---------- */

const planStatusEnum = z.enum(["pending", "in_progress", "completed"]);

const planStepSchema = z.object({
	step: z.string().min(1, "step cannot be empty"),
	status: planStatusEnum,
});

export const updatePlanToolInputSchema = z
	.object({
		plan: z
			.array(planStepSchema)
			.min(2, "plan must include at least two steps (skip trivial tasks)")
			.max(8, "plan cannot exceed 8 steps"),
		explanation: z.string().max(4000, "explanation is too long").optional(),
	})
	.strict();

export type UpdatePlanToolInput = z.infer<typeof updatePlanToolInputSchema>;
