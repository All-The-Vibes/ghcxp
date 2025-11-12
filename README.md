# Codex‑Mode for GitHub Copilot Chat (GHCP)

Make GitHub Copilot Chat behave as closely as possible to OpenAI Codex (`gpt‑5‑codex`) inside VS Code—minimal prompts, **patch‑based edits**, and a **tiny tool surface**.

> **Reference:** The Codex prompting philosophy, system‑style rules, and edit guidance are summarized here: [GPT‑5 Codex Prompting Guide](https://cookbook.openai.com/examples/gpt-5-codex_prompting_guide).  
> **Tooling principle:** Provide Codex with only the tools it expects: a dedicated **`shell`** terminal tool and a separate **`apply_patch`** tool.

---

## What this repository provides

- A ready‑to‑use profile under **`.vscode/settings.json`** that dials Copilot Chat toward Codex‑style behavior:

  - Prefer the **`gpt‑5‑codex`** model (BYOK supported).
  - Route **custom instructions into the _system_ message**.
  - Disable ambient RAG/context sources.
  - Minimize visible reasoning/summary verbosity.
  - Keep terminal **auto‑approve off** so GHCP/VS Code manage approvals as usual.

- `apps/codex-tools`: an extension that contributes three language-model tools—**`shell`** for terminal commands, **`apply_patch`** for Codex-formatted edits, and **`update_plan`** for keeping a concise task plan. The shell tool mirrors Codex’s expectations while delegating to VS Code’s terminal plumbing; `apply_patch` atomically applies diffs; `update_plan` writes `PLAN.md` and syncs with the native TODO tool when available.

- An optional lightweight **`update_plan`** tool for short, task‑level plans when the model asks for one.

> **Scope:** This project **does not implement Codex sandboxing or its approval policies**. Approvals/confirmations are handled entirely by **GitHub Copilot Chat and VS Code**. No additional approval gates are introduced here.

---

## Requirements

- VS Code with GitHub Copilot Chat (Agent mode available).
- Access to a `gpt‑5‑codex` deployment (OpenAI or Azure OpenAI Responses API).
- Permission to install/run a local VS Code extension (the LM tools).

---

## Setup (high-level)

1. Open this repository in VS Code.
2. Build/install the included **Codex Tools** extension (`apps/codex-tools`). See **INSTALLATION.md** for the pnpm-friendly packaging steps.
3. In Settings UI, enable **“Copilot › Chat: Custom Instructions In System Message.”**
4. Select your **`gpt-5-codex`** deployment in the model picker (BYOK supported via the sample settings).
5. In Copilot Chat → **Agent** → **Tools**, enable the contributed **`shell`**, **`apply_patch`**, and **`update_plan`** tools (disable other tools you don’t want the model to call).
6. Keep the included **short, Codex-style custom instructions** system-scoped.

---

## Create the Codex custom chat mode

Codex Mode is a custom chat mode for GitHub Copilot Chat that codifies this repository’s prompting approach. Selecting this mode swaps in the full Codex system prompt from `codex.chatmode.md`, effectively overriding Copilot Chat’s default system instructions with the Codex-specific rules described here. This is the reliable way to run `gpt-5-codex` with the Codex prompt today because Copilot’s built-in `github.copilot.chat.gpt5AlternatePrompt` setting only applies to the generic “gpt-5” family and ignores the `gpt-5-codex` model. Codex Mode sidesteps that check by binding the preferred model and system prompt together, delivering the precise override we want. It ships with minimal instructions that reinforce patch-based edits and the tight tool surface described above.

### Installation instructions

- Open the Copilot Chat side bar, use the **Agent** dropdown, and select **Configure Modes**.
- Choose **Create new custom chat mode file**.
- Pick the **User Data Folder** option so the mode is available in all workspaces.
- Name the mode **Codex**.
- Paste in the contents of `codex.chatmode.md` from this repository’s root.

Once saved, **Codex** will appear in the Agent dropdown alongside the built-in modes.

### Why not rely on `github.copilot.chat.gpt5AlternatePrompt`

- Copilot Chat decides when to use the alternate prompt by checking the model _family_ ("gpt-5", "gpt-4.1", etc.), not the exact model name.
- `gpt-5-codex` is not tagged as the "gpt-5" family in the extension, so the `gpt5AlternatePrompt` setting is skipped.
- Copilot currently exposes no `...gpt5CodexAlternatePrompt` override, and automated tests only cover the default, 4.1, and gpt-5 branches.
- A custom chat mode is therefore the supported path to bind both the preferred `gpt-5-codex` model and the Codex system prompt.

### Recommended VS Code settings

Codex Mode leans heavily on tool calls, so enabling auto-approval keeps the workflow smooth. Consider bumping the request ceiling as well so long-running tasks stay hands-off.

```json
"chat.tools.autoApprove": true,
"chat.agent.maxRequests": 100
```

### UI guidance

Pair Codex Mode with your preferred UI instructions. A lightweight option is to duplicate the concise Codex guidance from this repo into `.github/instructions`, preserving the minimal, patch-first workflow.

---

## Settings highlights (what the included profile does)

- **Model & routing**

  - Registers/uses a `gpt‑5‑codex` Responses‑API deployment.
  - Tool‑calling **on**; **vision off** for Codex sessions.

- **Prompt discipline**

  - **Custom instructions → system message** (Codex‑like).
  - Reasoning effort **minimal/low**; reasoning summary **off/brief**.
  - Concise thinking style; chat checkpoints disabled.

- **Context minimization**

  - **Code search/RAG off**; no automatic current‑editor or notebook context.
  - Reviews and “next edit” nudges disabled; no related‑files injection.

- **Execution UX (approvals)**
  - **No custom approval layer.** Approvals/confirmations remain the **native GHCP/VS Code** experience (e.g., terminal prompts, tool confirmations).
  - Terminal output shown in VS Code’s integrated terminal; cancellations/timeouts use VS Code’s standard behavior.

> These choices are already captured in **`.vscode/settings.json`** and can be tweaked to suit your environment.

---

## How it works

### Codex‑style operating model

- **Minimal system instructions**: no preambles; small plans only when tasks are non‑trivial; **patch‑first edits**.
- **Tiny tool surface**: the extension exposes only the **`shell`** terminal tool for build/test/search commands and the **`apply_patch`** tool for edits; optional `update_plan`.

### The `shell` language‑model tool (interface & behavior)

- **Extension:** `apps/codex-tools`
- **Name:** `shell`
- **Purpose:** Execute commands in the user’s environment with clear `workdir` semantics while leveraging VS Code’s terminal/run-command stack.
- **Parameters the model can set:**
  - `command` (array of strings; **required**): argv vector the model wants to run.
  - `workdir` (string; optional but recommended): workspace directory to run from.
  - `timeout_ms` (number; optional): hard timeout (clamped between 250 ms and 120 s).
  - `with_escalated_permissions` / `justification`: compatibility fields for Codex-style prompts; approvals remain managed by VS Code.
- **Runtime behavior:**
  - Validates input, ensures the working directory is inside the workspace, and streams execution via VS Code’s terminal pipeline (or a spawn fallback when `run_in_terminal` isn’t available).
  - Returns **terse** results: success with a short tail of output, failure with exit code or timeout/cancellation details, plus any warnings (for example, when the default workdir is used).

### The `apply_patch` language‑model tool (interface & behavior)

- **Extension:** `apps/codex-tools`
- **Name:** `apply_patch`
- **Purpose:** Apply a **Codex‑format patch** atomically to the workspace.
- **Parameters the model can set:**
  - `patch` (string; **required**): the complete Codex patch text, including `*** Begin Patch` and `*** End Patch` markers.
  - `workdir` (string; optional): workspace directory to resolve relative paths (defaults to the first workspace folder).
  - `timeout_ms` (number; optional): hard timeout (clamped between 250 ms and 120 s).
- **Runtime behavior:**
  - Validates the patch envelope, ensures target paths stay within the workspace, and applies changes atomically per file with the built-in TypeScript port of Codex’ `apply_patch.py`.
  - Returns **terse** results: success with a short list of changed files, or a brief, actionable failure reason.

### The `update_plan` language‑model tool (interface & behavior)

- **Extension:** `apps/codex-tools`
- **Name:** `update_plan`
- **Purpose:** Maintain a short, task-oriented plan (≤ 8 steps) aligned with Codex guidance.
- **Parameters the model can set:**
  - `plan` (array; **required**): entries shaped as `{ step: string, status: pending | in_progress | completed }`.
  - `explanation` (string; optional): brief context for the plan.
- **Runtime behavior:**
  - Writes/updates a workspace-root `PLAN.md` and best-effort syncs to any native TODO LM tool (for example, `todo_list`, `github.copilot.todo`) when available, falling back silently if none accept the input.
  - Returns **terse** results summarizing plan counts and sync outcome.

### Patch language (accepted by `apply_patch`)

- **Envelope:** `*** Begin Patch` … `*** End Patch` (final newline recommended).
- **Per‑file sections:**
  - `*** Add File: <path>` → body lines prefixed with `+`
  - `*** Update File: <path>` → optional `*** Move to: <new path>`, then one or more `@@` blocks with lines starting `+`, `-`, or a single space
  - `*** Delete File: <path>` → no body
- Paths are scoped to the workspace; file changes are applied atomically per file. Output is **terse** (success + file list, or a brief failure reason).

### Patch engine

- The Codex Tools extension ships with a TypeScript port of Codex’s original `apply_patch.py`, so no external Python runtime or dependencies are required.

### Optional `update_plan`

- Lets the agent keep a short, evolving plan when it chooses to. It’s intentionally lightweight and used sparingly.

---

## Using Codex‑mode

- Select **`gpt‑5‑codex`**, switch to **Agent** mode, and ensure the contributed **`shell`**, **`apply_patch`**, and **`update_plan`** tools remain enabled.
- Ask for **small, focused changes**; for larger tasks, the agent should present a **short plan** before execution.
- Expect **patch‑based edits** rather than whole‑file dumps.
- Any confirmations/approvals for commands are handled by **GHCP/VS Code** (this project adds none).

---

## Validation checklist

- **Small edit** in one file → `apply_patch` applies a concise patch; no unrelated changes.
- **Multi‑file refactor** → short plan → series of `apply_patch` calls → quick checks/tests → brief results.
- **Planning work** → call `update_plan` to keep `PLAN.md` in sync (and optionally the native TODO list).
- **Risky command** via the `shell` tool → displayed in the integrated terminal with native GHCP/VS Code prompts/UX; no extra approval layer from this project.
- **Broad question** → narrow, on‑demand searches (no passive RAG flood).

---

## Limitations & notes

- Perfect parity with Codex’s private harness isn’t achievable in VS Code; this profile targets **behavioral parity** where it matters: minimal prompts, patch‑first edits, and a small tool surface.
- **No Codex sandbox/approval engine** is implemented here—approvals are **entirely managed by GHCP/VS Code**.
- Copilot/VS Code may add small framework scaffolding around prompts; keeping instructions short and tools minimal reduces drift.

---

## Troubleshooting

- **`apply_patch` or `update_plan` tool unavailable** → ensure the Codex Tools extension is installed, enabled in Agent → Tools, and that the expected input shape is supplied.
- **Patch failed (context mismatch)** → ask the agent to regenerate a smaller, more precise diff.
- **Wrong directory** → confirm the tool call includes `workdir` and your workspace root is correct.
- **Need raw tool logs** → run `Developer: Open Logs Folder`, open the newest `window*/exthost/exthost.log` (macOS default path: `~/Library/Application Support/Code/logs/<timestamp>/window1/exthost/exthost.log`), and look for lines such as `LanguageModel: Tool "shell" already has an implementation` or other `ghcxp.codex-tools` entries that explain why a tool was rejected.
- **Unsure what the LLM sees** → run the command palette action **View: Show Chat Debug** to inspect the effective system prompts, request timeline, and tool invocations recorded for each chat turn.
- **Verbose replies** → verify reasoning effort is minimal/low and custom instructions remain short and system‑scoped.

---

## Update: VS Code `apply_patch` alignment (November 2025)

Recent Copilot insider builds now remap the **Built-In** -> **Edit** -> **editFiles** tool capability to the canonical `apply_patch` tool name that is sent to the agent. They've decided to normalize names so that the model always sees a single Codex-style `apply_patch` entry. `gpt‑5‑codex` is the only foundation model with fine-tuning around tool use and patch formatting, so VS Code is aligning their built-in editor with Codex’s envelope/grammar instead of exposing a competing edit tool.

Practically speaking:

This is great news. If you are working inside VS Code, just enable the built-in **Edit files** tool and rely on it for patching (since it now follows codex patching conventions) over our custom `apply_patch` tool.
