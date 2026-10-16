// Path handling for the guard's "only inside this project" rule. Pure, so it is tested directly.

/**
 * Resolves `p` against `base` to an absolute, normalised path with forward slashes.
 * Git Bash style `/c/dev` becomes `C:/dev`. Returns undefined for paths the shell
 * would expand (`~`, `$VAR`, `%VAR%`), which the guard can't know.
 */
export function resolvePath(base: string, p: string): string | undefined {
  if (/^[~$%]/.test(p) || /[$%`]/.test(p)) return undefined;
  const fwd = (s: string) => s.replace(/\\/g, "/").replace(/^\/([a-zA-Z])(?=\/|$)/, (_m, d: string) => `${d.toUpperCase()}:`);
  const path = fwd(p);
  const absolute = /^[A-Za-z]:\//.test(path) || /^[A-Za-z]:$/.test(path) || path.startsWith("/");
  const joined = absolute ? path : `${fwd(base)}/${path}`;

  const drive = /^[A-Za-z]:/.exec(joined)?.[0]?.toUpperCase() ?? "";
  const out: string[] = [];
  for (const part of joined.slice(drive.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `${drive}/${out.join("/")}`;
}

/** True when `path` is `root` or below it (case-insensitive on Windows drive paths). */
export function isInside(path: string, root: string): boolean {
  const windows = /^[A-Za-z]:/.test(root);
  const norm = (s: string) => (windows ? s.toLowerCase() : s).replace(/\/+$/, "");
  const p = norm(path);
  const r = norm(root);
  return r !== "" && (p === r || p.startsWith(`${r}/`));
}
