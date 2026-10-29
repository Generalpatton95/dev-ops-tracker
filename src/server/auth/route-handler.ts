// T-8 (REQ-1): the /api/auth/* route. Only the Auth.js endpoints the app uses are open; the
// sign-in and OAuth callback endpoints are rate-limited per IP in Postgres before Auth.js runs,
// and fail closed. Without the AUTH_* variables (previews) every endpoint answers 503.
import "server-only";
import type { NextRequest } from "next/server";
import { errorLabel } from "@/server/log-label";
import { checkRateLimit, rateLimitResponse } from "@/server/rate-limit";
import { isAuthConfigured } from "./config";

export const AUTH_BASE_PATH = "/api/auth";
// Auth.js's POST bodies are a CSRF token and a callback path; anything bigger is refused.
export const MAX_AUTH_BODY_BYTES = 8 * 1024;

type Route = { method: "GET" | "POST"; action: string; limited: boolean };

// Everything else Auth.js offers (its built-in pages, /session, /providers, …) answers 404.
const ROUTES: readonly Route[] = [
  { method: "GET", action: "csrf", limited: false },
  { method: "POST", action: "signin/github", limited: true },
  { method: "GET", action: "callback/github", limited: true },
  { method: "POST", action: "signout", limited: false },
];

export function findRoute(method: string, pathname: string): Route | undefined {
  if (!pathname.startsWith(`${AUTH_BASE_PATH}/`)) return undefined;
  const action = pathname.slice(AUTH_BASE_PATH.length + 1).replace(/\/$/, "");
  return ROUTES.find((route) => route.method === method && route.action === action);
}

function bodyTooBig(req: Request): Response | null {
  if (req.method !== "POST") return null;
  const header = req.headers.get("content-length");
  if (header === null) return new Response(null, { status: 411 });
  const length = Number(header);
  if (!Number.isInteger(length) || length < 0) return new Response(null, { status: 400 });
  if (length > MAX_AUTH_BODY_BYTES) return new Response(null, { status: 413 });
  return null;
}

export type AuthHandler = (req: NextRequest) => Promise<Response>;

export function createAuthRouteHandler(
  authHandlers: { GET: AuthHandler; POST: AuthHandler },
  env: Readonly<Record<string, string | undefined>> = process.env,
  limit: typeof checkRateLimit = checkRateLimit,
): AuthHandler {
  return async function handle(req) {
    const route = findRoute(req.method, new URL(req.url).pathname);
    if (!route) return new Response(null, { status: 404 });
    if (!isAuthConfigured(env)) {
      return new Response("Sign-in isn't set up on this deployment.", {
        status: 503,
        headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    const refused = bodyTooBig(req);
    if (refused) return refused;

    if (route.limited) {
      const result = await limit({ bucket: "auth", headers: req.headers, env });
      if (!result.ok) return rateLimitResponse(result.status);
    }
    try {
      return await authHandlers[route.method](req);
    } catch (error) {
      // Auth.js answers its own errors; reaching here means setup failed (e.g. no DATABASE_URL).
      console.error(`[auth] ${route.method} ${route.action} failed: ${errorLabel(error)}`);
      return new Response(null, { status: 500 });
    }
  };
}
