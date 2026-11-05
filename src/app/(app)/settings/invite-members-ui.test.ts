// T-10 (REQ-3): the settings page's invite and members helpers: the link is built from the
// browser's own origin (REQ-7, no host baked in), and failures are shown from codes only.
import { describe, expect, it } from "vitest";
import { inviteActionFailure, inviteUrl } from "./invite-link-panel";
import { joinedText, removedNotice, removeFailure, roleText } from "./members-list";

describe("REQ-3: invite link and members helpers", () => {
  it("REQ-3: the invite link is /invite/<token> on the origin the page was served from", () => {
    const token = "abcDEF0123456789_-abcDEF0123456789_-abcDEF0";
    expect(inviteUrl("https://tracker.example", token)).toBe(
      `https://tracker.example/invite/${token}`,
    );
    expect(inviteUrl("http://localhost:3000", "a/b?c")).toBe(
      "http://localhost:3000/invite/a%2Fb%3Fc",
    );
  });

  it("REQ-3: invite and removal failures map from the error code only", () => {
    expect(inviteActionFailure("NOT_FOUND")).toContain("Only the workspace's owner");
    expect(inviteActionFailure("UNAUTHORIZED")).toContain("Sign in again");
    expect(inviteActionFailure("INTERNAL_SERVER_ERROR")).toBe(
      "Couldn't update the invite link. Try again.",
    );
    expect(removeFailure("NOT_FOUND")).toContain("can't be removed");
    expect(removeFailure(undefined)).toBe("Couldn't remove them right now. Try again.");
  });

  it("REQ-3: after a removal the list says the invite link is off and a new one is needed", () => {
    expect(removedNotice("Ada")).toBe(
      "Removed Ada. The invite link is now off, so make a new one to invite anyone else.",
    );
  });

  it("REQ-3: each member shows a role and a join date", () => {
    expect(roleText("owner")).toBe("Owner");
    expect(roleText("member")).toBe("Member");
    expect(joinedText("2026-11-02T12:00:00.000Z", "en-GB")).toBe("Joined 2 Nov 2026");
    expect(joinedText("not a date")).toBe("");
  });
});
