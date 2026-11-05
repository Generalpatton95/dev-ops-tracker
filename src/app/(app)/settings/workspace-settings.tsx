// T-9 (REQ-2): the settings page's workspace panel. getCurrentWorkspace() checks the session on
// the server (redirecting when signed out) and creates the workspace if the user owns none.
// T-10 (REQ-3): it shows the current workspace. Its owner also gets the invite link and the
// members list; a member sees the name only. The server checks ownership again on every call.
import { getCurrentWorkspace, getInviteLinkState } from "@/server/workspace/current";
import { WorkspaceError } from "../workspace-error";
import { MembersList } from "./members-list";
import { OwnerControls } from "./owner-controls";
import { WorkspaceNameForm } from "./workspace-name-form";

export async function WorkspaceSettings() {
  const result = await getCurrentWorkspace();
  if (!result.ok) return <WorkspaceError />;
  const { workspace } = result;
  if (workspace.role !== "owner") {
    return (
      <p className="text-sm text-pretty text-zinc-700 dark:text-zinc-300">
        You&apos;re a member of <span className="font-medium break-words">{workspace.name}</span>.
        Only its owner can rename it, invite people or remove members.
      </p>
    );
  }
  const invite = await getInviteLinkState(workspace.id);
  // Keyed by workspace, so switching never carries one workspace's form state into another's.
  return (
    <div key={workspace.id} className="flex flex-col gap-10">
      <WorkspaceNameForm workspaceId={workspace.id} initialName={workspace.name} />
      {invite.ok ? (
        <OwnerControls initiallyActive={invite.active} />
      ) : (
        <>
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            The invite link couldn&apos;t be loaded right now. Reload the page to try again.
          </p>
          <MembersList />
        </>
      )}
    </div>
  );
}
