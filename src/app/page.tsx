import { HealthStatus } from "@/app/health-status";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Dev-ops-tracker</h1>
      <p className="text-pretty text-zinc-700 dark:text-zinc-300">
        A simpler, spec-driven tracker for small dev teams. Sign-in, workspaces and projects land in
        Milestone 1.
      </p>
      <HealthStatus />
    </main>
  );
}
