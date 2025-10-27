# Codex‑Mode for GitHub Copilot Chat (GHCP)

Make GitHub Copilot Chat behave as closely as possible to OpenAI Codex (`gpt‑5‑codex`) inside VS Code—minimal prompts, patch‑based edits, and a tiny tool surface.

> **Reference:** The Codex prompting philosophy, system‑style rules, and edit guidance are summarized here: [GPT‑5 Codex Prompting Guide](https://cookbook.openai.com/examples/gpt-5-codex_prompting_guide).

---

## What this repository provides

- A ready‑to‑use profile under **`.vscode/settings.json`** that dials Copilot Chat toward Codex‑style behavior:

  - Prefer the **`gpt‑5‑codex`** model (BYOK supported).
  - Route **custom instructions into the _system_ message**.
  - Disable ambient RAG/context sources.
  - Minimize visible reasoning/summary verbosity.
  - Keep terminal **auto‑approve off** so GHCP/VS Code manage approvals as usual.

- A **language‑model tool** named **`shell`** that mirrors the interface Codex expects and reuses VS Code’s **Run Command / Terminal** plumbing (streaming, cancellation, telemetry, remote/devcontainer routing).

- An **`apply_patch` interceptor** _inside_ the `shell` tool that recognizes Codex‑style invocations and applies patches atomically to the workspace.

- An optional lightweight **`update_plan`** tool for short, task‑level plans when the model asks for one.

> **Scope change:** This project **does not implement Codex sandboxing or its approval policies**. Approvals/confirmations are handled entirely by **GitHub Copilot Chat and VS Code**. No additional approval gates are introduced here.

---

## Requirements

- VS Code with GitHub Copilot Chat (Agent mode available).
- Access to a `gpt‑5‑codex` deployment (OpenAI or Azure OpenAI Responses API).
- Permission to install/run a local VS Code extension (the LM tools).

---

## Setup (high‑level)

1. Open this repository in VS Code.
2. Build/enable the included extension that contributes the `shell` tool (with `apply_patch` interception) and the optional `update_plan`.
3. In Settings UI, enable **“Copilot › Chat: Custom Instructions In System Message.”**
4. Select your **`gpt‑5‑codex`** deployment in the model picker (BYOK supported via the sample settings).
5. In Copilot Chat → **Agent** → **Tools**, enable the contributed tools and disable others you don’t need.
6. Keep the included **short, Codex‑style custom instructions** system‑scoped.

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

- **Minimal system instructions**: no preambles; small plans only when tasks are non‑trivial; patch‑first edits.
- **Tiny tool surface**: `shell` for search/build/test and **`apply_patch`** (intercepted inside `shell`) for edits; optional `update_plan`.

### The `shell` language‑model tool (interface & behavior)

- **Name:** `shell`
- **Purpose:** Execute commands in the user’s environment with clear `workdir` semantics while leveraging VS Code’s built‑in terminal/run‑command stack.
- **Parameters the model can set:**

  - `command` (array of strings; **required**): argv vector.
  - `workdir` (string; **strongly encouraged**): workspace directory to run in.
  - `timeout_ms` (number; optional): hard timeout.
  - `with_escalated_permissions` (boolean; optional) and `justification` (string; optional): **accepted for compatibility**, but **approval/confirmation is handled by GHCP/VS Code**—this tool does not add its own approval policy.

- **Runtime behavior:**

  - Validates inputs and resolves `workdir`.
  - For normal commands, delegates to VS Code’s Run Command/Terminal pipeline (streaming, cancellation, telemetry, remote contexts).
  - Returns **terse** results: success with brief tail; failure with exit code and a short error tail; distinct timeout message.

### `apply_patch` interception (what the model expects)

- Recognizes both Codex‑style shapes:

  - **Arg‑vector form:** first token `apply_patch`, second token is the full patch body.
  - **Heredoc form:** a shell line containing `apply_patch << 'FENCE' … FENCE`.

- On detection, **does not spawn a process**—it applies the patch via an internal patch engine and returns a concise success/failure message.

### Patch language (accepted by the interceptor)

- **Envelope:** `*** Begin Patch` … `*** End Patch` (final newline recommended).
- **Per‑file sections:**

  - `*** Add File: <path>` → body lines prefixed with `+`
  - `*** Update File: <path>` → optional `*** Move to: <new path>`, then one or more `@@` blocks with lines starting `+`, `-`, or a single space
  - `*** Delete File: <path>` → no body

- Paths are scoped to the workspace; file changes are applied atomically per file. Output is **terse** (success + file list, or a brief failure reason).

### Python dependency bootstrap

- The bundled `apply_patch.py` is reused exactly as in Codex and depends on `pydantic`/`pydantic-core`.
- On first use, the extension automatically runs `python -m pip install --target <VS Code global storage>/python-lib -r resources/python/requirements.txt` using the first Python interpreter it finds (`python3`, `python`, or `py -3`).
- Installed wheels live under the extension’s global storage and are reused across sessions; no manual setup is required other than having a working Python + pip on your PATH.
- If your environment blocks outbound package installs, pre-populate the global storage directory with the required wheels or allowlist the install step.

### Optional `update_plan`

- Lets the agent keep a short, evolving plan when it chooses to. It’s intentionally lightweight and used sparingly.

---

## Using Codex‑mode

- Select **`gpt‑5‑codex`**, switch to **Agent** mode, and ensure only the intended tools are enabled.
- Ask for **small, focused changes**; for larger tasks, the agent should present a **short plan** before execution.
- Expect **patch‑based edits** rather than whole‑file dumps.
- Any confirmations/approvals for commands are handled by **GHCP/VS Code** (this project adds none).

---

## Validation checklist

- **Small edit** in one file → concise patch; no unrelated changes.
- **Multi‑file refactor** → short plan → patches → quick checks/tests → brief results.
- **Risky command** → displayed in the integrated terminal with native GHCP/VS Code prompts/UX; no extra approval layer from this tool.
- **Broad question** → narrow, on‑demand searches (no passive RAG flood).

---

## Limitations & notes

- Perfect parity with Codex’s private harness isn’t achievable in VS Code; this profile targets **behavioral parity** where it matters: minimal prompts, patch‑first edits, and a small tool surface.
- **No Codex sandbox/approval engine** is implemented here—approvals are **entirely managed by GHCP/VS Code**.
- Copilot/VS Code may add small framework scaffolding around prompts; keeping instructions short and tools minimal reduces drift.

---

## Troubleshooting

- **“apply_patch not found”** → ensure the `shell` tool is enabled and the patch envelope markers are exact.
- **Patch failed (context mismatch)** → ask the agent to regenerate a smaller, more precise diff.
- **Wrong directory** → confirm the tool call includes `workdir` and your workspace root is correct.
- **Verbose replies** → verify reasoning effort is minimal/low and custom instructions remain short and system‑scoped.
