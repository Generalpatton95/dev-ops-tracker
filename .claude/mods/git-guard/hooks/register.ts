import type { EngineInterface, Register } from "claude-code";
import { changedPaths, findDestructiveGit, type Dialect } from "./detect.ts";
import { isInside, resolvePath } from "./paths.ts";

// Guard for dev-ops-tracker (2026-10-15): `git reset --hard` once wiped the owner's
// uncommitted spec edit. Blocks working-tree-discarding git commands while anything
// is uncommitted. Runs only local `git status` / `git rev-parse`, and only inside the
// session's own project; sends nothing anywhere.

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);

// Catches `git` even when split by quotes or escapes (`"g"it`, `g\it`), and PowerShell,
// which can hide it entirely (-EncodedCommand).
const MAY_RUN_GIT = /g\W{0,3}i\W{0,3}t|pwsh|powershell/i;
// GIT_DIR and friends set anywhere on the line (`export`, `$env:`) change which repo git touches.
// Covers `GIT_DIR=`, `export GIT_DIR=`, `$env:GIT_DIR`, `${env:GIT_DIR}` and `Set-Item env:GIT_DIR`.
const SETS_GIT_ENV = /\bGIT_[A-Z_]+\s*=|env:GIT_/i;

async function guard($: EngineInterface, command: string, dialect: Dialect): Promise<{ deny: string } | undefined> {
  if (!MAY_RUN_GIT.test(command)) return undefined;
  const found = findDestructiveGit(command, dialect);
  if (!found) return undefined;

  const name = $.plugin.name;
  const shown = cap(found.command, 200);
  const refuse = (why: string) => ({
    deny: `${name}: blocked "${shown}": ${why}, so it can't safely check for uncommitted changes. Run it from this project without that, or ask the user.`,
  });

  if (found.cannotCheck) return refuse(found.cannotCheck);
  if (SETS_GIT_ENV.test(command)) return refuse("it sets GIT_* environment variables");
  if (found.gitOptions.some((o) => o.startsWith("--git-dir") || o.startsWith("--work-tree"))) {
    return refuse("it points git at another repository");
  }

  // Work out the folder git will run in, and check only inside this project:
  // running git in someone else's repo would load that repo's config (filters, fsmonitor).
  let target = resolvePath(await $.session.cwd(), found.cwd ?? ".");
  for (let i = 0; i < found.gitOptions.length; i += 2) {
    if (found.gitOptions[i] === "-C") target = target && resolvePath(target, found.gitOptions[i + 1] ?? "");
  }
  if (!target) return refuse("it uses a path the guard can't resolve");
  if (!isInside(target, resolvePath(await $.session.root(), ".") ?? "")) {
    return refuse("it targets a folder outside this project");
  }

  const git = (...args: string[]) =>
    $.process.run(["git", "-c", "core.fsmonitor=false", ...args], { timeoutMs: 10_000, cwd: target });

  const status = await git("status", "--porcelain", ...(found.includesIgnored ? ["--ignored"] : []));
  if (status.exitCode !== 0) return refuse("git status failed there");

  const paths = changedPaths(status.stdout);
  if (paths.length === 0) return undefined;

  if (found.branchCheck !== undefined) {
    // `checkout <branch>` is a switch, and git refuses to overwrite local changes.
    const ref = await git("rev-parse", "--verify", "-q", "--end-of-options", `${found.branchCheck}^{commit}`);
    if (ref.exitCode === 0) return undefined;
  }

  const sample = paths.slice(0, 3).map((p) => cap(p, 120)).join(", ") + (paths.length > 3 ? ", ..." : "");
  return {
    deny:
      `${name}: blocked "${shown}" because the working tree has ${paths.length} uncommitted ` +
      `change(s) (${sample}) that it would discard. Check whose they are with git status. ` +
      `To drop only your own commit, use "git reset --soft HEAD~1" or "git revert"; ` +
      `if the changes aren't yours, ask the user.`,
  };
}

const FAILED = "could not check git status, so it blocked this command.";

export const register: Register = (on) => {
  // Each guard fails closed: if the check itself breaks, refuse rather than risk the tree.
  on("tool.call", { tool: "Bash" }, async ($, e, next) => (await guard($, e.command, "bash")) ?? next(e)).catch(
    ($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: ${FAILED}` }),
  );
  on("tool.call", { tool: "PowerShell" }, async ($, e, next) => (await guard($, e.command, "powershell")) ?? next(e)).catch(
    ($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: ${FAILED}` }),
  );
};
