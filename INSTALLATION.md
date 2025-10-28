# Installation

These steps show how to package and install the Codex-mode language-model tools (the `shell` and `apply_patch` tools, plus the optional `update_plan`) into VS Code using **pnpm** throughout. All commands are run from the repository root unless indicated otherwise.

## Prerequisites

- VS Code with GitHub Copilot Chat enabled.
- A `gpt-5-codex` (Responses API) deployment you can select inside Copilot Chat.
- Node.js 20+ with `corepack` enabled so pnpm 10.x is available (`corepack enable pnpm`).
- The `@vscode/vsce` CLI (invoked through `pnpm dlx` in the commands below).

## 1. Install workspace dependencies

```bash
pnpm install
```

This hydrates every workspace package, including the `apps/codex-tools` extension.

## 2. Build the extensions

```bash
pnpm --filter codex-tools build
```

The compiled JavaScript is emitted into `apps/codex-tools/dist`.

## 3. Package with `vsce` (pnpm-aware)

`vsce` expects regular `node_modules` trees, so when running from a pnpm workspace provide the `--follow-symlinks` flag. Run the packager from the extension folder:

```bash
cd apps/codex-tools
pnpm dlx @vscode/vsce package --follow-symlinks
```

This produces `apps/codex-tools/codex-tools-0.3.0.vsix`. If you bundle the extension before packaging you may add `--no-dependencies`, mirroring the guidance shared by the VS Code team ([reference](https://github.com/microsoft/vscode-vsce/issues/421#issuecomment-1038911725)).

## 4. Install the VSIX in VS Code

1. Open this repository in VS Code so the `.vscode/settings.json` profile takes effect.
2. From the Command Palette, run **Extensions: Install from VSIX…** and select `apps/codex-tools/codex-tools-0.3.0.vsix`.
3. Reload VS Code when prompted.

## 5. Enable the tools in Copilot Chat

1. Open Copilot Chat → **Agent** → **Tools**.
2. Enable the contributed **Codex Shell**, **Codex Apply Patch**, and **Codex Update Plan** tools.
3. Select your `gpt-5-codex` deployment in the model picker.

## 6. Smoke test

In Copilot Chat:

1. Invoke the `shell` tool with a simple command, for example:

    ```json
    {
      "command": ["bash", "-lc", "pwd"],
      "workdir": "/path/to/ghcxp"
    }
    ```

2. Invoke the `apply_patch` tool to append a test line to `apply_patch_fixture.txt`, for example:

    ```json
    {
      "patch": "*** Begin Patch\n*** Update File: apply_patch_fixture.txt\n@@\n-This file exists so we can verify Codex-style apply_patch edits work end-to-end.\n+This file exists so we can verify Codex-style apply_patch edits work end-to-end.\n+Codex apply_patch smoke test.\n*** End Patch"
    }
    ```

3. Invoke the `update_plan` tool with a short plan:

    ```json
    {
      "plan": [
        {"step": "Review README edits", "status": "in_progress"},
        {"step": "Run pnpm test", "status": "pending"},
        {"step": "Commit changes", "status": "pending"}
      ],
      "explanation": "Initial plan after syncing Codex tools."
    }
    ```

Confirm the terminal output streams back, approvals use the native VS Code flow, `PLAN.md` is updated, and (if present) the native TODO tool accepts the sync. Revert the test plan when you are finished.
