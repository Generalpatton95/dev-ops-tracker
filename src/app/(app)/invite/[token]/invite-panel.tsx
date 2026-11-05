// T-10 (REQ-3): what the invite page shows. previewInvite() checks the session on the server
// (redirecting to sign-in, and back here after, when signed out), counts the call in the invite
// rate limit and gives one neutral answer for any token that isn't working. The workspace name
// is rendered as text.
import { previewInvite } from "@/server/invite/page";
import { inviteProblemMessage } from "./invite-messages";
import { JoinButton } from "./join-button";

export async function InvitePanel({ token }: { token: string }) {
  const preview = await previewInvite(token);
  if (!preview.ok) {
    return (
      <>
        <h1 className="text-3xl font-semibold tracking-tight">Invite link</h1>
        <p role="alert" className="text-pretty text-zinc-700 dark:text-zinc-300">
          {inviteProblemMessage(preview.reason)}
        </p>
      </>
    );
  }
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight break-words">Join {preview.name}</h1>
      <p className="text-pretty text-zinc-700 dark:text-zinc-300">
        You&apos;ve been invited to this workspace. Its owner will see your GitHub name and when you
        joined.
      </p>
      <JoinButton token={token} />
    </>
  );
}
