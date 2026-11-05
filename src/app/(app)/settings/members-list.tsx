"use client";

// T-10 (REQ-3): the owner's members list: name, role and join date, with Remove on everyone but
// the owner. The list comes from workspace.members, which only the owner may read; the server
// also refuses to remove the owner. Names are rendered as text. Removing someone also turns the
// invite link off (on the server, in the same step), and the list says so.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

/** "Joined 2 Nov 2026" in the reader's own locale, or nothing for a date that won't parse. */
export function joinedText(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `Joined ${new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date)}`;
}

export function roleText(role: string): string {
  if (role === "owner") return "Owner";
  if (role === "member") return "Member";
  return "Guest";
}

/** The text shown for a failed removal, from the tRPC error code only. */
export function removeFailure(code: string | undefined): string {
  switch (code) {
    case "UNAUTHORIZED":
      return "Your session has ended. Sign in again, then try again.";
    case "NOT_FOUND":
      return "That person isn't in this workspace any more, or can't be removed.";
    default:
      return "Couldn't remove them right now. Try again.";
  }
}

/** Shown after a removal: the server turned the invite link off in the same step. */
export function removedNotice(name: string): string {
  return `Removed ${name}. The invite link is now off, so make a new one to invite anyone else.`;
}

export function MembersList({ onRemoved }: { onRemoved?: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // Always fetched fresh on opening the page: the list changes when someone joins.
  const members = useQuery({ ...trpc.workspace.members.queryOptions(), staleTime: 0 });
  const remove = useMutation(trpc.workspace.removeMember.mutationOptions());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function onRemove(userId: string, name: string) {
    if (!window.confirm(`Remove ${name} from this workspace?`)) return;
    setError(null);
    setNotice(null);
    remove.mutate(
      { userId },
      {
        onSuccess: () => {
          setNotice(removedNotice(name));
          onRemoved?.();
        },
        onError: (failure) => setError(removeFailure(failure.data?.code)),
        onSettled: () =>
          queryClient.invalidateQueries({ queryKey: trpc.workspace.members.queryKey() }),
      },
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Members</h2>
      {members.isPending && <p className="text-sm text-zinc-500">Loading members…</p>}
      {members.isError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          The members list couldn&apos;t be loaded. Reload the page to try again.
        </p>
      )}
      {members.data && (
        <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {members.data.map((member) => (
            <li key={member.userId} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{member.name}</span>
                <span className="text-xs text-zinc-600 dark:text-zinc-400">
                  {roleText(member.role)} · {joinedText(member.joinedAt)}
                </span>
              </div>
              {member.role !== "owner" && (
                <button
                  type="button"
                  onClick={() => onRemove(member.userId, member.name)}
                  disabled={remove.isPending}
                  className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
