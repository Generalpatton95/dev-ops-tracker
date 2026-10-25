import { Suspense } from "react";
import { HealthStatus } from "@/app/health-status";
import { requireSession } from "@/server/auth";

// T-8 (REQ-1): a signed-in placeholder until workspaces land (T-9).
async function Welcome() {
  const { user } = await requireSession();
  return (
    <p className="text-pretty text-zinc-700 dark:text-zinc-300">
      Signed in as <span className="font-medium">{user.name}</span>. Workspaces and projects arrive
      later in Milestone 1.
    </p>
  );
}

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Dev-ops-tracker</h1>
      <Suspense fallback={<p className="text-zinc-500">Checking your session…</p>}>
        <Welcome />
      </Suspense>
      <HealthStatus />
    </main>
  );
}
