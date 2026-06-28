import { describe, expect, test } from "bun:test";
import { __testing } from "./quality-loop.ts";

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
    const modified = __testing.createSnapshotFingerprint(" M src/quality-loop.ts\n", "", "", []);

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
    expect(logs.some(([message]) => message === "quality loop status item update failed")).toBe(
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
    expect(logs.map(([message]) => message)).toContain("quality loop status item update failed");
    expect(logs.map(([message]) => message)).toContain("quality loop status item clear failed");
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

  test("requires an active same-repo same-fingerprint loop", () => {
    expect(__testing.activeLoopMatches(undefined, snapshot)).toBe(false);
    expect(
      __testing.activeLoopMatches(
        { completedStages: [], cycles: 0, fingerprint: "fingerprint-a", repoKey: "repo-a" },
        snapshot,
      ),
    ).toBe(true);
    expect(
      __testing.activeLoopMatches(
        { completedStages: [], cycles: 0, fingerprint: "fingerprint-b", repoKey: "repo-a" },
        snapshot,
      ),
    ).toBe(false);
    expect(
      __testing.activeLoopMatches(
        { completedStages: [], cycles: 0, fingerprint: "fingerprint-a", repoKey: "repo-b" },
        snapshot,
      ),
    ).toBe(false);
  });

  test("carries cycle count across same-repo diff restarts only", () => {
    expect(
      __testing.carriedCycleCount(
        { completedStages: ["review", "codex"], cycles: 3, fingerprint: "old", repoKey: "repo-a" },
        snapshot,
      ),
    ).toBe(3);
    expect(
      __testing.carriedCycleCount(
        { completedStages: ["review", "codex"], cycles: 3, fingerprint: "old", repoKey: "repo-b" },
        snapshot,
      ),
    ).toBe(0);
    expect(__testing.carriedCycleCount(undefined, snapshot)).toBe(0);
  });

  test("counts only review and Codex as capped loop stages", () => {
    expect(__testing.isReviewCycleStage("review")).toBe(true);
    expect(__testing.isReviewCycleStage("codex")).toBe(true);
    expect(__testing.isReviewCycleStage("grade")).toBe(false);
    expect(__testing.isReviewCycleStage("final_audit")).toBe(false);
  });

  test("requires explicit stage tools before pass", () => {
    expect(__testing.missingRequiredStages(undefined)).toEqual([
      "review",
      "codex",
      "grade",
      "final_audit",
    ]);
    expect(
      __testing.missingRequiredStages({
        completedStages: ["review", "codex"],
        cycles: 1,
        fingerprint: "fingerprint-a",
        repoKey: "repo-a",
      }),
    ).toEqual(["grade", "final_audit"]);
    expect(
      __testing.missingRequiredStages({
        completedStages: ["review", "codex", "grade", "final_audit"],
        cycles: 1,
        fingerprint: "fingerprint-a",
        repoKey: "repo-a",
      }),
    ).toEqual([]);
  });
});
