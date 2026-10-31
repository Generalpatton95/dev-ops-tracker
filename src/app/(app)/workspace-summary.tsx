// T-9 (REQ-2): the home page's workspace panel. getCurrentWorkspace() checks the session itself
// (redirecting when signed out) and creates the workspace if the user owns none.
import { getCurrentWorkspace } from "@/server/workspace/current";
import { WorkspaceError } from "./workspace-error";

export async function WorkspaceSummary() {
  const result = await getCurrentWorkspace();
  if (!result.ok) return <WorkspaceError />;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">Workspace</p>
      <h2 className="text-xl font-medium break-words">{result.workspace.name}</h2>
      <p className="text-pretty text-zinc-700 dark:text-zinc-300">
        Projects arrive later in Milestone 1.
      </p>
    </div>
  );
}
