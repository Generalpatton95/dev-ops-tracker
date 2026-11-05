"use client";

// T-10 (REQ-3): the owner's invite link and members list, sharing whether a link is on. Removing
// a member turns the link off on the server (decided 2026-11-02), so the members list tells the
// invite panel, which then shows that no link is on.
import { useState } from "react";
import { InviteLinkPanel } from "./invite-link-panel";
import { MembersList } from "./members-list";

export function OwnerControls({ initiallyActive }: { initiallyActive: boolean }) {
  const [inviteActive, setInviteActive] = useState(initiallyActive);
  return (
    <>
      <InviteLinkPanel active={inviteActive} onActiveChange={setInviteActive} />
      <MembersList onRemoved={() => setInviteActive(false)} />
    </>
  );
}
