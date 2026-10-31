// T-9 (REQ-2): workspace settings. Protected like every app page: the proxy redirects signed-out
// visits, and getCurrentWorkspace() checks the session on the server too. T-10 adds invites and
// members here.
import type { Metadata } from "next";
import { Suspense } from "react";
import { WorkspaceSettings } from "./workspace-settings";

export const metadata: Metadata = { title: "Settings · Dev-ops-tracker" };

export default function SettingsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
      <Suspense fallback={<p className="text-zinc-500">Loading your workspace…</p>}>
        <WorkspaceSettings />
      </Suspense>
    </main>
  );
}
