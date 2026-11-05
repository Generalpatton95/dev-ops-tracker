// T-10 (REQ-3): the invite page's texts, chosen from a tRPC error code only (never the server's
// text). No Zod and nothing from src/server, so the browser bundle stays small.

// Kept in step with INVITE_NOT_WORKING in src/server/routers/invite.ts (a test checks it).
export const INVITE_NOT_WORKING = "This invite link isn't working. Ask the owner for a new one.";

export type InviteProblem = "not-working" | "too-many" | "unavailable" | "signed-out" | "failed";

export function inviteProblemFromCode(code: string | undefined): InviteProblem {
  switch (code) {
    case "NOT_FOUND":
      return "not-working";
    case "TOO_MANY_REQUESTS":
      return "too-many";
    case "SERVICE_UNAVAILABLE":
      return "unavailable";
    case "UNAUTHORIZED":
      return "signed-out";
    default:
      return "failed";
  }
}

export function inviteProblemMessage(problem: InviteProblem): string {
  switch (problem) {
    case "not-working":
      return INVITE_NOT_WORKING;
    case "too-many":
      return "Too many attempts. Wait a minute, then try again.";
    case "unavailable":
      return "Invites aren't available right now. Try again shortly.";
    case "signed-out":
      return "Your session has ended. Sign in again, then open the link.";
    case "failed":
      return "Couldn't join. Try again.";
  }
}
