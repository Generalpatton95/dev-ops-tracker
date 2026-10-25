// Finds git commands in a shell command line that would throw away working-tree changes.
// A small shell-aware scanner: quotes, separators, heredocs, $( ) and backticks,
// `bash -c`, `pwsh -Command`, `eval`, and a preceding `cd`. Pure text work with no I/O,
// so it is tested directly. It is a backstop, not a full shell parser.

export type Dialect = "bash" | "powershell";

export type Destructive = {
  /** The git command as written, for the deny reason. */
  command: string;
  /** Directory a preceding cd / Set-Location moved to, if any. */
  cwd?: string;
  /** `-C`, `--git-dir`, `--work-tree` options to repeat on the status check. */
  gitOptions: string[];
  /** True when ignored files are at risk too (`clean -x` / `-X`). */
  includesIgnored: boolean;
  /** `checkout <x>`: safe only if `x` names a commit (a branch switch). */
  branchCheck?: string;
  /** Set when the guard can't tell which repo the command touches. */
  cannotCheck?: string;
};

type Token = { text: string; quoted: boolean };

const MAX_DEPTH = 4;

function scan(src: string, dialect: Dialect): { segments: Token[][]; nested: string[] } {
  const segments: Token[][] = [];
  const nested: string[] = [];
  const heredocs: string[] = [];
  const esc = dialect === "bash" ? "\\" : "`";
  let seg: Token[] = [];
  let cur = "";
  let quoted = false;
  let inToken = false;

  const endToken = () => {
    if (inToken) seg.push({ text: cur, quoted });
    cur = "";
    quoted = false;
    inToken = false;
  };
  const endSegment = () => {
    endToken();
    if (seg.length > 0) segments.push(seg);
    seg = [];
  };
  // Reads a balanced `( ... )` whose body starts at i; returns [body, index after ")"].
  const readParen = (i: number): [string, number] => {
    let depth = 1;
    let q: string | null = null;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (q) {
        if (c === esc) j++;
        else if (c === q) q = null;
      } else if (c === "'" || c === '"') q = c;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return [src.slice(i, j), j + 1];
    }
    return [src.slice(i), src.length];
  };
  const readUntil = (i: number, end: string): [string, number] => {
    const j = src.indexOf(end, i);
    return j === -1 ? [src.slice(i), src.length] : [src.slice(i, j), j + end.length];
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? "";
    const n = src[i + 1] ?? "";

    if (c === esc && i + 1 < src.length) {
      if (n !== "\n") cur += n;
      inToken = true;
      i += 2;
    } else if (c === "\n" || c === "\r") {
      endSegment();
      i++;
      if (c === "\r" && src[i] === "\n") i++;
      // Heredoc bodies are data: skip each one up to its delimiter line.
      for (const delim of heredocs.splice(0)) {
        while (i < src.length) {
          const [line, after] = readUntil(i, "\n");
          i = after;
          if (line.replace(/\r$/, "").trim() === delim) break;
        }
      }
    } else if (!inToken && c === "#") {
      i = readUntil(i, "\n")[1] - 1; // comment: keep the newline
      if (i < 0 || src[i] !== "\n") i = src.length;
    } else if (dialect === "powershell" && c === "@" && (n === "'" || n === '"') && /[\r\n]/.test(src[i + 2] ?? "")) {
      const [body, after] = readUntil(i + 2, `\n${n}@`); // here-string: data
      cur += body;
      quoted = inToken = true;
      i = after;
    } else if (c === "'") {
      const [body, after] = readUntil(i + 1, "'");
      cur += body;
      quoted = inToken = true;
      i = after;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === esc) {
          cur += src[j + 1] ?? "";
          j += 2;
        } else if (src[j] === "$" && src[j + 1] === "(") {
          const [body, after] = readParen(j + 2);
          nested.push(body);
          cur += `$(${body})`;
          j = after;
        } else if (dialect === "bash" && src[j] === "`") {
          const [body, after] = readUntil(j + 1, "`");
          nested.push(body);
          cur += `\`${body}\``; // keep it, so a path built from it reads as unresolvable
          j = after;
        } else cur += src[j++];
      }
      quoted = inToken = true;
      i = j + 1;
    } else if (c === "$" && n === "(") {
      const [body, after] = readParen(i + 2);
      nested.push(body);
      cur += `$(${body})`;
      quoted = inToken = true;
      i = after;
    } else if (dialect === "bash" && c === "`") {
      const [body, after] = readUntil(i + 1, "`");
      nested.push(body);
      cur += `\`${body}\``; // keep it, so a path built from it reads as unresolvable
      quoted = inToken = true;
      i = after;
    } else if (c === "<" && n === "<" && src[i + 2] === "<") {
      endToken(); // bash here-string redirect: the word after it is data
      i += 3;
    } else if (dialect === "bash" && c === "<" && n === "<") {
      endToken();
      i += 2;
      if (src[i] === "-") i++;
      while (src[i] === " " || src[i] === "\t") i++;
      const m = /^(['"]?)([^\s'"<>;&|]+)\1/.exec(src.slice(i));
      if (m) {
        heredocs.push(m[2] ?? "");
        i += m[0].length;
      }
    } else if (";&|()".includes(c)) {
      endSegment();
      i++;
    } else if (c === " " || c === "\t") {
      endToken();
      i++;
    } else {
      cur += c;
      inToken = true;
      i++;
    }
  }
  endSegment();
  return { segments, nested };
}

const base = (t: string) =>
  t
    .replace(/^.*[\\/]/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
const has = (args: string[], ...flags: string[]) => args.some((a) => flags.includes(a));
// Short-flag clusters like `-fd` or `-xdf`.
const hasShort = (args: string[], letter: string) =>
  args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter));
// git accepts unambiguous abbreviations of long options (`--har` for `--hard`).
const hasLong = (args: string[], ...full: string[]) =>
  args.some((a) => a.startsWith("--") && a.length >= 4 && full.some((f) => f.startsWith(a.split("=")[0] ?? a)));
const isForce = (args: string[]) => has(args, "-f") || hasShort(args, "f") || hasLong(args, "--force");

const WRAPPERS = new Set(["timeout", "winpty", "start-process", "saps", "start", "sudo", "env", "time", "nice", "nohup", "command", "exec", "builtin", "xargs", "then", "do", "else", "elif", "if", "while", "until", "!", "{", "}"]);
const CD = new Set(["cd", "pushd", "chdir", "set-location", "sl", "push-location"]);
const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "git-bash"]);
const POWERSHELLS = new Set(["pwsh", "powershell"]);
const EVALS = new Set(["eval", "invoke-expression", "iex"]);
// Subcommands this guard judges; config overrides on any of them can't be judged by flags.
const WORKTREE_COMMANDS = new Set(["reset", "checkout", "restore", "clean", "stash", "switch", "rm", "checkout-index"]);
const KNOWN = new Set(["git", "cmd", ...CD, ...POSIX_SHELLS, ...POWERSHELLS, ...EVALS]);
const GIT_VALUE_OPTS =new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);

function joinDir(dir: string | undefined, target: string): string {
  if (/^([A-Za-z]:)?[\\/]/.test(target) || /^[~$]/.test(target) || !dir) return target;
  return `${dir.replace(/[\\/]+$/, "")}/${target}`;
}

// -EncodedCommand is base64 of UTF-16LE. Decoded by hand: the mod runtime only decodes UTF-8.
function decodePwsh(b64: string): string {
  const bin = atob(b64);
  let out = "";
  for (let i = 0; i + 1 < bin.length; i += 2) out += String.fromCharCode(bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8));
  return out;
}

function analyzeGit(args: string[], cwd: string | undefined, written: string, gitEnv: boolean): Destructive | undefined {
  const gitOptions: string[] = [];
  let overridesConfig = false;
  let definesAlias = false;
  let k = 0;
  while (args[k]?.startsWith("-")) {
    const a = args[k] ?? "";
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq === -1 ? a : a.slice(0, eq);
    if (GIT_VALUE_OPTS.has(flag)) {
      const value = eq === -1 ? args[++k] : a.slice(eq + 1);
      if (value !== undefined && flag === "-C") gitOptions.push("-C", value);
      if (flag === "-c" || flag === "--config-env") {
        overridesConfig = true;
        if (/^alias[.]/i.test(value ?? "")) definesAlias = true;
      }
      if (value !== undefined && (flag === "--git-dir" || flag === "--work-tree")) gitOptions.push(`${flag}=${value}`);
    }
    k++;
  }
  const sub = args[k];
  const rest = args.slice(k + 1);
  if (!sub || has(rest, "--help") || rest[0] === "-h") return undefined;

  const found: Destructive = { command: written, cwd, gitOptions, includesIgnored: false };
  if (gitEnv) found.cannotCheck = "it sets GIT_* environment variables";
  // Config set on the command line (`-c alias.x=...`, `clean.requireForce=false`) can change
  // what any of these commands does, so they can't be judged by their flags.
  if (definesAlias) return { ...found, cannotCheck: "it defines a git alias" };
  if (overridesConfig && WORKTREE_COMMANDS.has(sub)) return { ...found, cannotCheck: "it overrides git config" };

  switch (sub) {
    case "reset":
      return has(rest, "--hard", "--merge") || hasLong(rest, "--hard", "--merge") ? found : undefined;
    case "checkout": {
      if (isForce(rest) || has(rest, "-p", "--patch", "--", ".") || hasLong(rest, "--patch", "--pathspec-from-file")) return found;
      if (has(rest, "-b", "-B", "--orphan")) return undefined;
      const positional = rest.filter((a) => !a.startsWith("-"));
      if (positional.length === 0) return undefined; // `git checkout` / `git checkout -`
      if (positional.length === 1) return { ...found, branchCheck: positional[0] };
      return found; // <tree-ish> <paths>
    }
    case "restore": {
      const staged = hasShort(rest, "S") || has(rest, "--staged") || hasLong(rest, "--staged");
      const worktree = hasShort(rest, "W") || has(rest, "--worktree") || hasLong(rest, "--worktree");
      return staged && !worktree ? undefined : found;
    }
    case "clean":
      if (!isForce(rest) || has(rest, "--dry-run") || hasLong(rest, "--dry-run") || hasShort(rest, "n")) return undefined;
      return { ...found, includesIgnored: hasShort(rest, "x") || hasShort(rest, "X") };
    case "stash":
      return has(rest, "list", "show") ? undefined : found;
    case "switch":
      return isForce(rest) || hasLong(rest, "--discard-changes") ? found : undefined;
    case "rm":
      return isForce(rest) && !has(rest, "--cached") && !hasLong(rest, "--cached") ? found : undefined;
    case "checkout-index":
      return isForce(rest) ? found : undefined;
    // `--abort` resets to the state before the operation and can take uncommitted edits with it.
    case "merge":
    case "am":
    case "cherry-pick":
    case "revert":
    case "rebase":
      return has(rest, "--abort") || hasLong(rest, "--abort") ? found : undefined;
    case "worktree":
      // `worktree remove --force` deletes another checkout's uncommitted work, which the status
      // check below (run in this checkout) can't see. Without --force git refuses a dirty worktree.
      return rest[0] === "remove" && isForce(rest.slice(1))
        ? { ...found, cannotCheck: "it force-removes a git worktree, whose changes this guard can't see" }
        : undefined;
    default:
      return undefined;
  }
}

export function findDestructiveGit(
  src: string,
  dialect: Dialect = "bash",
  startDir?: string,
  depth = 0,
): Destructive | undefined {
  if (depth > MAX_DEPTH) {
    // Too deeply nested to read: refuse rather than guess which repo it touches.
    return { command: src.slice(0, 200), cwd: startDir, gitOptions: [], includesIgnored: false, cannotCheck: "it is nested too deeply to read" };
  }
  const { segments, nested } = scan(src, dialect);
  let dir = startDir;

  for (const seg of segments) {
    const tokens = seg.map((t) => t.text);
    let i = 0;
    let gitEnv = false;
    let wrapped = false;
    for (;;) {
      const t = tokens[i];
      if (t === undefined) break;
      // `NAME=value` before the command (the value may be quoted: `X='reset --hard'`).
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        if (/^GIT_/i.test(t)) gitEnv = true;
      } else if (WRAPPERS.has(base(t))) wrapped = true;
      else if (!(wrapped && t.startsWith("-"))) break;
      i++;
    }
    // After a wrapper (`sudo -u me git ...`), option values hide the command: look ahead for a known one.
    if (wrapped && !KNOWN.has(base(tokens[i] ?? ""))) {
      const ahead = tokens.findIndex((t, j) => j > i && KNOWN.has(base(t)));
      if (ahead !== -1) i = ahead;
    }
    const cmd = tokens[i];
    if (cmd === undefined) continue;
    const name = base(cmd);
    const rest = tokens.slice(i + 1);
    let inner: { text: string; dialect: Dialect } | undefined;

    if (CD.has(name)) {
      dir = joinDir(dir, rest.find((a) => !a.startsWith("-")) ?? "~");
      continue;
    } else if (POSIX_SHELLS.has(name)) {
      const at = rest.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
      const text = at === -1 ? undefined : rest[at + 1];
      if (text !== undefined) inner = { text, dialect: "bash" };
    } else if (POWERSHELLS.has(name)) {
      // PowerShell accepts any unambiguous prefix (-comm, -enco); with no flag, the rest is the command.
      const isEncoded = (a: string) => a.length >= 2 && (/^-ec$/i.test(a) || "-encodedcommand".startsWith(a.toLowerCase()));
      const isCommand = (a: string) => a.length >= 2 && "-command".startsWith(a.toLowerCase());
      const at = rest.findIndex((a) => isEncoded(a) || isCommand(a));
      if (at !== -1 && isEncoded(rest[at] ?? "")) inner = { text: decodePwsh(rest[at + 1] ?? ""), dialect: "powershell" };
      else if (at !== -1) inner = { text: rest.slice(at + 1).join(" "), dialect: "powershell" };
      else {
        // `powershell -NoProfile git reset --hard`: the command starts at the first non-option word.
        const first = rest.findIndex((a) => !a.startsWith("-"));
        inner = { text: first === -1 ? "" : rest.slice(first).join(" "), dialect: "powershell" };
      }
    } else if (name === "cmd") {
      const at = rest.findIndex((a) => /^\/[ck]$/i.test(a));
      if (at !== -1) inner = { text: rest.slice(at + 1).join(" "), dialect: "bash" };
    } else if (EVALS.has(name)) {
      inner = { text: rest.join(" "), dialect };
    } else if (name === "git") {
      // `Start-Process git -ArgumentList 'reset --hard'` passes git's arguments as one string.
      let args = rest;
      if (tokens.some((t) => /^(start-process|saps|start)$/i.test(t))) {
        // git's arguments are the -ArgumentList value (or, without it, the bare words).
        const at = rest.findIndex((a) => /^-(argumentlist|args)$/i.test(a));
        const raw = at === -1 ? rest.filter((a) => !a.startsWith("-")) : [rest[at + 1] ?? ""];
        args = raw.flatMap((a) => a.split(/[\s,]+/)).filter(Boolean);
      }
      const found = analyzeGit(args, dir, tokens.slice(i).join(" "), gitEnv);
      // `env -C dir`, `env --chdir`, `Start-Process -WorkingDirectory`: a directory change the guard can't follow.
      if (found && tokens.some((t, j) => (j < i && /^(-C|--chdir(=.*)?)$/.test(t)) || /^-(workingdirectory|wd)$/i.test(t))) {
        return { ...found, cannotCheck: "it changes directory in a way the guard can't follow" };
      }
      if (found) return found;
    }

    if (inner) {
      const found = findDestructiveGit(inner.text, inner.dialect, dir, depth + 1);
      if (found) return found;
    }
  }

  for (const body of nested) {
    const found = findDestructiveGit(body, dialect, dir, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Paths from `git status --porcelain` output. */
export function changedPaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter((p) => p.length > 0);
}
