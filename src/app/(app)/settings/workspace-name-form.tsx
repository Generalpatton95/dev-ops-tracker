"use client";

// T-9 (REQ-2): the workspace name field and Save. The shared rule gives an early hint; the server
// checks the name again and decides whether this user may rename the workspace. No Zod and
// nothing from src/server here, so the browser bundle stays small.
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useId, useReducer } from "react";
import { useTRPC } from "@/trpc/client";
import {
  characterCount,
  initialNameFormState,
  nameFormReducer,
  nameToSave,
} from "./name-form-state";

export function WorkspaceNameForm({
  workspaceId,
  initialName,
}: {
  workspaceId: string;
  initialName: string;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const inputId = useId();
  const countId = useId();
  const [state, dispatch] = useReducer(nameFormReducer, initialName, initialNameFormState);
  const rename = useMutation(trpc.workspace.rename.mutationOptions());
  const { status } = state;
  const saving = status.kind === "saving";

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = nameFormReducer(state, { type: "submit" });
    dispatch({ type: "submit" });
    if (next.status.kind !== "saving" || saving) return;
    rename.mutate(
      { workspaceId, name: nameToSave(next) },
      {
        onSuccess: (workspace) => {
          dispatch({ type: "saved", name: workspace.name });
          // The header and home page are server-rendered; fetch them again with the new name.
          router.refresh();
        },
        onError: (error) => dispatch({ type: "failed", code: error.data?.code }),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2" noValidate>
      <label htmlFor={inputId} className="text-sm font-medium">
        Workspace name
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          name="name"
          type="text"
          value={state.value}
          onChange={(event) => {
            rename.reset();
            dispatch({ type: "edit", value: event.target.value });
          }}
          disabled={saving}
          aria-describedby={countId}
          aria-invalid={status.kind === "error" ? true : undefined}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm disabled:opacity-60 dark:border-zinc-700"
        />
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <p id={countId} className="text-xs text-zinc-600 dark:text-zinc-400">
        {characterCount(state.value)}
      </p>
      {status.kind === "error" && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {status.message}
        </p>
      )}
      {status.kind === "saved" && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          Saved.
        </p>
      )}
    </form>
  );
}
