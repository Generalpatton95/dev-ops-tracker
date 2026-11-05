"use client";

// T-10 (REQ-3): the header's workspace switcher. It lists the workspaces the server says the user
// belongs to; choosing one asks the server to switch (it checks membership and sets the cookie),
// then refreshes the server-rendered page. The picked workspace stays shown, and the select stays
// disabled, until the switch and the refresh have both finished, so it never snaps back to the
// old one in between. Names are rendered as text.
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { useTRPC } from "@/trpc/client";

export type SwitcherWorkspace = { id: string; name: string; role: string };

export function switcherLabel(workspace: SwitcherWorkspace): string {
  return workspace.role === "owner" ? `${workspace.name} (yours)` : workspace.name;
}

export function WorkspaceSwitcher({
  currentId,
  workspaces,
}: {
  currentId: string;
  workspaces: SwitcherWorkspace[];
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const selectId = useId();
  const switchTo = useMutation(trpc.workspace.switch.mutationOptions());
  const [refreshing, startRefresh] = useTransition();
  // The workspace just picked, shown until the refreshed page brings the new currentId.
  const [picked, setPicked] = useState<string | null>(null);
  const busy = switchTo.isPending || refreshing;
  const shown = busy && picked ? picked : currentId;
  const current = workspaces.find((w) => w.id === currentId);

  if (workspaces.length < 2) {
    return current ? (
      <span className="max-w-48 truncate text-sm text-zinc-700 dark:text-zinc-300">
        {current.name}
      </span>
    ) : null;
  }

  return (
    <span className="flex items-center gap-2">
      <label htmlFor={selectId} className="sr-only">
        Workspace
      </label>
      <select
        id={selectId}
        value={shown}
        disabled={busy}
        aria-busy={busy || undefined}
        onChange={(event) => {
          const workspaceId = event.target.value;
          setPicked(workspaceId);
          switchTo.mutate(
            { workspaceId },
            {
              // The transition stays pending until the refreshed server components arrive.
              onSuccess: () => startRefresh(() => router.refresh()),
              onError: () => setPicked(null),
            },
          );
        }}
        className="max-w-56 rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm disabled:opacity-60 dark:border-zinc-700"
      >
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {switcherLabel(workspace)}
          </option>
        ))}
      </select>
      {switchTo.isError && (
        <span role="alert" className="text-sm text-red-700 dark:text-red-400">
          Couldn&apos;t switch. Reload and try again.
        </span>
      )}
    </span>
  );
}
