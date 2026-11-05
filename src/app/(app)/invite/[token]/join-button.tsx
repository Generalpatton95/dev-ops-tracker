"use client";

// T-10 (REQ-3): the Join button. Joining is a tRPC mutation (a POST), so only this click joins;
// opening, previewing or prefetching the page never does. The server sets the current-workspace
// cookie, and the page then loads home in that workspace.
import { useMutation } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";
import { inviteProblemFromCode, inviteProblemMessage } from "./invite-messages";

export function JoinButton({ token }: { token: string }) {
  const trpc = useTRPC();
  const join = useMutation(trpc.invite.join.mutationOptions());
  // Stays busy after success while the browser loads home.
  const busy = join.isPending || join.isSuccess;

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          join.mutate(
            { token },
            {
              // A full load, so the header and every page read the new cookie; replace() keeps
              // the invite link out of the back button's history.
              onSuccess: () => window.location.replace("/"),
            },
          )
        }
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {busy ? "Joining…" : "Join"}
      </button>
      {join.isError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {inviteProblemMessage(inviteProblemFromCode(join.error.data?.code))}
        </p>
      )}
    </div>
  );
}
