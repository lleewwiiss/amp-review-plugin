import { describe, expect, test } from "bun:test";
import qualityLoopPlugin, { __testing } from "./review-gate.ts";

const activeLoop = (overrides = {}) => ({
  codexFingerprints: [],
  completedStages: [],
  cycles: 0,
  repoKey: "repo-a",
  reviewReadyForCodex: false,
  ...overrides,
});

const createPluginHarness = () => {
  const tools = {};
  const configuration = { value: { qualityLoopPlugin: { passes: {}, version: 1 } } };
  const amp = {
    $: fakeRepoShell,
    configuration: {
      async get() {
        return configuration.value;
      },
      async update(update) {
        configuration.value = { ...configuration.value, ...update };
      },
    },
    helpers: {
      shellCommandFromToolCall() {
        return undefined;
      },
    },
    logger: { log() {} },
    on() {},
    registerCommand() {},
    registerTool(tool) {
      if (!tool?.name || typeof tool.execute !== "function") {
        throw new Error("invalid tool registration");
      }
      tools[tool.name] = tool;
    },
  };

  qualityLoopPlugin(amp);

  return {
    configuration,
    ctx: { thread: { id: "T-test-thread" } },
    tools,
  };
};

const executeTool = (tools, ctx, name, input = {}) => {
  const tool = tools[name];
  if (!tool || typeof tool.execute !== "function") {
    throw new Error(`missing registered tool: ${name}`);
  }
  return tool.execute({ workdir: "/repo/a", ...input }, ctx);
};

const shellResult = (stdout) => ({ exitCode: 0, stderr: "", stdout });

async function fakeRepoShell(strings, ...values) {
  const command = strings.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, "");
  if (command.includes(" rev-parse --show-toplevel")) {
    return shellResult("/repo/a\n");
  }
  if (command.includes(" status --porcelain=v1 --untracked-files=all")) {
    return shellResult("M  file.ts\n");
  }
  if (command.includes(" diff --binary --cached --")) {
    return shellResult("diff --git a/file.ts b/file.ts\n");
  }
  if (command.includes(" diff --binary --")) {
    return shellResult("");
  }
  if (command.includes(" diff --stat --cached --")) {
    return shellResult(" file.ts | 1 +\n");
  }
  if (command.includes(" diff --stat --")) {
    return shellResult("");
  }
  if (command.includes(" ls-files --others --exclude-standard -z")) {
    return shellResult("");
  }
  throw new Error(`unexpected shell command: ${command}`);
}

describe("commit gate parsing", () => {
  test("ignores read-only commit probes but catches later mutating commits", () => {
    expect(__testing.isGitCommitCommand("git commit --dry-run")).toBe(false);
    expect(__testing.isGitCommitCommand("git commit --help")).toBe(false);
    expect(__testing.isGitCommitCommand("git commit --dry-run && git commit -m x")).toBe(true);
    expect(__testing.isGitCommitCommand("git commit -S --dry-run")).toBe(false);
    expect(__testing.isGitCommitCommand("git commit -S --help")).toBe(false);
  });

  test("does not treat option-looking arguments as non-mutating options", () => {
    expect(__testing.isGitCommitCommand('git commit -m "--dry-run"')).toBe(true);
    expect(__testing.isGitCommitCommand("git commit -- --help")).toBe(true);
  });

  test("detects common shell prefixes and control blocks", () => {
    expect(__testing.isGitCommitCommand("GIT_AUTHOR_DATE=now git commit -m x")).toBe(true);
    expect(__testing.isGitCommitCommand("FOO=bar env git commit -m x")).toBe(true);
    expect(__testing.isGitCommitCommand("/usr/bin/env git commit -m x")).toBe(true);
    expect(__testing.isGitCommitCommand("env FOO=bar git commit -m x")).toBe(true);
    expect(__testing.isGitCommitCommand("env -u FOO git commit -m x")).toBe(true);
    expect(__testing.isGitCommitCommand('env -S "git commit -m x"')).toBe(true);
    expect(__testing.isGitCommitCommand(String.raw`env -S git\ commit\ -m\ x`)).toBe(true);
    expect(__testing.isGitCommitCommand('/usr/bin/env --split-string "git commit -m x"')).toBe(
      true,
    );
    expect(__testing.isGitCommitCommand("env --unset FOO git commit -m x")).toBe(true);
    expect(__testing.isGitCommitCommand("command git commit -m x")).toBe(true);
    expect(__testing.isGitCommitCommand("if true; then git commit -m x; fi")).toBe(true);
  });

  test("detects path-qualified git executables", () => {
    expect(__testing.isGitCommitCommand("/usr/bin/git commit -m x")).toBe(true);
    expect(__testing.isGitCommitCommand("/opt/homebrew/bin/git commit -m x")).toBe(true);
    expect(__testing.isGitCommitCommand("echo /usr/bin/git commit -m x")).toBe(false);
  });

  test("treats newlines as shell command separators", () => {
    expect(__testing.isGitCommitCommand("git commit --dry-run\ngit commit -m x")).toBe(true);
  });

  test("treats -t/--template as an argument-consuming option", () => {
    expect(__testing.isGitCommitCommand("git commit -t --dry-run -m x")).toBe(true);
    expect(__testing.isGitCommitCommand("git commit --template --dry-run -m x")).toBe(true);
    expect(__testing.isGitCommitCommand("git commit -t template.txt --dry-run")).toBe(false);
  });

  test("treats clustered short options with operands as argument-consuming", () => {
    expect(__testing.isGitCommitCommand("git commit -am --dry-run")).toBe(true);
    expect(__testing.isGitCommitCommand("git commit -aF --dry-run")).toBe(true);
    expect(__testing.isGitCommitCommand("git commit -am message --dry-run")).toBe(false);
    expect(__testing.isGitCommitCommand("git commit -amessage --dry-run")).toBe(false);
  });

  test("detects git commit hidden inside shell interpreter wrappers", () => {
    expect(__testing.isGitCommitCommand('bash -lc "git commit -m x"')).toBe(true);
    expect(__testing.isGitCommitCommand("sh -c 'git commit -m x'")).toBe(true);
    expect(__testing.isGitCommitCommand("/bin/bash -c 'git commit -m x'")).toBe(true);
    expect(
      __testing.isGitCommitCommand(String.raw`C:\Windows\System32\bash -lc "git commit -m x"`),
    ).toBe(true);
    expect(__testing.isGitCommitCommand("bash --norc -c 'git commit -m x'")).toBe(true);
    expect(__testing.isGitCommitCommand("bash -o pipefail -c 'git commit -m x'")).toBe(true);
    expect(__testing.isGitCommitCommand("echo bash -c 'git commit -m x'")).toBe(false);
    expect(__testing.isGitCommitCommand('bash -lc "echo git commit"')).toBe(false);
    expect(__testing.isGitCommitCommand('bash -lc "git commit --dry-run"')).toBe(false);
  });

  test("skips git global option operands before matching commit", () => {
    expect(__testing.isGitCommitCommand("git -C commit status")).toBe(false);
    expect(__testing.isGitCommitCommand("git -C subdir commit -m x")).toBe(true);
  });

  test("rejects unsupported repo override syntax for detected commits", () => {
    expect(
      typeof __testing.unsupportedRepoOverrideReason("git --git-dir=/tmp/repo/.git commit -m x"),
    ).toBe("string");
    expect(
      typeof __testing.unsupportedRepoOverrideReason("GIT_WORK_TREE=/tmp/repo git commit -m x"),
    ).toBe("string");
    expect(
      typeof __testing.unsupportedRepoOverrideReason("GIT_INDEX_FILE=/tmp/index git commit -m x"),
    ).toBe("string");
    expect(typeof __testing.unsupportedRepoOverrideReason("FOO=bar sudo git commit -m x")).toBe(
      "string",
    );
    expect(typeof __testing.unsupportedRepoOverrideReason("env FOO=bar sudo git commit -m x")).toBe(
      "string",
    );
    expect(typeof __testing.unsupportedRepoOverrideReason("FOO=bar env sudo git commit -m x")).toBe(
      "string",
    );
    expect(typeof __testing.unsupportedRepoOverrideReason("command sudo git commit -m x")).toBe(
      "string",
    );
    expect(typeof __testing.unsupportedRepoOverrideReason("env command sudo git commit -m x")).toBe(
      "string",
    );
    expect(typeof __testing.unsupportedRepoOverrideReason("/usr/bin/sudo git commit -m x")).toBe(
      "string",
    );
    expect(typeof __testing.unsupportedRepoOverrideReason("env -- sudo git commit -m x")).toBe(
      "string",
    );
    expect(
      typeof __testing.unsupportedRepoOverrideReason("/usr/bin/env -C ../repo git commit -m x"),
    ).toBe("string");
    expect(typeof __testing.unsupportedRepoOverrideReason("env -C ../repo git commit -m x")).toBe(
      "string",
    );
    expect(
      typeof __testing.unsupportedRepoOverrideReason("command env -C ../repo git commit -m x"),
    ).toBe("string");
    expect(
      typeof __testing.unsupportedRepoOverrideReason("exec env --chdir ../repo git commit -m x"),
    ).toBe("string");
    expect(
      typeof __testing.unsupportedRepoOverrideReason("env --chdir=/repo git commit -m x"),
    ).toBe("string");
    expect(typeof __testing.unsupportedRepoOverrideReason('env -S "git commit -m x"')).toBe(
      "string",
    );
    expect(
      typeof __testing.unsupportedRepoOverrideReason(String.raw`env -S git\ commit\ -m\ x`),
    ).toBe("string");
    expect(
      typeof __testing.unsupportedRepoOverrideReason(
        '/usr/bin/env --split-string "git commit -m x"',
      ),
    ).toBe("string");
  });

  test("rejects wrapped or ambiguous workdir-changing commit commands", () => {
    expect(typeof __testing.unsupportedRepoOverrideReason('bash -lc "git commit -m x"')).toBe(
      "string",
    );
    expect(
      typeof __testing.unsupportedRepoOverrideReason(
        String.raw`C:\Windows\System32\bash -lc "git commit -m x"`,
      ),
    ).toBe("string");
    expect(typeof __testing.unsupportedRepoOverrideReason("sudo git commit -m x")).toBe("string");
    expect(typeof __testing.unsupportedRepoOverrideReason("noglob git commit -m x")).toBe("string");
    expect(
      typeof __testing.unsupportedRepoOverrideReason(
        "git commit --dry-run && sudo git commit -m x",
      ),
    ).toBe("string");
    expect(
      typeof __testing.unsupportedRepoOverrideReason("bash -o pipefail -c 'git commit -m x'"),
    ).toBe("string");
    expect(
      typeof __testing.unsupportedRepoOverrideReason(
        "git commit -m first; cd ../other && git commit -m second",
      ),
    ).toBe("string");
    expect(
      typeof __testing.unsupportedRepoOverrideReason("false && cd ../other; git commit -m x"),
    ).toBe("string");
    expect(
      typeof __testing.unsupportedRepoOverrideReason(
        "if false; then cd ../other; fi; git commit -m x",
      ),
    ).toBe("string");
    expect(typeof __testing.unsupportedRepoOverrideReason("(cd ../other); git commit -m x")).toBe(
      "string",
    );
    expect(
      typeof __testing.unsupportedRepoOverrideReason("cd ../other extra; git commit -m x"),
    ).toBe("string");
    expect(
      typeof __testing.unsupportedRepoOverrideReason("cd ../other | cat; git commit -m x"),
    ).toBe("string");
    expect(__testing.unsupportedRepoOverrideReason("cd ../other && git commit -m x")).toBe(
      undefined,
    );
  });
});

describe("commit workdir parsing", () => {
  test("resolves git -C relative to the invocation directory", () => {
    expect(__testing.commitWorkdir("git -C subdir commit -m x", "/repo/root")).toBe(
      "/repo/root/subdir",
    );
  });

  test("resolves simple preceding cd commands", () => {
    expect(__testing.commitWorkdir("cd ../other && git commit -m x", "/repo/root/app")).toBe(
      "/repo/root/other",
    );
    expect(__testing.commitWorkdir("cd tools\ngit commit -m x", "/repo/root")).toBe(
      "/repo/root/tools",
    );
  });

  test("ignores cd segments that run in a subshell or background", () => {
    expect(__testing.commitWorkdir("cd ../other | cat; git commit -m x", "/repo/root/app")).toBe(
      "/repo/root/app",
    );
    expect(__testing.commitWorkdir("cd ../other & git commit -m x", "/repo/root/app")).toBe(
      "/repo/root/app",
    );
    expect(__testing.commitWorkdir("false && cd ../other; git commit -m x", "/repo/root/app")).toBe(
      "/repo/root/app",
    );
    expect(__testing.commitWorkdir("(cd ../other); git commit -m x", "/repo/root/app")).toBe(
      "/repo/root/app",
    );
  });

  test("resolves grouped and control-block cd commands", () => {
    expect(__testing.commitWorkdir("(cd ../other && git commit -m x)", "/repo/root/app")).toBe(
      "/repo/root/other",
    );
  });
});

describe("diff fingerprinting", () => {
  test("changes when untracked file mode changes", () => {
    const nul = "\u0000";
    const base = __testing.createSnapshotFingerprint("?? script.sh\n", "", "", [
      `script.sh${nul}100644${nul}abc123`,
    ]);
    const executable = __testing.createSnapshotFingerprint("?? script.sh\n", "", "", [
      `script.sh${nul}100755${nul}abc123`,
    ]);

    expect(executable).not.toBe(base);
  });

  test("changes when untracked symlink target changes", () => {
    const nul = "\u0000";
    const firstTarget = __testing.createSnapshotFingerprint("?? link\n", "", "", [
      `link${nul}120000${nul}target-a`,
    ]);
    const secondTarget = __testing.createSnapshotFingerprint("?? link\n", "", "", [
      `link${nul}120000${nul}target-b`,
    ]);

    expect(secondTarget).not.toBe(firstTarget);
  });

  test("changes when tracked status changes", () => {
    const clean = __testing.createSnapshotFingerprint("", "", "", []);
    const modified = __testing.createSnapshotFingerprint(" M src/review-gate.ts\n", "", "", []);

    expect(modified).not.toBe(clean);
  });
});

describe("status item best-effort handling", () => {
  const snapshot = {
    diffExcerpt: "",
    diffStat: " M file.ts",
    fingerprint: "fingerprint-a",
    hasChanges: true,
    repoKey: "repo-a",
    repoRoot: "/repo/a",
    status: " M file.ts\n",
  };

  test("does not throw when creating the optional status item fails", () => {
    const logs = [];
    const status = __testing.createQualityLoopStatus({
      experimental: {
        createStatusItem() {
          throw new Error("status unavailable");
        },
      },
      logger: { log: (...args) => logs.push(args) },
    });

    expect(() => status.required(snapshot)).not.toThrow();
    expect(status.current()).toMatchObject({ fingerprint: "fingerprint-a", kind: "required" });
    expect(logs.some(([message]) => message === "review gate status item update failed")).toBe(
      true,
    );
  });

  test("does not throw when updating or clearing the optional status item fails", () => {
    const logs = [];
    const status = __testing.createQualityLoopStatus({
      experimental: {
        createStatusItem() {
          return {
            unsubscribe() {
              throw new Error("unsubscribe failed");
            },
            update() {
              throw new Error("update failed");
            },
          };
        },
      },
      logger: { log: (...args) => logs.push(args) },
    });

    status.required(snapshot);
    expect(() => status.active(snapshot)).not.toThrow();
    status.required(snapshot);
    expect(() => status.clear()).not.toThrow();
    expect(logs.map(([message]) => message)).toContain("review gate status item update failed");
    expect(logs.map(([message]) => message)).toContain("review gate status item clear failed");
  });

  test("renders active status for the same repo after the fingerprint changes", () => {
    const status = __testing.renderStatus(snapshot, undefined, {
      fingerprint: "old-fingerprint",
      kind: "active",
      repoRoot: "/repo/a",
      since: 0,
    });

    expect(status).toContain("Review gate: active for current diff.");
    expect(status).toContain("Fingerprint: fingerprint-a");
  });
});

describe("quality loop tool behavior", () => {
  test("enforces review, Codex, final audit, then pass through registered tools", async () => {
    const { configuration, ctx, tools } = createPluginHarness();

    expect(tools.quality_loop_grader).toBeUndefined();
    expect(
      await executeTool(tools, ctx, "quality_loop_start", {
        blocked_command: "git commit -m test",
      }),
    ).toContain("First required action: call quality_loop_review");
    expect(await executeTool(tools, ctx, "quality_loop_codex_review")).toContain(
      "call quality_loop_review first",
    );
    expect(await executeTool(tools, ctx, "quality_loop_review")).toContain(
      "remaining stage tools before quality_loop_passed: quality_loop_codex_review, quality_loop_final_audit",
    );
    expect(await executeTool(tools, ctx, "quality_loop_final_audit")).toContain(
      "call quality_loop_codex_review first",
    );
    expect(await executeTool(tools, ctx, "quality_loop_codex_review")).toContain(
      "otherwise call quality_loop_final_audit",
    );
    expect(
      await executeTool(tools, ctx, "quality_loop_passed", {
        summary: "pending",
      }),
    ).toContain("call quality_loop_final_audit");
    expect(await executeTool(tools, ctx, "quality_loop_final_audit")).toContain(
      "all explicit stage tools recorded",
    );
    expect(
      await executeTool(tools, ctx, "quality_loop_passed", {
        summary: "all required stages complete",
      }),
    ).toContain("quality_loop_passed recorded");

    expect(Object.values(configuration.value.qualityLoopPlugin.passes)).toHaveLength(1);
  });

  test("counts same-fingerprint review and Codex cycles toward the cap", async () => {
    const { ctx, tools } = createPluginHarness();

    await executeTool(tools, ctx, "quality_loop_start", {
      blocked_command: "git commit -m test",
    });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      expect(await executeTool(tools, ctx, "quality_loop_review")).toContain(
        "quality_loop_review recorded",
      );
      expect(await executeTool(tools, ctx, "quality_loop_codex_review")).toContain(
        "quality_loop_codex_review recorded",
      );
    }

    expect(await executeTool(tools, ctx, "quality_loop_review")).toContain(
      "maximum 3 review+Codex cycles already reached",
    );
  });

  test("requires final audit after a later review and Codex cycle", async () => {
    const { ctx, tools } = createPluginHarness();

    await executeTool(tools, ctx, "quality_loop_start", {
      blocked_command: "git commit -m test",
    });
    await executeTool(tools, ctx, "quality_loop_review");
    await executeTool(tools, ctx, "quality_loop_codex_review");
    await executeTool(tools, ctx, "quality_loop_final_audit");
    await executeTool(tools, ctx, "quality_loop_review");
    await executeTool(tools, ctx, "quality_loop_codex_review");

    expect(
      await executeTool(tools, ctx, "quality_loop_passed", {
        summary: "pending",
      }),
    ).toContain("quality_loop_final_audit");
  });
});

describe("pass recording invariants", () => {
  const snapshot = {
    diffExcerpt: "",
    diffStat: " M file.ts",
    fingerprint: "fingerprint-a",
    hasChanges: true,
    repoKey: "repo-a",
    repoRoot: "/repo/a",
    status: " M file.ts\n",
  };

  test("keeps an active same-repo loop when review fixes change the fingerprint", () => {
    expect(__testing.activeLoopMatches(undefined, snapshot)).toBe(false);
    expect(__testing.activeLoopMatches(activeLoop(), snapshot)).toBe(true);
    expect(
      __testing.activeLoopMatches(activeLoop({ finalAuditFingerprint: "fingerprint-b" }), snapshot),
    ).toBe(true);
    expect(__testing.activeLoopMatches(activeLoop({ repoKey: "repo-b" }), snapshot)).toBe(false);
  });

  test("requires a review checkpoint before later Codex cycles", () => {
    expect(
      __testing.missingCurrentCyclePrerequisiteStages(
        activeLoop({
          completedStages: ["review"],
          reviewReadyForCodex: true,
        }),
        "codex",
        snapshot,
      ),
    ).toEqual([]);
    expect(
      __testing.missingCurrentCyclePrerequisiteStages(
        activeLoop({
          codexFingerprints: ["fingerprint-a"],
          completedStages: ["review", "codex"],
          cycles: 1,
        }),
        "codex",
        snapshot,
      ),
    ).toEqual(["review"]);
    expect(
      __testing.missingCurrentCyclePrerequisiteStages(
        activeLoop({
          codexFingerprints: ["fingerprint-b"],
          completedStages: ["review", "codex"],
          cycles: 1,
          reviewReadyForCodex: true,
        }),
        "codex",
        snapshot,
      ),
    ).toEqual([]);
  });

  test("allows final audit after Codex fixes change the fingerprint", () => {
    expect(
      __testing.missingCurrentCyclePrerequisiteStages(
        activeLoop({
          codexFingerprints: ["fingerprint-b"],
          completedStages: ["review", "codex"],
          cycles: 1,
        }),
        "final_audit",
        snapshot,
      ),
    ).toEqual([]);
  });

  test("requires Codex before final audit after restarting a review cycle", () => {
    expect(
      __testing.missingCurrentCyclePrerequisiteStages(
        activeLoop({
          codexFingerprints: ["fingerprint-a"],
          completedStages: ["review", "codex", "final_audit"],
          cycles: 1,
          finalAuditFingerprint: "fingerprint-a",
          reviewReadyForCodex: true,
        }),
        "final_audit",
        snapshot,
      ),
    ).toEqual(["codex"]);
  });

  test("clears review readiness after every Codex checkpoint", () => {
    const loop = activeLoop({
      codexFingerprints: ["fingerprint-a"],
      completedStages: ["review", "codex"],
      cycles: 1,
      reviewReadyForCodex: true,
    });

    __testing.recordQualityLoopStageTransition(loop, "codex", snapshot);

    expect(loop.reviewReadyForCodex).toBe(false);
    expect(loop.cycles).toBe(2);
  });

  test("carries cycle count across same-repo diff restarts only", () => {
    expect(
      __testing.carriedCycleCount(
        activeLoop({
          codexFingerprints: ["old"],
          completedStages: ["review", "codex"],
          cycles: 3,
        }),
        snapshot,
      ),
    ).toBe(3);
    expect(
      __testing.carriedCycleCount(
        activeLoop({
          codexFingerprints: ["old"],
          completedStages: ["review", "codex"],
          cycles: 3,
          repoKey: "repo-b",
        }),
        snapshot,
      ),
    ).toBe(0);
    expect(__testing.carriedCycleCount(undefined, snapshot)).toBe(0);
  });

  test("requires explicit stage tools before pass", () => {
    expect(__testing.missingRequiredStages(undefined)).toEqual(["review", "codex", "final_audit"]);
    expect(
      __testing.missingRequiredStages(
        activeLoop({
          codexFingerprints: ["fingerprint-a"],
          completedStages: ["review", "codex"],
          cycles: 1,
        }),
      ),
    ).toEqual(["final_audit"]);
    expect(
      __testing.missingRequiredStages(
        activeLoop({
          codexFingerprints: ["fingerprint-a"],
          completedStages: ["review", "codex", "final_audit"],
          cycles: 1,
          finalAuditFingerprint: "fingerprint-a",
        }),
      ),
    ).toEqual([]);
  });

  test("requires final audit to cover the current fingerprint before pass", () => {
    expect(
      __testing.finalAuditCoversCurrentDiff(
        activeLoop({
          codexFingerprints: ["fingerprint-a"],
          completedStages: ["review", "codex", "final_audit"],
          cycles: 1,
          finalAuditFingerprint: "fingerprint-a",
        }),
        snapshot,
      ),
    ).toBe(true);
    expect(
      __testing.finalAuditCoversCurrentDiff(
        activeLoop({
          codexFingerprints: ["fingerprint-a"],
          completedStages: ["review", "codex", "final_audit"],
          cycles: 1,
          finalAuditFingerprint: "fingerprint-b",
        }),
        snapshot,
      ),
    ).toBe(false);
  });

  test("requires final audit coverage for the current fingerprint before pass", () => {
    expect(
      __testing.missingCurrentDiffCoverageStages(
        activeLoop({
          codexFingerprints: ["fingerprint-a"],
          completedStages: ["review", "codex", "final_audit"],
          cycles: 1,
          finalAuditFingerprint: "fingerprint-a",
        }),
        snapshot,
      ),
    ).toEqual([]);
    expect(
      __testing.missingCurrentDiffCoverageStages(
        activeLoop({
          codexFingerprints: ["fingerprint-b"],
          completedStages: ["review", "codex", "final_audit"],
          cycles: 1,
          finalAuditFingerprint: "fingerprint-a",
        }),
        snapshot,
      ),
    ).toEqual([]);
    expect(
      __testing.missingCurrentDiffCoverageStages(
        activeLoop({
          codexFingerprints: ["fingerprint-a"],
          completedStages: ["review", "codex", "final_audit"],
          cycles: 1,
          finalAuditFingerprint: "fingerprint-b",
        }),
        snapshot,
      ),
    ).toEqual(["final_audit"]);
  });
});
