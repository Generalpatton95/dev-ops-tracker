// T-9 (REQ-2): the settings form's state, as a pure reducer so each state can be tested without a
// browser. Shared rules come from src/trpc/workspace-name.ts; nothing from src/server.
import { WORKSPACE_NAME_MAX, nameLength, workspaceNameProblem } from "@/trpc/workspace-name";

export type NameFormStatus =
  { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

export type NameFormState = { value: string; status: NameFormStatus };

export type NameFormAction =
  | { type: "edit"; value: string }
  | { type: "submit" }
  | { type: "saved"; name: string }
  | { type: "failed"; code: string | undefined };

/** The text shown for a failed save, from the tRPC error code only (never the server's text). */
export function renameFailureMessage(code: string | undefined): string {
  switch (code) {
    case "BAD_REQUEST":
      return `Use 1 to ${WORKSPACE_NAME_MAX} characters, with no line breaks or control characters.`;
    case "UNAUTHORIZED":
      return "Your session has ended. Sign in again, then save.";
    case "NOT_FOUND":
      return "This workspace can't be renamed by you.";
    default:
      return "Couldn't save. Try again.";
  }
}

export function initialNameFormState(name: string): NameFormState {
  return { value: name, status: { kind: "idle" } };
}

export function nameFormReducer(state: NameFormState, action: NameFormAction): NameFormState {
  switch (action.type) {
    case "edit":
      // Editing clears any hint, error or "Saved." from before.
      return { value: action.value, status: { kind: "idle" } };
    case "submit": {
      if (state.status.kind === "saving") return state;
      const problem = workspaceNameProblem(state.value.trim());
      if (problem) return { ...state, status: { kind: "error", message: problem } };
      return { ...state, status: { kind: "saving" } };
    }
    case "saved":
      return { value: action.name, status: { kind: "saved" } };
    case "failed":
      return { ...state, status: { kind: "error", message: renameFailureMessage(action.code) } };
  }
}

/** The name to send once a submit has moved the form to "saving". */
export function nameToSave(state: NameFormState): string {
  return state.value.trim();
}

/** "n of 50 characters", counting the trimmed name in code points like the server does. */
export function characterCount(value: string): string {
  return `${nameLength(value.trim())} of ${WORKSPACE_NAME_MAX} characters`;
}
