import type { On } from "claude-code";
import { describe, expect, test } from "claude-code/testing";
import { findDestructiveGit } from "./detect.ts";
import { isInside, resolvePath } from "./paths.ts";

describe("findDestructiveGit: blocked forms", () => {
  const blocked: [string, ("bash" | "powershell")?][] = [
    ["git reset --hard"],
    ["git reset -q --hard HEAD~1 && git push --force-with-lease"],
    ["git checkout -- specs/product.md"],
    ["git checkout ."],
    ["git checkout -f main"],
    ["git checkout HEAD src/x.ts"],
    ["git restore specs/product.md"],
    ["git restore --staged --worktree x"],
    ["git clean -fd"],
    ["git clean -d --force"],
    ["git stash"],
    ["git stash push -u"],
    ["git switch --discard-changes main"],
    ["git rm -f notes.md"],
    ["git checkout-index -a -f"],
    ["git -c core.quotepath=false reset --hard"],
    ["git --work-tree ../o reset --hard"],
    ['bash -c "git reset --hard"'],
    ["sh -lc 'git checkout -- .'"],
    ["(git reset --hard)"],
    ["echo $(git reset --hard)"],
    ["echo `git stash`"],
    ["eval git reset --hard"],
    ["sudo -u me git clean -xdf"],
    ['pwsh -Command "git reset --hard"'],
    ["git reset --hard; Remove-Item x", "powershell"],
    ["& git stash", "powershell"],
    ["git checkout -qf main"],
    ["git checkout -fB main"],
    ["git switch -qf main"],
    ["git reset --har"],
    ["git checkout --forc main"],
    ["git switch --discard main"],
    ["git checkout HEAD~1 -- x"],
    ["git checkout HEAD~1 x"],
    ["timeout 60 git reset --hard"],
    ["winpty git stash"],
    ["Start-Process git -ArgumentList 'reset --hard'", "powershell"],
    ["powershell git reset --hard"],
    ['pwsh -comm "git stash"'],
    ["g\\it reset --hard"],
    ["gi''t reset --hard"],
    ['"g"it reset --hard'],
    ["git stash push -m -h"],
    ["git clean --forc -dx"],
    ["git clean --fo -d"],
    ["git rm --forc x"],
    ["git checkout-index --forc -a"],
    ["git restore --staged --work ."],
    ["git merge --abort"],
    ["git am --abort"],
    ["git cherry-pick --abort"],
    ["git revert --abort"],
    ["git rebase --abort"],
    ["git worktree remove --force ../copy"],
    ["git worktree remove -f ../copy"],
  ];
  for (const [cmd, dialect] of blocked) {
    test(`blocks: ${cmd}`, () => {
      expect(findDestructiveGit(cmd, dialect)).toBeDefined();
    });
  }
});

describe("findDestructiveGit: allowed forms", () => {
  const allowed = [
    "git status --short",
    "git reset --soft HEAD~1",
    "git reset HEAD file",
    "git checkout -b t-5-schema",
    "git checkout -",
    "git switch -c t-5-schema",
    "git restore --staged specs/m1-skeleton.md",
    "git restore --help",
    "git clean -n",
    "git clean -fdn",
    "git stash list",
    "git merge --no-ff feature",
    "git rebase --continue",
    "git worktree remove ../copy",
    "git worktree add ../copy main",
    "git worktree list",
    "git rm --cached -f x",
    "git log --oneline",
    "echo reset --hard",
    "echo 'git reset --hard'",
    'gh pr create --title t --body "Blocks git reset --hard and git stash while dirty"',
    "git commit -q -F - <<'EOF'\nGuard blocks git stash and git reset --hard when dirty\nEOF\ngit log --oneline -1",
    "git commit -m \"$(cat <<'EOF'\nmentions git checkout -- x\nEOF\n)\"",
    "pnpm test",
  ];
  for (const cmd of allowed) {
    test(`allows: ${JSON.stringify(cmd).slice(0, 80)}`, () => {
      expect(findDestructiveGit(cmd)).toBeUndefined();
    });
  }
});

describe("what it reports", () => {
  test("a single checkout argument is checked as a branch", () => {
    expect(findDestructiveGit("git checkout main")?.branchCheck).toBe("main");
  });
  test("follows cd into the target directory", () => {
    expect(findDestructiveGit("cd ../copy && git checkout -- .")?.cwd).toBe("../copy");
  });
  test("resolves -C relative to a preceding cd", () => {
    const found = findDestructiveGit("cd repo && git -C ../other reset --hard");
    expect(found?.cwd).toBe("repo");
    expect(found?.gitOptions).toEqual(["-C", "../other"]);
  });
  test("forwards --git-dir and --work-tree", () => {
    expect(findDestructiveGit("git --git-dir=x/.git --work-tree x reset --hard")?.gitOptions).toEqual([
      "--git-dir=x/.git",
      "--work-tree=x",
    ]);
  });
  test("flags clean -x as touching ignored files", () => {
    expect(findDestructiveGit("git -C sub clean -xdf")?.includesIgnored).toBe(true);
  });
  test("can't check when GIT_* variables are set", () => {
    expect(findDestructiveGit("GIT_WORK_TREE=../o git reset --hard")?.cannotCheck).toBeDefined();
  });
  test("can't check a command-line alias", () => {
    expect(findDestructiveGit("git -c alias.n='reset --hard' n")?.cannotCheck).toBeDefined();
  });
  test("can't check --config-env aliases or config overrides", () => {
    expect(findDestructiveGit("X='reset --hard' git --config-env=alias.nuke=X nuke")?.cannotCheck).toBe("it defines a git alias");
    expect(findDestructiveGit("git -c clean.requireForce=false clean -dx")?.cannotCheck).toBe("it overrides git config");
  });
  test("can't follow env -C or Start-Process -WorkingDirectory", () => {
    expect(findDestructiveGit("env -C ../o git reset --hard")?.cannotCheck).toBeDefined();
    expect(
      findDestructiveGit("Start-Process git -WorkingDirectory C:/o -ArgumentList 'reset --hard'", "powershell")?.cannotCheck,
    ).toBeDefined();
  });
  test("keeps backticks in a cd target so it reads as unresolvable", () => {
    expect(findDestructiveGit("cd `echo /c/other`; git reset --hard")?.cwd).toContain("`");
  });
  test("can't check a forced worktree removal", () => {
    expect(findDestructiveGit("git worktree remove --force ../copy")?.cannotCheck).toBeDefined();
  });
  test("can't check past the nesting limit", () => {
    let cmd = "git reset --hard";
    for (let i = 0; i < 6; i++) cmd = `echo $(${cmd})`;
    expect(findDestructiveGit(cmd)?.cannotCheck).toBe("it is nested too deeply to read");
  });
  test("decodes pwsh -EncodedCommand", () => {
    const utf16 = Array.from("git reset --hard", (ch) => String.fromCharCode(ch.charCodeAt(0), 0)).join("");
    expect(findDestructiveGit(`pwsh -EncodedCommand ${btoa(utf16)}`)).toBeDefined();
  });
});

describe("paths", () => {
  test("resolves relative paths and ..", () => {
    expect(resolvePath(String.raw`C:\dev\proj`, "src/../app")).toBe("C:/dev/proj/app");
  });
  test("maps Git Bash drive paths", () => {
    expect(resolvePath("C:/x", "/c/dev/proj")).toBe("C:/dev/proj");
  });
  test("refuses paths the shell would expand", () => {
    expect(resolvePath("C:/x", "$HOME/repo")).toBeUndefined();
    expect(resolvePath("C:/x", "~/repo")).toBeUndefined();
  });
  test("checks containment case-insensitively on Windows", () => {
    expect(isInside("c:/dev/proj/app", "C:/dev/proj")).toBe(true);
    expect(isInside("C:/dev/project2", "C:/dev/proj")).toBe(false);
    expect(isInside("/home/a/proj/x", "/home/a/proj")).toBe(true);
  });
});

// End to end through the engine: the plugin's tool.call hook sits above the test's own.
type FakeGit = { status?: string; statusExit?: number; refs?: string[] };

// The engine answers these in a session; the test kit needs them answered beneath the plugin.
function fakeSession(on: On) {
  on("session.cwd", () => ({ value: "C:/proj" }));
  on("session.root", () => ({ value: "C:/proj" }));
}

function fakeGit(on: On, { status = "", statusExit = 0, refs = [] }: FakeGit) {
  fakeSession(on);
  const calls: { argv: string[]; cwd?: string }[] = [];
  on("process.run", (_$, e) => {
    calls.push({ argv: [...e.argv], cwd: e.init?.cwd });
    const isRevParse = e.argv.includes("rev-parse");
    const ref = String(e.argv[e.argv.length - 1]).replace(/\^\{commit\}$/, "");
    const exitCode = isRevParse ? (refs.includes(ref) ? 0 : 1) : statusExit;
    return {
      value: { exitCode, stdout: isRevParse ? "" : status, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
    };
  });
  return calls;
}

// Stands in for the real shell: counts calls that got past the guard.
function fakeShell(on: On) {
  let ran = 0;
  const answer = () => {
    ran++;
    return { result: { stdout: "ok", stderr: "", interrupted: false } } as never;
  };
  on("tool.call", { tool: "Bash" }, answer);
  on("tool.call", { tool: "PowerShell" }, answer);
  return () => ran;
}

test("denies reset --hard when the tree has uncommitted changes", async ($, on) => {
  fakeGit(on, { status: " M specs/product.md\n" });
  const ran = fakeShell(on);
  const res = await $.tool.call({ tool: "Bash", command: "git reset -q --hard HEAD~1" });
  expect(res.deny ?? res.text ?? "").toContain("specs/product.md");
  expect(ran()).toBe(0);
});

test("runs git status with fsmonitor off", async ($, on) => {
  const calls = fakeGit(on, { status: " M x\n" });
  fakeShell(on);
  await $.tool.call({ tool: "Bash", command: "git stash" });
  expect(calls[0]?.argv).toEqual(["git", "-c", "core.fsmonitor=false", "status", "--porcelain"]);
});

test("denies on the PowerShell tool too", async ($, on) => {
  fakeGit(on, { status: "?? notes.md\n" });
  const ran = fakeShell(on);
  await $.tool.call({ tool: "PowerShell", command: "git stash" });
  expect(ran()).toBe(0);
});

test("allows reset --hard on a clean tree", async ($, on) => {
  fakeGit(on, { status: "" });
  const ran = fakeShell(on);
  await $.tool.call({ tool: "Bash", command: "git reset --hard HEAD~1" });
  expect(ran()).toBe(1);
});

test("allows safe git commands without checking status", async ($, on) => {
  const calls = fakeGit(on, { status: " M x\n" });
  const ran = fakeShell(on);
  await $.tool.call({ tool: "Bash", command: "git reset --soft HEAD~1" });
  expect(ran()).toBe(1);
  expect(calls.length).toBe(0);
});

test("allows checkout of a branch on a dirty tree", async ($, on) => {
  fakeGit(on, { status: " M x\n", refs: ["main"] });
  const ran = fakeShell(on);
  await $.tool.call({ tool: "Bash", command: "git checkout main" });
  expect(ran()).toBe(1);
});

test("denies checkout of a file on a dirty tree", async ($, on) => {
  fakeGit(on, { status: " M specs/product.md\n", refs: ["main"] });
  const ran = fakeShell(on);
  await $.tool.call({ tool: "Bash", command: "git checkout specs/product.md" });
  expect(ran()).toBe(0);
});

test("denies when git status fails (fails closed)", async ($, on) => {
  fakeGit(on, { statusExit: 128 });
  const ran = fakeShell(on);
  await $.tool.call({ tool: "Bash", command: "git reset --hard" });
  expect(ran()).toBe(0);
});

test("denies unresolvable paths without running git", async ($, on) => {
  const calls = fakeGit(on, { status: "" });
  const ran = fakeShell(on);
  await $.tool.call({ tool: "Bash", command: 'git -C "$HOME/repo" reset --hard' });
  expect(ran()).toBe(0);
  expect(calls.length).toBe(0);
});

test("denies targets outside the project without running git", async ($, on) => {
  const calls = fakeGit(on, { status: "" });
  const ran = fakeShell(on);
  await $.tool.call({ tool: "Bash", command: "cd ../../../elsewhere && git reset --hard" });
  await $.tool.call({ tool: "Bash", command: "git --git-dir=evil/.git --work-tree=evil reset --hard" });
  expect(ran()).toBe(0);
  expect(calls.length).toBe(0);
});

test("denies when GIT_* is set anywhere on the line", async ($, on) => {
  const calls = fakeGit(on, { status: "" });
  const ran = fakeShell(on);
  await $.tool.call({ tool: "Bash", command: "export GIT_DIR=../o/.git; git reset --hard" });
  await $.tool.call({ tool: "PowerShell", command: "Set-Item env:GIT_DIR ../o/.git; git reset --hard" });
  await $.tool.call({ tool: "PowerShell", command: "${env:GIT_DIR}='../o/.git'; git reset --hard" });
  expect(ran()).toBe(0);
  expect(calls.length).toBe(0);
});

test("checks status in the cd target, with ignored files for clean -x", async ($, on) => {
  const calls = fakeGit(on, { status: "!! .env\n" });
  const ran = fakeShell(on);
  await $.tool.call({ tool: "Bash", command: "cd app && git clean -xdf" });
  expect(ran()).toBe(0);
  expect(calls[0]?.cwd ?? "").toMatch(/[/]app$/);
  expect(calls[0]?.argv).toContain("--ignored");
});

test("denies GIT_* prefixed commands without running git", async ($, on) => {
  const calls = fakeGit(on, { status: "" });
  const ran = fakeShell(on);
  await $.tool.call({ tool: "Bash", command: "GIT_DIR=../o/.git git reset --hard" });
  expect(ran()).toBe(0);
  expect(calls.length).toBe(0);
});

test("fails closed when git status cannot run", async ($, on) => {
  fakeSession(on);
  on("process.run", () => {
    throw new Error("spawn failed");
  });
  const ran = fakeShell(on);
  await $.tool.call({ tool: "Bash", command: "git reset --hard" });
  expect(ran()).toBe(0);
});

test("denies an encoded PowerShell git command (no 'git' in the text)", async ($, on) => {
  fakeGit(on, { status: " M x\n" });
  const ran = fakeShell(on);
  const utf16 = Array.from("git stash", (ch) => String.fromCharCode(ch.charCodeAt(0), 0)).join("");
  await $.tool.call({ tool: "Bash", command: `powershell -enc ${btoa(utf16)}` });
  expect(ran()).toBe(0);
});

test("never runs git for commands that don't mention it", async ($, on) => {
  const calls = fakeGit(on, { status: " M x\n" });
  const ran = fakeShell(on);
  await $.tool.call({ tool: "Bash", command: "pnpm run test" });
  expect(ran()).toBe(1);
  expect(calls.length).toBe(0);
});
