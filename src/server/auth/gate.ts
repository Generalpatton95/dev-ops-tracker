// T-8 (REQ-1): the proxy's decision, kept apart from src/proxy.ts (which Next wants to export
// only `proxy` and `config`) so it can be tested. No "server-only": the proxy imports it.
import { safeReturnPath, signInPathFor } from "./return-path";

// Auth.js's session cookie: the __Secure- name on https, the plain one on http (local).
export const SESSION_COOKIES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;

// The page a request asked for, set by the proxy on every page request it lets through, so the
// signed-in layout (which doesn't know its page) can send a stale session back to sign-in with
// the right return path. The proxy always overwrites it; readers validate it again anyway.
export const RETURN_PATH_HEADER = "x-dot-return-path";

/** The validated return path from RETURN_PATH_HEADER, or "/" when it's missing or unsafe. */
export function returnPathFromHeaders(headers: Headers): string {
  return safeReturnPath(headers.get(RETURN_PATH_HEADER));
}

// Pages anyone may open. Every other page needs a session.
export const PUBLIC_PAGES = ["/sign-in", "/privacy"] as const;

export function isPublicPage(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return (PUBLIC_PAGES as readonly string[]).includes(path);
}

/**
 * Where a page request should go instead, or null to let it through. Only the cookie's presence
 * is checked here; the page itself checks the session in the database.
 */
export function signedOutRedirect(
  url: { pathname: string; search: string },
  hasCookie: (name: string) => boolean,
): string | null {
  if (isPublicPage(url.pathname)) return null;
  if (SESSION_COOKIES.some(hasCookie)) return null;
  return signInPathFor(`${url.pathname}${url.search}`);
}
