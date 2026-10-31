// T-9 (REQ-2): the settings page's workspace panel. getCurrentWorkspace() checks the session on
// the server (redirecting when signed out) and creates the workspace if the user owns none.
import { getCurrentWorkspace } from "@/server/workspace/current";
import { WorkspaceError } from "../workspace-error";
import { WorkspaceNameForm } from "./workspace-name-form";

export async function WorkspaceSettings() {
  const result = await getCurrentWorkspace();
  if (!result.ok) return <WorkspaceError />;
  const { workspace } = result;
  if (workspace.role !== "owner") {
    return (
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        Only the owner can rename <span className="font-medium">{workspace.name}</span>.
      </p>
    );
  }
  return <WorkspaceNameForm workspaceId={workspace.id} initialName={workspace.name} />;
}
