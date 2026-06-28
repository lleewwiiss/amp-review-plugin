import type {
  PluginAPI,
  PluginToolContext,
  ShellFunction,
  StatusItemValue,
  ThreadID,
  ToolCallEvent,
  ToolCallResult,
} from "@ampcode/plugin";

interface QualityLoopPass {
  cycles?: number;
  diffStat: string;
  finalSelfImprovement?: string;
  fingerprint: string;
  graderVerdict: string;
  recordedAt: number;
  repoRoot: string;
  summary: string;
  threadId: ThreadID;
}

interface QualityLoopState {
  passes: Record<string, QualityLoopPass>;
  version: 1;
}

interface RepoSnapshot {
  diffExcerpt: string;
  diffStat: string;
  fingerprint: string;
  hasChanges: boolean;
  repoKey: string;
  repoRoot: string;
  status: string;
}

interface QualityLoopStatusController {
  active(snapshot: RepoSnapshot): void;
  clear(): void;
  current(): QualityLoopStatusState | undefined;
  passed(pass: QualityLoopPass): void;
  required(snapshot: RepoSnapshot): void;
}

interface QualityLoopStatusState {
  fingerprint: string;
  kind: "active" | "passed" | "required";
  repoRoot: string;
  since: number;
}

interface PendingQualityLoopContinuation {
  command: string;
  repoRoot: string;
}

interface ActiveQualityLoop {
  completedStages: Array<QualityLoopStage>;
  cycles: number;
  fingerprint: string;
  repoKey: string;
}

type QualityLoopStage = "codex" | "final_audit" | "grade" | "review";

const CONFIG_KEY = "qualityLoopPlugin";
const CONFIG_TARGET = "global";
const STATUS_ITEM_URL = "command:quality-loop-status";
const STATUS_ANIMATION_INTERVAL_MS = 160;
const STATUS_REFRESH_INTERVAL_MS = 5000;
const MAX_CYCLES = 3;
const MAX_DIFF_EXCERPT_CHARS = 6000;
const MAX_PASSES = 50;
const MAX_TEXT_LENGTH = 1600;
const TRIVIAL_SKIP_CONFIDENCE = 0.85;
const ACTIVE_STATUS_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SHELL_INTERPRETERS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const QUALITY_LOOP_STAGE_SEQUENCE: Array<QualityLoopStage> = [
  "review",
  "codex",
  "grade",
  "final_audit",
];
const QUALITY_LOOP_STAGE_TOOLS: Record<QualityLoopStage, string> = {
  codex: "quality_loop_codex_review",
  final_audit: "quality_loop_final_audit",
  grade: "quality_loop_grader",
  review: "quality_loop_review",
};

export default function qualityLoopPlugin(amp: PluginAPI) {
  amp.logger.log("quality loop plugin initialized");
  const status = createQualityLoopStatus(amp);
  const pendingContinuations = new Map<ThreadID, PendingQualityLoopContinuation>();
  const activeLoops = new Map<ThreadID, ActiveQualityLoop>();

  amp.on("tool.call", async (event, ctx) => {
    const shellCommand = amp.helpers.shellCommandFromToolCall(event);
    if (!shellCommand || !isGitCommitCommand(shellCommand.command)) {
      return { action: "allow" };
    }

    const unsupportedRepoOverride = unsupportedRepoOverrideReason(shellCommand.command);
    if (unsupportedRepoOverride) {
      return {
        action: "reject-and-continue",
        message: renderUnsupportedRepoOverrideMessage(
          shellCommand.command,
          unsupportedRepoOverride,
        ),
      };
    }

    const workdir = commitWorkdir(shellCommand.command, shellCommand.dir ?? ".");
    return gateGitCommit(
      amp,
      ctx.$,
      status,
      pendingContinuations,
      event,
      shellCommand.command,
      workdir,
    );
  });

  amp.on("agent.end", async (event) => {
    if (event.status !== "done") {
      pendingContinuations.delete(event.thread.id);
      return;
    }

    const pending = pendingContinuations.get(event.thread.id);
    if (!pending) {
      return;
    }

    try {
      const snapshot = await getRepoSnapshot(amp, pending.repoRoot);
      if (!snapshot) {
        pendingContinuations.delete(event.thread.id);
        return {
          action: "continue",
          userMessage: renderContinuationRefreshFailedMessage(
            pending.command,
            pending.repoRoot,
            "repository could not be inspected",
          ),
        };
      }
      if (!snapshot.hasChanges) {
        pendingContinuations.delete(event.thread.id);
        return;
      }

      const pass = await getPassForRepo(amp, snapshot.repoKey);
      if (pass?.fingerprint === snapshot.fingerprint) {
        pendingContinuations.delete(event.thread.id);
        return;
      }

      pendingContinuations.delete(event.thread.id);
      return {
        action: "continue",
        userMessage: renderContinuationMessage(pending.command, snapshot, pass),
      };
    } catch (error) {
      amp.logger.log("quality loop continuation refresh failed", errorMessage(error));
      pendingContinuations.delete(event.thread.id);
      return {
        action: "continue",
        userMessage: renderContinuationRefreshFailedMessage(
          pending.command,
          pending.repoRoot,
          errorMessage(error),
        ),
      };
    }
  });

  amp.registerTool({
    description:
      "Start the strict pre-commit quality loop after the plugin blocks a non-trivial git commit. This marks the current diff as active in the TUI and returns the loop instructions the main agent must follow.",
    async execute(input, ctx) {
      return startQualityLoop(amp, status, pendingContinuations, activeLoops, input, ctx);
    },
    inputSchema: {
      properties: {
        blocked_command: {
          description: "The git commit command that was blocked by the quality-loop plugin.",
          type: "string",
        },
        expected_fingerprint: {
          description: "Optional diff fingerprint from the quality-loop blocked-commit message.",
          type: "string",
        },
        workdir: {
          description:
            "Repository working directory for the uncommitted changes. Use the same workdir as the blocked git commit command.",
          type: "string",
        },
      },
      required: ["workdir"],
      type: "object",
    },
    name: "quality_loop_start",
  });

  for (const stage of QUALITY_LOOP_STAGE_SEQUENCE) {
    amp.registerTool({
      description: renderStageToolDescription(stage),
      async execute(input, ctx) {
        return recordQualityLoopStage(amp, status, activeLoops, stage, input, ctx);
      },
      inputSchema: {
        properties: {
          workdir: {
            description:
              "Repository working directory for the uncommitted changes. Use the same workdir as quality_loop_start.",
            type: "string",
          },
        },
        required: ["workdir"],
        type: "object",
      },
      name: QUALITY_LOOP_STAGE_TOOLS[stage],
    });
  }

  amp.registerTool({
    description:
      "Cancel the active quality loop in this thread without recording a pass. Use for smoke tests, abandoned loops, or when the active TUI status should be cleared.",
    async execute(_input, ctx) {
      pendingContinuations.delete(ctx.thread.id);
      activeLoops.delete(ctx.thread.id);
      status.clear();
      return "quality_loop_cancel recorded. Active quality-loop status cleared for this thread; no pass was recorded.";
    },
    inputSchema: {
      properties: {},
      type: "object",
    },
    name: "quality_loop_cancel",
  });

  amp.registerTool({
    description:
      "Record that the strict pre-commit quality loop passed for the current uncommitted diff. Call only after quality_loop_review, quality_loop_codex_review, quality_loop_grader, and quality_loop_final_audit were called for the active current diff, review-and-simplify ran from the main thread with its required read-only review subagents/tracks, Codex CLI review findings were adjudicated and fixed when aligned with implementation intent, a separate read-only grading subagent verified fixes against feedback, and final improve-codebase/test audits ran.",
    async execute(input, ctx) {
      return recordQualityLoopPass(amp, status, activeLoops, input, ctx);
    },
    inputSchema: {
      properties: {
        cycles: {
          description: `Number of full quality-loop cycles completed. Maximum intended loop cap is ${MAX_CYCLES}.`,
          maximum: MAX_CYCLES,
          minimum: 1,
          type: "integer",
        },
        final_self_improvement: {
          description:
            "Optional concise report-only suggestions for global skills or future user prompting/process improvements. Do not include secrets.",
          type: "string",
        },
        grader_verdict: {
          description:
            "Required. Read-only grading subagent verdict confirming skill/Codex feedback was fixed, intentionally rejected with evidence, or no longer meaningful.",
          type: "string",
        },
        summary: {
          description:
            "Required. Concise summary of review findings fixed and any strongly-evidenced skips.",
          type: "string",
        },
        workdir: {
          description:
            "Repository working directory for the uncommitted changes. Use the same workdir as the git commit command.",
          type: "string",
        },
      },
      required: ["workdir", "summary", "grader_verdict"],
      type: "object",
    },
    name: "quality_loop_passed",
  });

  amp.registerCommand(
    "quality-loop-status",
    {
      category: "quality-loop",
      description: "Show whether the current repository diff has a recorded quality-loop pass.",
      title: "Show quality-loop status",
    },
    async (ctx) => {
      const workdir = ".";
      let snapshot: RepoSnapshot | undefined;
      try {
        snapshot = await getRepoSnapshot(amp, workdir, ctx.$);
      } catch (error) {
        await ctx.ui.notify(`Quality loop: could not inspect ${workdir}: ${errorMessage(error)}`);
        return;
      }
      if (!snapshot) {
        await ctx.ui.notify(
          renderCurrentStatus(status.current()) ?? `No git repository found from ${workdir}.`,
        );
        return;
      }

      const pass = await getPassForRepo(amp, snapshot.repoKey);
      await ctx.ui.notify(renderStatus(snapshot, pass, status.current()));
    },
  );
}

function createQualityLoopStatus(amp: PluginAPI): QualityLoopStatusController {
  const experimental = amp.experimental;
  if (!experimental?.createStatusItem) {
    return {
      active() {},
      clear() {},
      current() {
        return undefined;
      },
      passed() {},
      required() {},
    };
  }

  let item: ReturnType<typeof experimental.createStatusItem> | undefined;
  let current: QualityLoopStatusState | undefined;
  let refreshInFlight = false;

  const setStatusItem = (value: StatusItemValue) => {
    try {
      if (!item) {
        item = experimental.createStatusItem(value);
        return;
      }
      item.update(value);
    } catch (error) {
      amp.logger.log("quality loop status item update failed", errorMessage(error));
      item = undefined;
    }
  };

  const clearStatusItem = () => {
    current = undefined;
    const staleItem = item;
    item = undefined;
    try {
      staleItem?.unsubscribe();
    } catch (error) {
      amp.logger.log("quality loop status item clear failed", errorMessage(error));
    }
  };

  const refresh = () => {
    if (current) {
      setStatusItem(renderStatusItem(current));
    }
  };

  const refreshFromDisk = async () => {
    if (!current || refreshInFlight) {
      return;
    }

    refreshInFlight = true;
    try {
      const snapshot = await getRepoSnapshot(amp, current.repoRoot);
      if (!snapshot?.hasChanges) {
        clearStatusItem();
        return;
      }

      const pass = await getPassForRepo(amp, snapshot.repoKey);
      if (pass?.fingerprint === snapshot.fingerprint) {
        current = passedState(pass);
        refresh();
        return;
      }

      if (current.kind === "passed" || current.fingerprint !== snapshot.fingerprint) {
        current = requiredState(snapshot);
        refresh();
      }
    } catch (error) {
      amp.logger.log("quality loop status refresh failed", errorMessage(error));
    } finally {
      refreshInFlight = false;
    }
  };

  unrefTimer(
    setInterval(() => {
      if (current?.kind === "active") {
        refresh();
      }
    }, STATUS_ANIMATION_INTERVAL_MS),
  );

  unrefTimer(setInterval(() => void refreshFromDisk(), STATUS_REFRESH_INTERVAL_MS));

  return {
    active(snapshot) {
      current = activeState(snapshot);
      refresh();
    },
    clear() {
      clearStatusItem();
    },
    current() {
      return current;
    },
    passed(pass) {
      current = passedState(pass);
      refresh();
    },
    required(snapshot) {
      current = requiredState(snapshot);
      refresh();
    },
  };
}

function activeState(snapshot: RepoSnapshot): QualityLoopStatusState {
  return {
    fingerprint: snapshot.fingerprint,
    kind: "active",
    repoRoot: snapshot.repoRoot,
    since: Date.now(),
  };
}

function requiredState(snapshot: RepoSnapshot): QualityLoopStatusState {
  return {
    fingerprint: snapshot.fingerprint,
    kind: "required",
    repoRoot: snapshot.repoRoot,
    since: Date.now(),
  };
}

function passedState(pass: QualityLoopPass): QualityLoopStatusState {
  return {
    fingerprint: pass.fingerprint,
    kind: "passed",
    repoRoot: pass.repoRoot,
    since: pass.recordedAt,
  };
}

function renderStatusItem(state: QualityLoopStatusState): StatusItemValue {
  if (state.kind === "active") {
    return { text: `${activeStatusFrame()} Quality loop active`, url: STATUS_ITEM_URL };
  }

  if (state.kind === "passed") {
    return { text: "Quality loop passed", url: STATUS_ITEM_URL };
  }

  return {
    text: "Quality loop required",
    url: STATUS_ITEM_URL,
  };
}

function renderCurrentStatus(state: QualityLoopStatusState | undefined) {
  if (!state) {
    return undefined;
  }

  const age = formatDuration(Date.now() - state.since);
  if (state.kind === "active") {
    return `Quality loop: active.\nRepo: ${state.repoRoot}\nFingerprint: ${state.fingerprint}\nStarted: ${age} ago.`;
  }

  return state.kind === "passed"
    ? `Quality loop: pass recorded.\nRepo: ${state.repoRoot}\nFingerprint: ${state.fingerprint}\nRecorded: ${age} ago.`
    : `Quality loop: required.\nRepo: ${state.repoRoot}\nFingerprint: ${state.fingerprint}\nStarted: ${age} ago.`;
}

async function gateGitCommit(
  amp: PluginAPI,
  shell: ShellFunction,
  statusController: QualityLoopStatusController,
  pendingContinuations: Map<ThreadID, PendingQualityLoopContinuation>,
  event: ToolCallEvent,
  command: string,
  workdir: string,
): Promise<ToolCallResult> {
  try {
    const snapshot = await getRepoSnapshot(amp, workdir, shell);
    if (!snapshot) {
      return {
        action: "reject-and-continue",
        message: renderInspectionFailedMessage(command, workdir),
      };
    }

    if (!snapshot.hasChanges) {
      return { action: "allow" };
    }

    const pass = await getPassForRepo(amp, snapshot.repoKey);
    if (pass?.fingerprint === snapshot.fingerprint) {
      statusController.passed(pass);
      return { action: "allow" };
    }

    const trivial = await isConfidentlyTrivial(amp, snapshot);
    if (trivial) {
      amp.logger.log("quality loop skipped for trivial diff", snapshot.repoRoot);
      return { action: "allow" };
    }

    statusController.required(snapshot);
    pendingContinuations.set(event.thread.id, {
      command,
      repoRoot: snapshot.repoRoot,
    });
    return {
      action: "reject-and-continue",
      message: renderGateMessage(command, snapshot, pass),
    };
  } catch (error) {
    amp.logger.log("quality loop commit gate failed closed", errorMessage(error));
    return {
      action: "reject-and-continue",
      message: renderInspectionFailedMessage(command, workdir, errorMessage(error)),
    };
  }
}

async function startQualityLoop(
  amp: PluginAPI,
  statusController: QualityLoopStatusController,
  pendingContinuations: Map<ThreadID, PendingQualityLoopContinuation>,
  activeLoops: Map<ThreadID, ActiveQualityLoop>,
  input: Record<string, unknown>,
  ctx: PluginToolContext,
) {
  const workdir = validateWorkdir(input.workdir, "quality_loop_start");
  if (!workdir.ok) {
    return workdir.message;
  }

  const inspection = await inspectChangedRepo(amp, workdir.value, "quality_loop_start");
  if (!inspection.ok) {
    return inspection.message;
  }
  const snapshot = inspection.snapshot;

  const pass = await getPassForRepo(amp, snapshot.repoKey);
  if (pass?.fingerprint === snapshot.fingerprint) {
    pendingContinuations.delete(ctx.thread.id);
    statusController.passed(pass);
    return "quality_loop_start skipped: current diff already has a recorded pass. Retry the git commit.";
  }

  pendingContinuations.delete(ctx.thread.id);
  const previousLoop = activeLoops.get(ctx.thread.id);
  const cycles = carriedCycleCount(previousLoop, snapshot);
  if (cycles >= MAX_CYCLES) {
    statusController.required(snapshot);
    return renderCycleLimitReachedMessage(snapshot, cycles);
  }

  activeLoops.set(ctx.thread.id, {
    completedStages: [],
    cycles,
    fingerprint: snapshot.fingerprint,
    repoKey: snapshot.repoKey,
  });
  statusController.active(snapshot);

  const blockedCommand =
    typeof input.blocked_command === "string" && input.blocked_command.trim()
      ? input.blocked_command.trim()
      : "git commit";
  const expectedFingerprint =
    typeof input.expected_fingerprint === "string" && input.expected_fingerprint.trim()
      ? input.expected_fingerprint.trim()
      : undefined;
  const fingerprintNote =
    expectedFingerprint && expectedFingerprint !== snapshot.fingerprint
      ? `\n\nNote: blocked fingerprint ${expectedFingerprint} changed to ${snapshot.fingerprint}; run the loop against the current diff.`
      : "";

  return `${renderLoopInstructions(blockedCommand, snapshot, pass)}${fingerprintNote}`;
}

async function recordQualityLoopStage(
  amp: PluginAPI,
  statusController: QualityLoopStatusController,
  activeLoops: Map<ThreadID, ActiveQualityLoop>,
  stage: QualityLoopStage,
  input: Record<string, unknown>,
  ctx: PluginToolContext,
) {
  const toolName = QUALITY_LOOP_STAGE_TOOLS[stage];
  const workdir = validateWorkdir(input.workdir, toolName);
  if (!workdir.ok) {
    return workdir.message;
  }

  const inspection = await inspectChangedRepo(amp, workdir.value, toolName);
  if (!inspection.ok) {
    return inspection.message;
  }
  const snapshot = inspection.snapshot;

  const activeLoop = activeLoops.get(ctx.thread.id);
  if (!activeLoop || !activeLoopMatches(activeLoop, snapshot)) {
    return `${toolName} failed: call quality_loop_start in this thread for the current diff first.`;
  }

  const missingPrerequisites = missingPrerequisiteStages(activeLoop, stage);
  if (missingPrerequisites.length > 0) {
    return `${toolName} failed: call ${missingPrerequisites
      .map((missingStage) => QUALITY_LOOP_STAGE_TOOLS[missingStage])
      .join(", ")} first for the current diff.`;
  }

  const stageAlreadyCompleted = activeLoop.completedStages.includes(stage);
  if (isReviewCycleStage(stage) && !stageAlreadyCompleted && activeLoop.cycles >= MAX_CYCLES) {
    return `${toolName} failed: maximum ${MAX_CYCLES} review+Codex cycles already reached for this blocked commit flow. Stop and report the current state instead of starting another review/Codex loop.`;
  }

  if (!stageAlreadyCompleted) {
    if (stage === "codex") {
      activeLoop.cycles += 1;
    }
    activeLoop.completedStages.push(stage);
  }
  statusController.active(snapshot);

  const remainingStages = missingRequiredStages(activeLoop);
  return [
    `${toolName} recorded for current diff.`,
    `repo: ${snapshot.repoRoot}`,
    `fingerprint: ${snapshot.fingerprint}`,
    renderStageInstruction(stage, snapshot),
    remainingStages.length > 0
      ? `remaining stage tools before quality_loop_passed: ${remainingStages
          .map((remainingStage) => QUALITY_LOOP_STAGE_TOOLS[remainingStage])
          .join(", ")}`
      : "all explicit stage tools recorded; after final audit evidence is ready, call quality_loop_passed.",
  ].join("\n");
}

async function recordQualityLoopPass(
  amp: PluginAPI,
  statusController: QualityLoopStatusController,
  activeLoops: Map<ThreadID, ActiveQualityLoop>,
  input: Record<string, unknown>,
  ctx: PluginToolContext,
) {
  const summary = validateRequiredText(input.summary, "quality_loop_passed", "summary");
  if (!summary.ok) {
    return summary.message;
  }
  const graderVerdict = validateRequiredText(
    input.grader_verdict,
    "quality_loop_passed",
    "grader_verdict",
  );
  if (!graderVerdict.ok) {
    return graderVerdict.message;
  }
  const workdir = validateWorkdir(input.workdir, "quality_loop_passed");
  if (!workdir.ok) {
    return workdir.message;
  }

  const cycles = getPositiveInteger(input.cycles);
  if (input.cycles !== undefined && cycles === undefined) {
    return "quality_loop_passed failed: cycles must be a positive integer when provided.";
  }
  if (cycles !== undefined && cycles > MAX_CYCLES) {
    return `quality_loop_passed failed: cycles must be at most ${MAX_CYCLES}.`;
  }

  const inspection = await inspectChangedRepo(amp, workdir.value, "quality_loop_passed");
  if (!inspection.ok) {
    return inspection.message;
  }
  const snapshot = inspection.snapshot;

  const activeLoop = activeLoops.get(ctx.thread.id);
  if (!activeLoop || !activeLoopMatches(activeLoop, snapshot)) {
    return "quality_loop_passed failed: call quality_loop_start in this thread for the current diff before recording a pass.";
  }

  if (cycles !== undefined && cycles !== activeLoop.cycles) {
    return `quality_loop_passed failed: cycles must match the tracked review+Codex cycle count (${activeLoop.cycles}).`;
  }

  const missingStages = missingRequiredStages(activeLoop);
  if (missingStages.length > 0) {
    return `quality_loop_passed failed: call ${missingStages
      .map((stage) => QUALITY_LOOP_STAGE_TOOLS[stage])
      .join(", ")} for the current diff before recording a pass.`;
  }

  const finalSelfImprovement =
    typeof input.final_self_improvement === "string"
      ? trimText(input.final_self_improvement, MAX_TEXT_LENGTH)
      : undefined;

  const pass: QualityLoopPass = {
    cycles: activeLoop.cycles,
    diffStat: trimText(snapshot.diffStat, MAX_TEXT_LENGTH),
    finalSelfImprovement,
    fingerprint: snapshot.fingerprint,
    graderVerdict: graderVerdict.value,
    recordedAt: Date.now(),
    repoRoot: snapshot.repoRoot,
    summary: summary.value,
    threadId: ctx.thread.id,
  };

  const state = await getState(amp);
  await updateState(amp, {
    passes: prunePasses({ ...state.passes, [snapshot.repoKey]: pass }),
    version: 1,
  });
  activeLoops.delete(ctx.thread.id);
  statusController.passed(pass);

  return [
    "quality_loop_passed recorded.",
    `repo: ${snapshot.repoRoot}`,
    `fingerprint: ${snapshot.fingerprint}`,
    cycles ? `cycles: ${cycles}` : undefined,
    finalSelfImprovement ? `final_self_improvement: ${finalSelfImprovement}` : undefined,
    "Next git commit through Amp is allowed while the uncommitted diff fingerprint stays unchanged.",
  ]
    .filter(isDefined)
    .join("\n");
}

function carriedCycleCount(activeLoop: ActiveQualityLoop | undefined, snapshot: RepoSnapshot) {
  return activeLoop?.repoKey === snapshot.repoKey ? activeLoop.cycles : 0;
}

function isReviewCycleStage(stage: QualityLoopStage) {
  return stage === "review" || stage === "codex";
}

function activeLoopMatches(activeLoop: ActiveQualityLoop | undefined, snapshot: RepoSnapshot) {
  return (
    activeLoop?.repoKey === snapshot.repoKey && activeLoop.fingerprint === snapshot.fingerprint
  );
}

function missingRequiredStages(activeLoop: ActiveQualityLoop | undefined) {
  return QUALITY_LOOP_STAGE_SEQUENCE.filter(
    (stage) => !activeLoop?.completedStages.includes(stage),
  );
}

function missingPrerequisiteStages(activeLoop: ActiveQualityLoop, stage: QualityLoopStage) {
  const stageIndex = QUALITY_LOOP_STAGE_SEQUENCE.indexOf(stage);
  return QUALITY_LOOP_STAGE_SEQUENCE.slice(0, stageIndex).filter(
    (requiredStage) => !activeLoop.completedStages.includes(requiredStage),
  );
}

function renderStageToolDescription(stage: QualityLoopStage) {
  switch (stage) {
    case "review":
      return "Record that the current quality loop has explicitly reached the review-and-simplify stage and return the exact instruction to run review-and-simplify-changes against the uncommitted diff.";
    case "codex":
      return "Record that the current quality loop has explicitly reached the Codex review stage and return the exact instruction to run codex review --uncommitted with a long shell timeout after review-and-simplify has run.";
    case "grade":
      return "Record that the current quality loop has explicitly reached the separate-grader stage and return the exact instruction to launch a read-only grading subagent after review-and-simplify and Codex fixes.";
    case "final_audit":
      return "Record that the current quality loop has explicitly reached the final improve-codebase/improve-test audit stage and return the exact instruction to run those final read-only audits before quality_loop_passed.";
  }
}

function renderStageInstruction(stage: QualityLoopStage, snapshot: RepoSnapshot) {
  switch (stage) {
    case "review":
      return `Next: run the review-and-simplify-changes skill in this main thread against the uncommitted diff in ${snapshot.repoRoot}. Cycle 1 should review the full diff; later cycles should target newly changed/fixed code unless fixes are broad. Launch the read-only review subagents/tracks that the skill requires, apply near-mandatory findings, and skip only false-positive/out-of-scope findings with evidence. Then call quality_loop_codex_review.`;
    case "codex":
      return `Next: run Codex CLI from ${snapshot.repoRoot} with: codex review --uncommitted. Use a long shell timeout, e.g. timeout_ms 600000 (10 minutes), because Codex review often exceeds the default 120s. Cycle 1 should run full Codex; later cycles should rerun full Codex only when meaningful code changed since the last Codex pass. Adjudicate findings against the implementation intent, apply aligned fixes, and do not blindly accept scope-changing suggestions. Then call quality_loop_grader.`;
    case "grade":
      return "Next: launch a separate read-only grading subagent. It must compare review-and-simplify/Codex feedback against the current diff and verify fixes/skips; the main agent must not self-grade. Then call quality_loop_final_audit.";
    case "final_audit":
      return "Next: run final read-only improve-codebase-architecture and improve-test-suite passes against the uncommitted diff/thread/process. Fix only introduced or worsened blockers, keep global skill/prompting suggestions report-only, then call quality_loop_passed.";
  }
}

async function getRepoSnapshot(
  amp: PluginAPI,
  workdir: string,
  shell: ShellFunction = amp.$,
): Promise<RepoSnapshot | undefined> {
  let repoRoot: string;
  try {
    repoRoot = (await shell`git -C ${workdir} rev-parse --show-toplevel`).stdout.trim();
  } catch (error) {
    amp.logger.log("quality loop repo detection failed", errorMessage(error));
    return undefined;
  }

  const status = (await shell`git -C ${repoRoot} status --porcelain=v1 --untracked-files=all`)
    .stdout;
  const stagedDiff = (await shell`git -C ${repoRoot} diff --binary --cached --`).stdout;
  const unstagedDiff = (await shell`git -C ${repoRoot} diff --binary --`).stdout;
  const stagedStat = (await shell`git -C ${repoRoot} diff --stat --cached --`).stdout;
  const unstagedStat = (await shell`git -C ${repoRoot} diff --stat --`).stdout;
  const untrackedFingerprints = await getUntrackedFileFingerprints(amp, shell, repoRoot);
  const fingerprint = createSnapshotFingerprint(
    status,
    stagedDiff,
    unstagedDiff,
    untrackedFingerprints,
  );

  return {
    diffExcerpt: trimText(
      [stagedDiff, unstagedDiff].filter(Boolean).join("\n"),
      MAX_DIFF_EXCERPT_CHARS,
    ),
    diffStat: [stagedStat, unstagedStat]
      .filter((text) => text.trim())
      .join("\n")
      .trim(),
    fingerprint,
    hasChanges: Boolean(status.trim()),
    repoKey: repoKey(repoRoot),
    repoRoot,
    status,
  };
}

async function getUntrackedFileFingerprints(
  amp: PluginAPI,
  shell: ShellFunction,
  repoRoot: string,
) {
  const output = (await shell`git -C ${repoRoot} ls-files --others --exclude-standard -z`).stdout;
  const paths = output.split("\0").filter(Boolean).sort();
  const fingerprints: Array<string> = [];

  for (const path of paths) {
    try {
      const mode = await getUntrackedFileMode(shell, repoRoot, path);
      const identity =
        mode === "120000"
          ? await getUntrackedSymlinkTarget(shell, repoRoot, path)
          : (await shell`git -C ${repoRoot} hash-object -- ${path}`).stdout.trim();
      fingerprints.push(`${path}\0${mode}\0${identity}`);
    } catch (error) {
      throw new Error(`untracked file ${path} is unreadable: ${errorMessage(error)}`);
    }
  }

  return fingerprints;
}

async function getUntrackedFileMode(shell: ShellFunction, repoRoot: string, path: string) {
  const absolutePath = normalizePath(`${repoRoot}/${path}`);
  return (
    await shell`if [ -L ${absolutePath} ]; then printf 120000; elif [ -x ${absolutePath} ]; then printf 100755; else printf 100644; fi`
  ).stdout.trim();
}

async function getUntrackedSymlinkTarget(shell: ShellFunction, repoRoot: string, path: string) {
  const absolutePath = normalizePath(`${repoRoot}/${path}`);
  return (await shell`readlink ${absolutePath}`).stdout.trim();
}

async function isConfidentlyTrivial(amp: PluginAPI, snapshot: RepoSnapshot) {
  try {
    const answer = await amp.ai
      .ask(`Is this uncommitted git diff trivial enough to skip the strict quality loop before commit?

Answer yes only for clearly low-risk changes such as README/docs prose, comments-only edits, or tiny non-behavioral metadata/text tweaks. Answer no for source code, tests, build/config, dependency/lockfile changes, generated public contracts, behavior changes, or anything uncertain.

Repository: ${snapshot.repoRoot}
Status:\n${snapshot.status || "(empty)"}
Diff stat:\n${snapshot.diffStat || "(none)"}
Diff excerpt:\n${snapshot.diffExcerpt || "(no tracked diff; possibly untracked files only)"}`);

    return answer.result === "yes" && answer.probability >= TRIVIAL_SKIP_CONFIDENCE;
  } catch (error) {
    amp.logger.log("quality loop trivial classifier failed", errorMessage(error));
    return false;
  }
}

async function getState(amp: PluginAPI): Promise<QualityLoopState> {
  const config = await amp.configuration.get();
  const value = config[CONFIG_KEY];
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.passes)) {
    return { passes: {}, version: 1 };
  }

  const passes: Record<string, QualityLoopPass> = {};
  for (const [key, pass] of Object.entries(value.passes)) {
    if (isQualityLoopPass(pass)) {
      passes[key] = pass;
    }
  }
  return { passes, version: 1 };
}

async function updateState(amp: PluginAPI, state: QualityLoopState) {
  await amp.configuration.update({ [CONFIG_KEY]: state }, CONFIG_TARGET);
}

async function getPassForRepo(amp: PluginAPI, key: string) {
  return (await getState(amp)).passes[key];
}

function renderGateMessage(
  command: string,
  snapshot: RepoSnapshot,
  previousPass: QualityLoopPass | undefined,
) {
  return `Quality loop required before git commit.

${renderCommitContext(command, snapshot, previousPass)}

The plugin will auto-start a follow-up turn. The agent must first call quality_loop_start with workdir "${snapshot.repoRoot}", blocked_command ${JSON.stringify(command)}, and expected_fingerprint "${snapshot.fingerprint}", then immediately call quality_loop_review with workdir "${snapshot.repoRoot}" and run the returned review-and-simplify instruction. Do not merely report that the loop is required.

Current diff summary:\n${snapshot.diffStat || snapshot.status}`;
}

function renderCommitContext(
  command: string,
  snapshot: RepoSnapshot,
  previousPass: QualityLoopPass | undefined,
) {
  return `Blocked command: ${command}
Repo: ${snapshot.repoRoot}
Diff fingerprint: ${snapshot.fingerprint}
${renderPreviousPass(previousPass)}`;
}

function renderInspectionFailedMessage(command: string, workdir: string, reason?: string) {
  return `Quality loop blocked git commit because it could not inspect the target repository.

Blocked command: ${command}
Resolved workdir: ${workdir}
${reason ? `Reason: ${reason}\n` : ""}
Use an explicit, literal repository path without shell variables or unsupported directory-changing shell syntax, then retry. The plugin fails closed for detected git commit commands unless it can inspect the exact target repo.`;
}

function renderUnsupportedRepoOverrideMessage(command: string, reason: string) {
  return `Quality loop blocked git commit because it uses unsupported repository override syntax.

Blocked command: ${command}
Reason: ${reason}

Use a literal workdir, simple cd, or git -C path so the plugin can inspect the same repository before allowing a commit.`;
}

function renderLoopInstructions(
  command: string,
  snapshot: RepoSnapshot,
  previousPass: QualityLoopPass | undefined,
) {
  return `Quality loop active for blocked git commit.

${renderCommitContext(command, snapshot, previousPass)}

Run this loop in the current Amp thread, then retry the commit:
First required action: call quality_loop_review with workdir "${snapshot.repoRoot}".

Then follow the instructions returned by each quality-loop stage tool. quality_loop_passed will reject until quality_loop_review, quality_loop_codex_review, quality_loop_grader, and quality_loop_final_audit have all been called for this active diff. Cycle 1 should review the full diff; later cycles should target newly changed/fixed code unless fixes are broad. Rerun full Codex only when meaningful code changed since the last Codex pass.

Use quality_loop_cancel only for smoke tests or abandoned loops; it clears active TUI status without recording a pass.

Current diff summary:\n${snapshot.diffStat || snapshot.status}`;
}

function renderCycleLimitReachedMessage(snapshot: RepoSnapshot, cycles: number) {
  return `quality_loop_start failed: maximum ${MAX_CYCLES} review+Codex cycles already reached for this blocked commit flow.

Repo: ${snapshot.repoRoot}
Fingerprint: ${snapshot.fingerprint}
Cycles: ${cycles}

Stop instead of starting another review/Codex loop. Report the current state, blockers, verification, and residual risk to the user.`;
}

function renderContinuationMessage(
  command: string,
  snapshot: RepoSnapshot,
  previousPass: QualityLoopPass | undefined,
) {
  return `The quality-loop plugin blocked the previous commit. First required actions: call quality_loop_start with workdir "${snapshot.repoRoot}", blocked_command ${JSON.stringify(command)}, and expected_fingerprint "${snapshot.fingerprint}"; then call quality_loop_review with workdir "${snapshot.repoRoot}" and run the returned review-and-simplify instruction. Do not retry the commit or merely report status before those tool calls. ${renderPreviousPass(previousPass)}`;
}

function renderContinuationRefreshFailedMessage(command: string, repoRoot: string, reason: string) {
  return `The quality-loop plugin blocked the previous commit, but could not refresh the current diff before auto-starting the loop.

Blocked command: ${command}
Repo: ${repoRoot}
Reason: ${reason}

Inspect the repository state, then call quality_loop_start with workdir "${repoRoot}" before retrying the commit.`;
}

function renderPreviousPass(previousPass: QualityLoopPass | undefined) {
  return previousPass
    ? `Previous pass fingerprint: ${previousPass.fingerprint} (diff changed since pass)`
    : "No recorded pass for this diff.";
}

function renderStatus(
  snapshot: RepoSnapshot,
  pass: QualityLoopPass | undefined,
  current?: QualityLoopStatusState,
) {
  if (!snapshot.hasChanges) {
    return `Quality loop: no uncommitted changes in ${snapshot.repoRoot}.`;
  }
  if (pass?.fingerprint === snapshot.fingerprint) {
    return [
      "Quality loop: pass recorded for current diff.",
      `Repo: ${snapshot.repoRoot}`,
      `Recorded: ${new Date(pass.recordedAt).toISOString()}`,
      pass.cycles ? `Cycles: ${pass.cycles}` : undefined,
      `Summary: ${pass.summary}`,
      `Grader: ${pass.graderVerdict}`,
      `Thread: ${pass.threadId}`,
      pass.diffStat ? `Diff stat: ${pass.diffStat}` : undefined,
      pass.finalSelfImprovement
        ? `Final self-improvement: ${pass.finalSelfImprovement}`
        : undefined,
    ]
      .filter(isDefined)
      .join("\n");
  }

  if (current?.kind === "active" && current.fingerprint === snapshot.fingerprint) {
    return [
      "Quality loop: active for current diff.",
      `Repo: ${snapshot.repoRoot}`,
      `Started: ${new Date(current.since).toISOString()}`,
      `Fingerprint: ${snapshot.fingerprint}`,
    ].join("\n");
  }

  return [
    "Quality loop: pass required before git commit.",
    `Repo: ${snapshot.repoRoot}`,
    pass
      ? "Recorded pass exists, but diff changed since it was recorded."
      : "No pass recorded for this repo diff.",
    `Fingerprint: ${snapshot.fingerprint}`,
  ].join("\n");
}

function isGitCommitCommand(command: string): boolean {
  if (findGitCommit(command) !== undefined) {
    return true;
  }
  return [...wrappedShellScripts(command), ...wrappedEnvSplitScripts(command)].some((script) =>
    isGitCommitCommand(script),
  );
}

function wrappedEnvSplitScripts(command: string): Array<string> {
  const tokens = shellTokens(command);
  const scripts: Array<string> = [];
  for (const [index, token] of tokens.entries()) {
    if (shellCommandName(token) !== "env" || !isGitCommandStart(tokens, index)) {
      continue;
    }
    const script = envSplitStringArgument(tokens, index);
    if (script !== undefined) {
      scripts.push(script);
    }
  }
  return scripts;
}

function envSplitStringArgument(tokens: Array<string>, envIndex: number) {
  for (let index = envIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || isShellCommandBoundary(token)) {
      return undefined;
    }
    if (token === "--") {
      return undefined;
    }
    if (isShellAssignment(token)) {
      continue;
    }
    if (token === "-S" || token === "--split-string") {
      return tokens[index + 1];
    }
    if (token.startsWith("-S") && token.length > 2) {
      return token.slice(2);
    }
    if (token.startsWith("--split-string=")) {
      return token.slice("--split-string=".length);
    }
    if (!token.startsWith("-")) {
      return undefined;
    }
    if (envOptionConsumesNextToken(token)) {
      index += 1;
    }
  }
  return undefined;
}

function wrappedShellScripts(command: string): Array<string> {
  const tokens = shellTokens(command);
  const scripts: Array<string> = [];
  for (const [index, token] of tokens.entries()) {
    if (!token || !isShellInterpreter(token) || !isGitCommandStart(tokens, index)) {
      continue;
    }
    const script = shellCommandStringArgument(tokens, index);
    if (script !== undefined) {
      scripts.push(script);
    }
  }
  return scripts;
}

function isShellInterpreter(token: string) {
  const base = shellCommandName(token);
  return base !== undefined && SHELL_INTERPRETERS.has(base);
}

function shellCommandStringArgument(tokens: Array<string>, interpreterIndex: number) {
  for (let index = interpreterIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || isShellCommandBoundary(token) || !token.startsWith("-")) {
      return undefined;
    }
    if (!token.startsWith("--") && token.includes("c")) {
      return tokens[index + 1];
    }
    if (shellOptionConsumesNextToken(token)) {
      index += 1;
    }
  }
  return undefined;
}

function shellOptionConsumesNextToken(token: string) {
  return token === "-o" || token === "--init-file" || token === "--rcfile";
}

function unsupportedRepoOverrideReason(command: string) {
  if (wrappedShellScripts(command).some((script) => isGitCommitCommand(script))) {
    return "shell interpreter wrappers cannot be matched safely to the committed worktree";
  }

  if (wrappedEnvSplitScripts(command).some((script) => isGitCommitCommand(script))) {
    return "env split-string wrappers cannot be matched safely to the committed worktree";
  }

  if (findGitCommits(command).length > 1) {
    return "multiple git commit commands cannot be matched safely to one reviewed diff";
  }

  const gitCommit = findGitCommit(command);
  if (!gitCommit) {
    return undefined;
  }

  const unsupportedPrefix = unsupportedCommandPrefixReason(gitCommit.tokens, gitCommit.gitIndex);
  if (unsupportedPrefix) {
    return unsupportedPrefix;
  }

  const unsupportedWorkdir = unsupportedPreCommitWorkdirReason(
    gitCommit.tokens,
    gitCommit.gitIndex,
  );
  if (unsupportedWorkdir) {
    return unsupportedWorkdir;
  }

  const segmentStart = findSegmentStart(gitCommit.tokens, gitCommit.gitIndex);
  for (let index = segmentStart; index < gitCommit.commitIndex; index += 1) {
    const token = gitCommit.tokens[index];
    if (
      token === "--git-dir" ||
      token === "--work-tree" ||
      token?.startsWith("--git-dir=") ||
      token?.startsWith("--work-tree=") ||
      token?.startsWith("GIT_DIR=") ||
      token?.startsWith("GIT_INDEX_FILE=") ||
      token?.startsWith("GIT_WORK_TREE=")
    ) {
      return `${token} cannot be matched safely to the committed worktree`;
    }
  }

  return undefined;
}

function unsupportedCommandPrefixReason(tokens: Array<string>, gitIndex: number) {
  const segmentStart = findSegmentStart(tokens, gitIndex);
  const prefix = tokens.slice(segmentStart, gitIndex);
  const envWorkdirOverride = unsupportedEnvWorkdirOverrideReason(prefix);
  if (envWorkdirOverride) {
    return envWorkdirOverride;
  }

  return prefix.some(isUnsupportedCommandPrefix)
    ? `${prefix.join(" ")} cannot be matched safely to the committed worktree`
    : undefined;
}

function unsupportedEnvWorkdirOverrideReason(prefix: Array<string>): string | undefined {
  const commandPrefix = trimLeadingAssignments(prefix);
  for (const [index, token] of commandPrefix.entries()) {
    if (shellCommandName(token) !== "env") {
      continue;
    }
    const reason = unsupportedEnvWorkdirOptionReason(commandPrefix.slice(index + 1));
    if (reason) {
      return reason;
    }
  }

  return undefined;
}

function unsupportedEnvWorkdirOptionReason(tokens: Array<string>): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || isShellAssignment(token) || token === "--") {
      continue;
    }
    if (isEnvWorkdirOption(token)) {
      return `${token} cannot be matched safely to the committed worktree`;
    }
    if (!token.startsWith("-")) {
      return unsupportedEnvWorkdirOverrideReason(tokens.slice(index));
    }
    if (envOptionConsumesNextToken(token)) {
      index += 1;
    }
  }

  return undefined;
}

function isUnsupportedCommandPrefix(token: string | undefined) {
  const command = shellCommandName(token);
  return command === "noglob" || command === "sudo";
}

function unsupportedPreCommitWorkdirReason(tokens: Array<string>, gitIndex: number) {
  let segmentStart = 0;
  let separator: string | undefined;

  while (segmentStart < gitIndex) {
    const segmentEnd = findSegmentEnd(tokens, segmentStart);
    const segment = tokens.slice(segmentStart, Math.min(segmentEnd, gitIndex));
    const cd = simpleCd(segment);
    const followingSeparator = tokens[segmentEnd];

    if (cd.kind === "unsupported") {
      return cd.reason;
    }

    if (cd.kind === "path") {
      if (segment.some((token) => isShellControlPrefix(token) || token === "(" || token === ")")) {
        return `cd ${cd.path} appears inside unsupported shell grouping or control flow before git commit`;
      }
      if (separator !== undefined && separator !== ";" && separator !== "(") {
        return `cd ${cd.path} is conditionally executed before git commit`;
      }
      if (followingSeparator === "|" || followingSeparator === "||" || followingSeparator === "&") {
        return `cd ${cd.path} does not reliably affect the later git commit worktree`;
      }
    }

    if (segmentEnd >= gitIndex) {
      break;
    }

    separator = followingSeparator;
    segmentStart = segmentEnd + 1;
  }

  return undefined;
}

function hasNonMutatingCommitOption(tokens: Array<string>, commitIndex: number) {
  let dryRun = false;

  for (let index = commitIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || isShellCommandBoundary(token)) {
      break;
    }

    if (token === "--") {
      break;
    }

    if (token === "--help" || token === "-h") {
      return true;
    }

    if (token === "--no-dry-run") {
      dryRun = false;
      continue;
    }

    if (
      token === "--dry-run" ||
      token === "--short" ||
      token === "--porcelain" ||
      token === "--long"
    ) {
      dryRun = true;
      continue;
    }

    if (commitOptionConsumesNextToken(token)) {
      index += 1;
    }
  }

  return dryRun;
}

function commitOptionConsumesNextToken(token: string) {
  return (
    token === "-c" ||
    token === "-C" ||
    token === "-F" ||
    token === "-m" ||
    token === "--author" ||
    token === "--cleanup" ||
    token === "--date" ||
    token === "--file" ||
    token === "--fixup" ||
    token === "--message" ||
    token === "--pathspec-file-nul" ||
    token === "--pathspec-from-file" ||
    token === "--reedit-message" ||
    token === "--reuse-message" ||
    token === "--squash" ||
    token === "--template" ||
    token === "--trailer" ||
    token === "-t" ||
    clusteredCommitOptionConsumesNextToken(token)
  );
}

function clusteredCommitOptionConsumesNextToken(token: string) {
  if (!token.startsWith("-") || token.startsWith("--") || token.length <= 2) {
    return false;
  }

  for (let index = 1; index < token.length; index += 1) {
    const option = token[index];
    if (option && "cCFmt".includes(option)) {
      return index === token.length - 1;
    }
  }

  return false;
}

function commitWorkdir(command: string, fallback: string) {
  const gitCommit = findGitCommit(command);
  if (!gitCommit) {
    return fallback;
  }

  let workdir = resolvePreCommitWorkdir(gitCommit.tokens, gitCommit.gitIndex, fallback);
  for (let index = gitCommit.gitIndex + 1; index < gitCommit.commitIndex; index += 1) {
    const token = gitCommit.tokens[index];
    if (token === "-C") {
      const path = gitCommit.tokens[index + 1];
      if (path && !isShellSeparator(path)) {
        workdir = resolveWorkdir(path, workdir);
        index += 1;
      }
      continue;
    }

    if (token?.startsWith("-C") && token.length > 2) {
      workdir = resolveWorkdir(token.slice(2), workdir);
    }
  }

  return workdir;
}

function resolvePreCommitWorkdir(tokens: Array<string>, gitIndex: number, fallback: string) {
  let workdir = fallback;
  let segmentStart = 0;
  let separator: string | undefined;

  while (segmentStart < gitIndex) {
    const segmentEnd = findSegmentEnd(tokens, segmentStart);
    const segment = tokens.slice(segmentStart, Math.min(segmentEnd, gitIndex));
    const cdPath = simpleCdPath(segment);
    const followingSeparator = tokens[segmentEnd];
    const cdRunsInSubshell =
      followingSeparator === "|" || followingSeparator === "||" || followingSeparator === "&";
    if (
      cdPath &&
      !cdRunsInSubshell &&
      (separator === undefined || separator === ";" || separator === "(")
    ) {
      workdir = resolveWorkdir(cdPath, workdir);
    }

    if (segmentEnd >= gitIndex) {
      break;
    }

    separator = followingSeparator;
    segmentStart = segmentEnd + 1;
  }

  return workdir;
}

function findSegmentEnd(tokens: Array<string>, start: number) {
  let index = start;
  while (index < tokens.length && !isShellCommandBoundary(tokens[index])) {
    index += 1;
  }
  return index;
}

function simpleCdPath(segment: Array<string>) {
  const cd = simpleCd(segment);
  return cd.kind === "path" ? cd.path : undefined;
}

function simpleCd(
  segment: Array<string>,
): { kind: "none" } | { kind: "path"; path: string } | { kind: "unsupported"; reason: string } {
  let index = 0;
  while (isShellAssignment(segment[index])) {
    index += 1;
  }
  if (segment.some(isShellControlPrefix)) {
    return segment.includes("cd")
      ? { kind: "unsupported", reason: "cd appears inside shell control flow before git commit" }
      : { kind: "none" };
  }
  if (segment[index] !== "cd") {
    return { kind: "none" };
  }

  const next = segment[index + 1];
  const pathIndex = next === "--" ? index + 2 : index + 1;
  const path = resolvableCdPath(segment[pathIndex]);
  if (!path) {
    return { kind: "unsupported", reason: "cd before git commit uses an unsupported target" };
  }
  if (segment.length !== pathIndex + 1) {
    return {
      kind: "unsupported",
      reason: `cd ${path} uses unsupported shell syntax before git commit`,
    };
  }
  return { kind: "path", path };
}

function resolvableCdPath(path: string | undefined) {
  return path && path !== "-" ? path : undefined;
}

function findGitCommit(command: string) {
  return findGitCommits(command)[0];
}

function findGitCommits(command: string) {
  const tokens = shellTokens(command);
  const commits: Array<{ commitIndex: number; gitIndex: number; tokens: Array<string> }> = [];
  for (const [gitIndex, token] of tokens.entries()) {
    if (!isGitExecutable(token)) {
      continue;
    }
    if (!isGitCommandStart(tokens, gitIndex)) {
      continue;
    }

    for (let commitIndex = gitIndex + 1; commitIndex < tokens.length; commitIndex += 1) {
      const current = tokens[commitIndex];
      if (isShellSeparator(current)) {
        break;
      }
      if (gitGlobalOptionConsumesNextToken(current)) {
        commitIndex += 1;
        continue;
      }
      if (current?.startsWith("-C") && current.length > 2) {
        continue;
      }
      if (current?.startsWith("--git-dir=") || current?.startsWith("--work-tree=")) {
        continue;
      }
      if (current === "commit") {
        if (!hasNonMutatingCommitOption(tokens, commitIndex)) {
          commits.push({ commitIndex, gitIndex, tokens });
        }
        break;
      }
      if (current === "commit-tree") {
        break;
      }
    }
  }

  return commits;
}

function isGitExecutable(token: string | undefined) {
  const command = shellCommandName(token);
  return command === "git" || command === "git.exe";
}

function gitGlobalOptionConsumesNextToken(token: string | undefined) {
  return (
    token === "-C" ||
    token === "-c" ||
    token === "--config-env" ||
    token === "--exec-path" ||
    token === "--git-dir" ||
    token === "--namespace" ||
    token === "--work-tree"
  );
}

function isGitCommandStart(tokens: Array<string>, gitIndex: number) {
  const segmentStart = findSegmentStart(tokens, gitIndex);
  const prefix = trimLeadingAssignments(tokens.slice(segmentStart, gitIndex));
  if (prefix.length === 0) {
    return true;
  }

  const [command, ...rest] = prefix;
  if (isShellControlPrefix(command) && rest.length === 0) {
    return true;
  }

  return isCommandPrefix(prefix);
}

function isCommandPrefix(prefix: Array<string>): boolean {
  const [command, ...rest] = trimLeadingAssignments(prefix);
  const commandName = shellCommandName(command);
  if (!commandName) {
    return true;
  }
  if (commandName === "env") {
    return isEnvCommandPrefix(rest);
  }
  if (commandName === "command" || commandName === "exec") {
    return isShellBuiltinCommandPrefix(commandName, rest);
  }
  if (commandName === "noglob" || commandName === "sudo") {
    return true;
  }

  return false;
}

function shellCommandName(token: string | undefined) {
  return token?.replaceAll("\\", "/").split("/").at(-1);
}

function isShellBuiltinCommandPrefix(command: string, tokens: Array<string>) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || isShellAssignment(token)) {
      continue;
    }
    if (!token.startsWith("-")) {
      return isCommandPrefix(tokens.slice(index));
    }
    if (command === "exec" && token === "-a") {
      index += 1;
      if (index >= tokens.length) {
        return false;
      }
    }
  }

  return true;
}

function trimLeadingAssignments(tokens: Array<string>) {
  let index = 0;
  while (isShellAssignment(tokens[index])) {
    index += 1;
  }
  return tokens.slice(index);
}

function isEnvCommandPrefix(tokens: Array<string>) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || isShellAssignment(token)) {
      continue;
    }
    if (token === "--") {
      return isCommandPrefix(tokens.slice(index + 1));
    }
    if (!token.startsWith("-")) {
      return isCommandPrefix(tokens.slice(index));
    }
    if (envOptionConsumesNextToken(token)) {
      index += 1;
      if (index >= tokens.length) {
        return false;
      }
    }
  }

  return true;
}

function envOptionConsumesNextToken(token: string) {
  return (
    token === "-C" ||
    token === "-P" ||
    token === "-S" ||
    token === "-a" ||
    token === "-u" ||
    token === "--argv0" ||
    token === "--block-signal" ||
    token === "--chdir" ||
    token === "--default-signal" ||
    token === "--ignore-signal" ||
    token === "--split-string" ||
    token === "--unset"
  );
}

function isEnvWorkdirOption(token: string) {
  return (
    token === "-C" || token === "--chdir" || token.startsWith("-C") || token.startsWith("--chdir=")
  );
}

function isShellControlPrefix(token: string | undefined) {
  return (
    token === "!" ||
    token === "{" ||
    token === "do" ||
    token === "else" ||
    token === "if" ||
    token === "then" ||
    token === "time" ||
    token === "until" ||
    token === "while"
  );
}

function findSegmentStart(tokens: Array<string>, index: number) {
  for (let current = index - 1; current >= 0; current -= 1) {
    if (isShellCommandBoundary(tokens[current])) {
      return current + 1;
    }
  }
  return 0;
}

function isShellAssignment(token: string | undefined) {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token ?? "");
}

function shellTokens(command: string) {
  const tokens: Array<string> = [];
  let token = "";
  let quote: '"' | "'" | undefined;

  const pushToken = () => {
    if (token) {
      tokens.push(token);
      token = "";
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (!character) {
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        token += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === "\n" || character === "\r") {
      pushToken();
      if (tokens.at(-1) !== ";") {
        tokens.push(";");
      }
      if (character === "\r" && command[index + 1] === "\n") {
        index += 1;
      }
      continue;
    }

    if (/\s/.test(character)) {
      pushToken();
      continue;
    }

    if (character === "\\" && /\s/.test(command[index + 1] ?? "")) {
      token += command[index + 1];
      index += 1;
      continue;
    }

    if (
      character === ";" ||
      character === "&" ||
      character === "|" ||
      character === "(" ||
      character === ")"
    ) {
      pushToken();
      const next = command[index + 1];
      if ((character === "&" || character === "|") && next === character) {
        tokens.push(`${character}${next}`);
        index += 1;
      } else {
        tokens.push(character);
      }
      continue;
    }

    token += character;
  }

  pushToken();
  return tokens;
}

function isShellSeparator(token: string | undefined) {
  return token === ";" || token === "&" || token === "&&" || token === "|" || token === "||";
}

function isShellCommandBoundary(token: string | undefined) {
  return token === "(" || isShellSeparator(token);
}

function resolveWorkdir(path: string, fallback: string) {
  return isAbsolutePath(path) ? normalizePath(path) : normalizePath(`${fallback}/${path}`);
}

function isAbsolutePath(path: string) {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function normalizePath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const prefix = normalized.startsWith("/") ? "/" : "";
  const parts: Array<string> = [];

  for (const part of normalized.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length > 0 && parts.at(-1) !== "..") {
        parts.pop();
      } else if (!prefix) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }

  return `${prefix}${parts.join("/")}` || ".";
}

function repoKey(repoRoot: string) {
  return stableHash(repoRoot).slice(0, 24);
}

function createSnapshotFingerprint(
  status: string,
  stagedDiff: string,
  unstagedDiff: string,
  untrackedFingerprints: Array<string>,
) {
  return stableHash(
    [status, stagedDiff, unstagedDiff, untrackedFingerprints.join("\n")].join(
      "\n---quality-loop---\n",
    ),
  );
}

function stableHash(value: string) {
  let left = 3_735_928_559 ^ value.length;
  let right = 1_103_547_991 ^ value.length;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    left = Math.imul(left ^ character, 2_654_435_761);
    right = Math.imul(right ^ character, 1_597_337_677);
  }
  left =
    Math.imul(left ^ (left >>> 16), 2_246_822_507) ^
    Math.imul(right ^ (right >>> 13), 3_266_489_909);
  right =
    Math.imul(right ^ (right >>> 16), 2_246_822_507) ^
    Math.imul(left ^ (left >>> 13), 3_266_489_909);

  return `${(right >>> 0).toString(16).padStart(8, "0")}${(left >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function prunePasses(passes: Record<string, QualityLoopPass>) {
  return Object.fromEntries(
    Object.entries(passes)
      .sort(([, left], [, right]) => right.recordedAt - left.recordedAt)
      .slice(0, MAX_PASSES),
  );
}

type ValidationResult = { message: string; ok: false } | { ok: true; value: string };

type RepoInspection = { message: string; ok: false } | { ok: true; snapshot: RepoSnapshot };

function validateRequiredText(value: unknown, toolName: string, field: string): ValidationResult {
  if (typeof value !== "string" || !value.trim()) {
    return { message: `${toolName} failed: ${field} is required.`, ok: false };
  }
  return { ok: true, value: trimText(value, MAX_TEXT_LENGTH) };
}

function validateWorkdir(value: unknown, toolName: string): ValidationResult {
  if (typeof value !== "string" || !value.trim()) {
    return { message: `${toolName} failed: workdir is required.`, ok: false };
  }
  return { ok: true, value: value.trim() };
}

async function inspectChangedRepo(
  amp: PluginAPI,
  workdir: string,
  toolName: string,
): Promise<RepoInspection> {
  let snapshot: RepoSnapshot | undefined;
  try {
    snapshot = await getRepoSnapshot(amp, workdir);
  } catch (error) {
    return {
      message: `${toolName} failed: could not inspect ${workdir}: ${errorMessage(error)}`,
      ok: false,
    };
  }
  if (!snapshot) {
    return { message: `${toolName} failed: no git repository found from ${workdir}.`, ok: false };
  }
  if (!snapshot.hasChanges) {
    return {
      message: `${toolName} failed: no uncommitted changes found in ${snapshot.repoRoot}.`,
      ok: false,
    };
  }
  return { ok: true, snapshot };
}

function trimText(value: string, maxLength: number) {
  const normalized = value.replaceAll(/\s+$/gm, "").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
}

function activeStatusFrame() {
  const index = Math.floor(Date.now() / STATUS_ANIMATION_INTERVAL_MS) % ACTIVE_STATUS_FRAMES.length;
  return ACTIVE_STATUS_FRAMES[index] ?? "⠋";
}

function getPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isQualityLoopPass(value: unknown): value is QualityLoopPass {
  return (
    isRecord(value) &&
    optionalPositiveInteger(value.cycles) &&
    optionalString(value.finalSelfImprovement) &&
    typeof value.diffStat === "string" &&
    typeof value.fingerprint === "string" &&
    typeof value.graderVerdict === "string" &&
    typeof value.recordedAt === "number" &&
    typeof value.repoRoot === "string" &&
    typeof value.summary === "string" &&
    isThreadId(value.threadId)
  );
}

function optionalPositiveInteger(value: unknown) {
  return value === undefined || getPositiveInteger(value) !== undefined;
}

function optionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function isThreadId(value: unknown): value is ThreadID {
  return typeof value === "string" && value.startsWith("T-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function unrefTimer(timer: unknown) {
  if (!isRecord(timer)) {
    return;
  }

  const unref = timer.unref;
  if (typeof unref === "function") {
    unref.call(timer);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const __testing = {
  activeLoopMatches,
  carriedCycleCount,
  commitWorkdir,
  createQualityLoopStatus,
  createSnapshotFingerprint,
  isGitCommitCommand,
  isReviewCycleStage,
  missingRequiredStages,
  unsupportedRepoOverrideReason,
};
