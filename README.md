# amp-review-plugin

Strict pre-commit review gate for [Amp](https://ampcode.com).

When an Amp agent tries a non-trivial mutating `git commit`, this plugin blocks the commit, marks the review gate active in the TUI, and forces explicit review-gate stage tools before a pass can be recorded.

Repo/package name: `amp-review-plugin`. Source and installed plugin file: `review-gate.ts`. Tool names stay `quality_loop_*` for compatibility with existing review workflows.

## Prerequisites

- Amp with plugin support.
- Codex CLI on `PATH` for `codex review --uncommitted`.
- Required workflow skills installed from <https://github.com/lleewwiiss/codex-agents/tree/main/skills>, especially:
  - `review-and-simplify-changes`
  - `improve-codebase-architecture`
  - `improve-test-suite`

## Install

Amp loads user plugins from `~/.config/amp/plugins/*.ts`. Install this plugin by copying the plugin file there:

```bash
mkdir -p ~/.config/amp/plugins
curl -fsSL https://raw.githubusercontent.com/lleewwiiss/amp-review-plugin/main/src/review-gate.ts \
  -o ~/.config/amp/plugins/review-gate.ts &&
rm -f ~/.config/amp/plugins/quality-loop.ts
```

Then reload Amp plugins with `plugins: reload` from the command palette, or restart Amp.

If you want an Amp agent to install it, ask for exactly that file-copy install:

```text
Install https://github.com/lleewwiiss/amp-review-plugin as an Amp plugin.
Download src/review-gate.ts from main into ~/.config/amp/plugins/review-gate.ts,
creating ~/.config/amp/plugins if needed. Remove any old
~/.config/amp/plugins/quality-loop.ts copy to avoid duplicate plugins. Do not
clone the repository unless you need to edit it. After copying, tell me to reload
Amp plugins or restart Amp.
```

For local development from a clone:

```bash
bun install
bun run check
bun run install:plugin
```

Then reload Amp plugins with `plugins: reload` from the command palette, or restart Amp.

## Tools

- `quality_loop_start`: mark the active diff as in-review and show TUI active state.
- `quality_loop_review`: explicit checkpoint before running `review-and-simplify-changes`.
- `quality_loop_codex_review`: explicit checkpoint before running `codex review --uncommitted` with a long timeout, e.g. `timeout_ms: 600000`.
- `quality_loop_grader`: explicit checkpoint before launching the separate read-only grading subagent.
- `quality_loop_final_audit`: explicit checkpoint before final improve-codebase/improve-test read-only audits.
- `quality_loop_passed`: record a pass only after all stage tools were called for the active current diff.
- `quality_loop_cancel`: clear active TUI state without recording a pass.
- `review-gate-status`: show current pass/active/required state.

## Required loop

1. Commit gate blocks `git commit` and instructs the agent to call `quality_loop_start`, then `quality_loop_review`.
2. Run `review-and-simplify-changes`; fix near-mandatory findings.
3. Call `quality_loop_codex_review`, then run `codex review --uncommitted` with a long timeout; adjudicate findings against intent.
4. Call `quality_loop_grader`, then launch a separate read-only grader to verify fixes/skips.
5. Repeat up to 3 review+Codex cycles. The plugin carries this count across same-thread same-repo diff restarts and refuses a 4th cycle. Cycle 1 is full diff; later cycles should target newly changed/fixed code unless fixes are broad. Rerun full Codex only when meaningful code changed since the last Codex pass.
6. Call `quality_loop_final_audit`, then run final read-only `improve-codebase-architecture` and `improve-test-suite` audits. Skill/prompting improvements are report-only.
7. Call `quality_loop_passed`, then retry the commit.

The TUI shows `Review gate required`, animated `Review gate active`, or `Review gate passed` when the Amp client exposes the experimental status item API. Tools and commands still work without it.

## Development

Development from a clone requires Bun.

```bash
bun run check
```

MIT. See [LICENSE](LICENSE).
