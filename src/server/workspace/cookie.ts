// T-10 (REQ-3): the current-workspace cookie. It holds only a workspace id and is a preference,
// not a permission: the server checks the caller's membership on every request and falls back
// to the workspace they own when it is missing, malformed or no longer theirs. No "server-only"
// import, so the tRPC route and its tests can load it; nothing in the browser can read it.
import { isUuid } from "@/server/ids";

// In production the cookie is Secure and carries the __Host- prefix, so the browser accepts it
// only from this exact host over https, with Path=/ and no Domain: a sibling subdomain can't
// set or overwrite it. Locally (plain http) the prefix isn't allowed, so the plain name is used.
export const WORKSPACE_COOKIE = "dot-workspace";
export const SECURE_WORKSPACE_COOKIE = "__Host-dot-workspace";
// A year; the browser keeps it until then, or until another workspace is chosen.
export const WORKSPACE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

type Env = Readonly<Record<string, string | undefined>>;

function isSecure(env: Env): boolean {
  return env.NODE_ENV === "production";
}

/** The cookie's name here: __Host-dot-workspace in production, dot-workspace otherwise. */
export function workspaceCookieName(env: Env = process.env): string {
  return isSecure(env) ? SECURE_WORKSPACE_COOKIE : WORKSPACE_COOKIE;
}

/** The Set-Cookie value choosing `workspaceId`: httpOnly, SameSite=Lax, Secure in production. */
export function workspaceCookieHeader(workspaceId: string, env: Env = process.env): string {
  // Only ever a UUID, so the value needs no encoding and can't carry other attributes.
  if (!isUuid(workspaceId)) throw new Error("workspace cookie value must be a UUID");
  const parts = [
    `${workspaceCookieName(env)}=${workspaceId.toLowerCase()}`,
    "Path=/",
    `Max-Age=${WORKSPACE_COOKIE_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecure(env)) parts.push("Secure");
  return parts.join("; ");
}

/**
 * The workspace id from a request's Cookie header, or null when it is absent or not a UUID.
 * Only the name for this environment counts (in production, never the unprefixed one). Still
 * only a preference: callers check membership before using it.
 */
export function workspaceIdFromCookieHeader(
  header: string | null,
  env: Env = process.env,
): string | null {
  if (!header) return null;
  const name = workspaceCookieName(env);
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return isUuid(value) ? value : null;
  }
  return null;
}
