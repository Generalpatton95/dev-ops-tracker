"use client";

// T-8 (REQ-1): sign-in and sign-out buttons. Both use Auth.js's own CSRF-protected endpoints
// (fetch a token from /api/auth/csrf, then POST it back), so every request goes through the
// rate-limited /api/auth route. The page then navigates to the address Auth.js returns, but
// only if it is this site or GitHub's authorisation page.
import { useState } from "react";

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";

type Outcome = { url: string } | { status: number };

async function authAction(path: string, fields: Record<string, string>): Promise<Outcome> {
  const csrf = await fetch("/api/auth/csrf", { cache: "no-store" });
  if (!csrf.ok) return { status: csrf.status };
  const { csrfToken } = (await csrf.json()) as { csrfToken?: unknown };
  if (typeof csrfToken !== "string") return { status: 500 };

  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // Asks Auth.js for the next address as JSON instead of a redirect.
      "X-Auth-Return-Redirect": "1",
    },
    body: new URLSearchParams({ ...fields, csrfToken }),
  });
  if (!res.ok) return { status: res.status };
  const { url } = (await res.json()) as { url?: unknown };
  return typeof url === "string" ? { url } : { status: 500 };
}

export function isAllowedDestination(url: string, origin: string, allowGitHub: boolean): boolean {
  try {
    const target = new URL(url, origin);
    if (target.origin === origin) return true;
    return allowGitHub && `${target.origin}${target.pathname}` === GITHUB_AUTHORIZE;
  } catch {
    return false;
  }
}

function failureMessage(status: number, what: string): string {
  if (status === 429) return `Too many attempts. Wait a minute, then ${what} again.`;
  if (status === 503)
    return `${what[0].toUpperCase()}${what.slice(1)} isn't available right now. Try again shortly.`;
  return `Couldn't ${what}. Try again.`;
}

function useAuthAction(what: string, path: string, allowGitHub: boolean) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(fields: Record<string, string>) {
    setBusy(true);
    setMessage(null);
    let outcome: Outcome;
    try {
      outcome = await authAction(path, fields);
    } catch {
      outcome = { status: 0 };
    }
    if (
      "url" in outcome &&
      isAllowedDestination(outcome.url, window.location.origin, allowGitHub)
    ) {
      window.location.assign(outcome.url);
      return;
    }
    setBusy(false);
    setMessage(failureMessage("status" in outcome ? outcome.status : 500, what));
  }

  return { busy, message, run };
}

export function SignInButton({ callbackUrl }: { callbackUrl: string }) {
  const { busy, message, run } = useAuthAction("sign in", "/api/auth/signin/github", true);
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={() => run({ callbackUrl })}
        disabled={busy}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {busy ? "Opening GitHub…" : "Sign in with GitHub"}
      </button>
      {message && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {message}
        </p>
      )}
    </div>
  );
}

export function SignOutButton() {
  const { busy, message, run } = useAuthAction("sign out", "/api/auth/signout", false);
  return (
    <span className="flex items-center gap-2">
      {message && (
        <span role="alert" className="text-sm text-red-700 dark:text-red-400">
          {message}
        </span>
      )}
      <button
        type="button"
        onClick={() => run({ callbackUrl: "/sign-in" })}
        disabled={busy}
        className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </span>
  );
}
