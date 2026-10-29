// T-8 (REQ-1): the sign-in page, open to everyone. One GitHub button and a link to what is kept.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SignInButton } from "@/app/auth-buttons";
import { getCurrentSession, isAuthConfigured } from "@/server/auth";
import { RETURN_PARAM, safeReturnPath } from "@/server/auth/return-path";

export const metadata: Metadata = { title: "Sign in · Dev-ops-tracker" };

// Auth.js sends errors back here as ?error=<type>. Only these fixed texts are shown; the
// parameter itself is never echoed.
function errorText(error: string): string {
  if (error === "AccessDenied") return "GitHub sign-in was cancelled. You can try again.";
  return "Sign-in didn't complete. Try again.";
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function SignInPanel({
  searchParams,
}: {
  searchParams: PageProps<"/sign-in">["searchParams"];
}) {
  const params = await searchParams;
  // Read per request, not at build: previews build without the AUTH_* variables.
  if (!isAuthConfigured(process.env)) {
    return (
      <p className="text-pretty text-zinc-700 dark:text-zinc-300">
        Sign-in isn&apos;t available on this deployment. It works on the production site and when
        you run the app locally with sign-in set up.
      </p>
    );
  }

  const returnTo = safeReturnPath(first(params[RETURN_PARAM]));
  if (await getCurrentSession()) redirect(returnTo);

  const error = first(params.error);
  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {errorText(error)}
        </p>
      )}
      <SignInButton callbackUrl={returnTo} />
    </div>
  );
}

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Sign in to Dev-ops-tracker</h1>
      <Suspense fallback={<p className="text-zinc-500">Loading…</p>}>
        <SignInPanel searchParams={searchParams} />
      </Suspense>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        <Link href="/privacy" className="underline underline-offset-2">
          What we keep about you
        </Link>
      </p>
    </main>
  );
}
