# amp-quality-loop-plugin

Strict pre-commit quality-loop gate for [Amp](https://ampcode.com).

When an Amp agent tries a non-trivial mutating `git commit`, this plugin blocks the commit, marks the loop active in the TUI, and forces explicit quality-loop stage tools before a pass can be recorded.

## Prerequisites

- Amp with plugin support.
- Bun.
- Codex CLI on `PATH` for `codex review --uncommitted`.
- Required workflow skills installed from <https://github.com/lleewwiiss/codex-agents/tree/main/skills>, especially:
  - `review-and-simplify-changes`
  - `improve-codebase-architecture`
  - `improve-test-suite`

## Install with an Amp agent

Copy this repo URL into Amp and ask:

```text
Install this Amp quality-loop plugin from this repository URL.
Clone it if needed, run bun install, run bun run check, run bun run install:plugin,
then tell me to reload Amp plugins and verify amp plugins list shows quality-loop tools.
Do not stage, commit, or push anything.
```

Manual install:

```bash
bun install
bun run check
bun run install:plugin
```

Then reload Amp plugins with `plugins: reload` and verify:

```bash
amp plugins list
```

## Tools

- `quality_loop_start`: mark the active diff as in-review and show TUI active state.
- `quality_loop_review`: explicit checkpoint before running `review-and-simplify-changes`.
- `quality_loop_codex_review`: explicit checkpoint before running `codex review --uncommitted` with a long timeout, e.g. `timeout_ms: 600000`.
- `quality_loop_grader`: explicit checkpoint before launching the separate read-only grading subagent.
- `quality_loop_final_audit`: explicit checkpoint before final improve-codebase/improve-test read-only audits.
- `quality_loop_passed`: record a pass only after all stage tools were called for the active current diff.
- `quality_loop_cancel`: clear active TUI state without recording a pass.
- `quality-loop-status`: show current pass/active/required state.

## Required loop

1. Commit gate blocks `git commit` and instructs the agent to call `quality_loop_start`, then `quality_loop_review`.
2. Run `review-and-simplify-changes`; fix near-mandatory findings.
3. Call `quality_loop_codex_review`, then run `codex review --uncommitted` with a long timeout; adjudicate findings against intent.
4. Call `quality_loop_grader`, then launch a separate read-only grader to verify fixes/skips.
5. Repeat up to 3 review+Codex cycles. The plugin carries this count across same-thread same-repo diff restarts and refuses a 4th cycle. Cycle 1 is full diff; later cycles should target newly changed/fixed code unless fixes are broad. Rerun full Codex only when meaningful code changed since the last Codex pass.
6. Call `quality_loop_final_audit`, then run final read-only `improve-codebase-architecture` and `improve-test-suite` audits. Skill/prompting improvements are report-only.
7. Call `quality_loop_passed`, then retry the commit.

The TUI shows `Quality loop required`, animated `Quality loop active`, or `Quality loop passed` when the Amp client exposes the experimental status item API. Tools and commands still work without it.

## Development

```bash
bun run check
```

MIT. See [LICENSE](LICENSE).
