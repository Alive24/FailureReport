# FailureReport Shea runtime

This directory is the committed Shea Symphony configuration for FailureReport. It is intentionally created by hand; this repository does not use .shea-example or a Target Runtime Init flow.

Tracked configuration:

- app-profile.json selects the shared workflow.
- workflows/shea-symphony.md contains the GitHub Project #10 and lane runtime configuration.
- prompts/ contains the separate Main, Review, and Merge lane contracts.

`workflows/` and `prompts/` are FailureReport-owned integration contracts and may be tailored to this Node/TypeScript repository. `.shea/app/` and `.shea/bin/` are the vendored Shea Symphony 2606 MVP runtime; do not patch them when changing FailureReport's tracker policy or lane instructions.

Machine-local files are ignored by the repository root .gitignore:

- logs/, artifacts/, and worktrees/ are runtime output.
- any file whose name contains .local. under .shea/ is a machine-specific override, for example workflows/shea-symphony.local.md or app-profile.local.json.

The 2606 MVP workflow loader does not merge a base workflow with a .local workflow automatically. A local workflow must therefore be a complete valid workflow, and a local profile must explicitly select it. For example, create the ignored .shea/app-profile.local.json with:

    {
      "workflow_path": ".shea/workflows/shea-symphony.local.md"
    }

Run the Tauri app from an independent Shea Symphony 2606 MVP checkout's app directory, selecting this target profile explicitly:

    SHEA_SYMPHONY_APP_PROFILE_PATH="/absolute/path/to/FailureReport/.shea/app-profile.json" \
      npm run tauri -- dev

The shared profile intentionally omits cli_path so the Tauri app uses its 2606 engine bridge rather than assuming a target-local Shea binary. Do not use the browser-only npm run dev command to orchestrate FailureReport.

260720 Notes: We are using vendored version of Shea Symphony 2606 by running:

SHEA_SYMPHONY_APP_PROFILE_PATH="$PWD/.shea/app-profile.json" ./.shea/app/shea-symphony-app
