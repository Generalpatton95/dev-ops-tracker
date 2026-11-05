"use client";

// T-10 (REQ-3): the owner's invite link. A new link is shown once, right after it's made, with
// Copy; the server keeps only its hash, so it can't be shown again. Making a new link replaces
// the old one, and "Turn off link" ends it. The server decides whether this user may do either.
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTRPC } from "@/trpc/client";

/** The text shown for a failed action, from the tRPC error code only. */
export function inviteActionFailure(code: string | undefined): string {
  switch (code) {
    case "UNAUTHORIZED":
      return "Your session has ended. Sign in again, then try again.";
    case "NOT_FOUND":
      return "Only the workspace's owner can change its invite link.";
    default:
      return "Couldn't update the invite link. Try again.";
  }
}

/** The full link for a token, on whatever host the app is served from (REQ-7). */
export function inviteUrl(origin: string, token: string): string {
  return `${origin}/invite/${encodeURIComponent(token)}`;
}

type Notice = { kind: "error" | "status"; text: string } | null;

/**
 * Whether a link is on is held by the parent (OwnerControls), because removing a member turns
 * the link off too and the panel must show that. The new link itself stays here, and only shows
 * while the link is still on.
 */
export function InviteLinkPanel({
  active,
  onActiveChange,
}: {
  active: boolean;
  onActiveChange: (active: boolean) => void;
}) {
  const trpc = useTRPC();
  const linkId = useId();
  const [link, setLink] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const create = useMutation(trpc.workspace.createInvite.mutationOptions());
  const disable = useMutation(trpc.workspace.disableInvite.mutationOptions());
  const busy = create.isPending || disable.isPending;

  function makeLink() {
    setNotice(null);
    create.mutate(undefined, {
      onSuccess: ({ token }) => {
        onActiveChange(true);
        setLink(inviteUrl(window.location.origin, token));
      },
      onError: (error) => setNotice({ kind: "error", text: inviteActionFailure(error.data?.code) }),
    });
  }

  function turnOff() {
    setNotice(null);
    disable.mutate(undefined, {
      onSuccess: () => {
        onActiveChange(false);
        setLink(null);
        setNotice({ kind: "status", text: "Link turned off. Nobody new can join with it." });
      },
      onError: (error) => setNotice({ kind: "error", text: inviteActionFailure(error.data?.code) }),
    });
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ kind: "status", text: "Copied." });
    } catch {
      setNotice({ kind: "error", text: "Couldn't copy. Select the link and copy it yourself." });
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Invite link</h2>
      <p className="text-sm text-pretty text-zinc-700 dark:text-zinc-300">
        {active
          ? "A link is on. Anyone signed in who opens it can join as a member. Making a new link turns the old one off."
          : "No link is on. Make one to invite teammates: anyone signed in who opens it can join as a member."}
      </p>
      {active && link && (
        <div className="flex flex-col gap-2">
          <label htmlFor={linkId} className="text-sm font-medium">
            Your new link (shown only now, so copy it)
          </label>
          <div className="flex gap-2">
            <input
              id={linkId}
              type="text"
              readOnly
              value={link}
              onFocus={(event) => event.currentTarget.select()}
              className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent px-3 py-2 font-mono text-xs dark:border-zinc-700"
            />
            <button
              type="button"
              onClick={() => copy(link)}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Copy
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={makeLink}
          disabled={busy}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {create.isPending ? "Making…" : active ? "Make a new link" : "Make invite link"}
        </button>
        {active && (
          <button
            type="button"
            onClick={turnOff}
            disabled={busy}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {disable.isPending ? "Turning off…" : "Turn off link"}
          </button>
        )}
      </div>
      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={
            notice.kind === "error"
              ? "text-sm text-red-700 dark:text-red-400"
              : "text-sm text-green-700 dark:text-green-400"
          }
        >
          {notice.text}
        </p>
      )}
    </section>
  );
}
