import { Suspense } from "react";
import { HealthStatus } from "@/app/health-status";
import { WorkspaceSummary } from "./workspace-summary";

// T-9 (REQ-2): the home page shows the user's workspace.
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Dev-ops-tracker</h1>
      <Suspense fallback={<p className="text-zinc-500">Loading your workspace…</p>}>
        <WorkspaceSummary />
      </Suspense>
      <HealthStatus />
    </main>
  );
}
