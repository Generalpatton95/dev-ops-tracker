// T-8 (REQ-1): where to send someone after they sign in. Only a same-site relative path to an
// app page is kept; anything else (absolute or protocol-relative URLs, backslashes, control
// characters, overlong values, API routes, the sign-in page itself) becomes "/".
// No "server-only" import: the proxy and the sign-in page both use it, and it holds no secret.

export const SIGN_IN_PATH = "/sign-in";
export const RETURN_PARAM = "callbackUrl";
const MAX_LENGTH = 1024;
// Any base works: it only gives relative paths something to resolve against.
const BASE = "http://return-path.invalid";

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) return "/";
  // Must be a path on this site: "/x", never "//host", "/\host", "https://…" or "javascript:…".
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  // Browsers treat "\" as "/" and the URL parser drops tabs and newlines, either of which could
  // turn "/\evil.example" or "/\t/evil.example" into "//evil.example". Refuse them outright.
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return "/";

  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE) return "/";
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  if (isUnder(url.pathname, "/api") || isUnder(url.pathname, SIGN_IN_PATH)) return "/";
  return path;
}

/** The sign-in page's address, carrying where to go afterwards when that isn't home. */
export function signInPathFor(returnTo: string): string {
  const path = safeReturnPath(returnTo);
  if (path === "/") return SIGN_IN_PATH;
  return `${SIGN_IN_PATH}?${new URLSearchParams({ [RETURN_PARAM]: path })}`;
}
