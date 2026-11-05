// T-10 (REQ-3): /invite/<token>. A protected page like every app page: the proxy sends signed-out
// visits to sign-in with this path to come back to, and previewInvite() checks the session on the
// server too. The token is in the path, so the page sends no referrer and asks not to be indexed.
import type { Metadata } from "next";
import { Suspense } from "react";
import { InvitePanel } from "./invite-panel";

export const metadata: Metadata = {
  title: "Join a workspace · Dev-ops-tracker",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function InvitePage({ params }: PageProps<"/invite/[token]">) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-6 py-24">
      <Suspense fallback={<p className="text-zinc-500">Loading the invite…</p>}>
        {/* Awaited inside the boundary: the token is request data. */}
        {params.then(({ token }) => (
          <InvitePanel token={token} />
        ))}
      </Suspense>
    </main>
  );
}
