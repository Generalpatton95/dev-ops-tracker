// T-9 (REQ-2): the settings form's states: hint, saving, "Saved.", failures, and edits clearing
// them. Pure functions; the rendered form is checked in workspace-settings.test.tsx.
import { describe, expect, it } from "vitest";
import {
  characterCount,
  initialNameFormState,
  nameFormReducer,
  nameToSave,
  renameFailureMessage,
  type NameFormAction,
  type NameFormState,
} from "./name-form-state";

function run(state: NameFormState, ...actions: NameFormAction[]): NameFormState {
  return actions.reduce(nameFormReducer, state);
}

const start = initialNameFormState("Ada's workspace");

describe("REQ-2: settings form state", () => {
  it("REQ-2: starts idle with the current name", () => {
    expect(start).toEqual({ value: "Ada's workspace", status: { kind: "idle" } });
  });

  it("REQ-2: a valid submit moves to saving and sends the trimmed name", () => {
    const saving = run(start, { type: "edit", value: "  Ops  " }, { type: "submit" });
    expect(saving.status).toEqual({ kind: "saving" });
    expect(nameToSave(saving)).toBe("Ops");
    // A second submit while saving changes nothing.
    expect(nameFormReducer(saving, { type: "submit" })).toBe(saving);
  });

  it('REQ-2: a successful save shows "Saved." with the name the server kept', () => {
    const saved = run(start, { type: "submit" }, { type: "saved", name: "Ops" });
    expect(saved).toEqual({ value: "Ops", status: { kind: "saved" } });
  });

  it("REQ-2: an invalid name shows the hint and sends nothing", () => {
    for (const [value, message] of [
      ["   ", "Enter a name."],
      ["a".repeat(51), "Use 50 characters or fewer."],
      ["Ops\u0000", "Remove line breaks and other control characters."],
      ["Ops\nTeam", "Remove line breaks and other control characters."],
      ["‮evil", "Remove line breaks and other control characters."],
    ] as const) {
      const state = run(start, { type: "edit", value }, { type: "submit" });
      expect(state.status, JSON.stringify(value)).toEqual({ kind: "error", message });
    }
  });

  it("REQ-2: a failed save shows a fixed text for its code", () => {
    const failed = run(start, { type: "submit" }, { type: "failed", code: "NOT_FOUND" });
    expect(failed.status).toEqual({
      kind: "error",
      message: "This workspace can't be renamed by you.",
    });
    expect(renameFailureMessage("BAD_REQUEST")).toMatch(/^Use 1 to 50 characters/);
    expect(renameFailureMessage("UNAUTHORIZED")).toMatch(/Sign in again/);
    expect(renameFailureMessage("INTERNAL_SERVER_ERROR")).toBe("Couldn't save. Try again.");
    expect(renameFailureMessage(undefined)).toBe("Couldn't save. Try again.");
  });

  it('REQ-2: editing clears an error, a hint or "Saved."', () => {
    const failed = run(
      start,
      { type: "submit" },
      { type: "failed", code: "INTERNAL_SERVER_ERROR" },
    );
    expect(nameFormReducer(failed, { type: "edit", value: "Ops" }).status).toEqual({
      kind: "idle",
    });
    const hinted = run(start, { type: "edit", value: "" }, { type: "submit" });
    expect(nameFormReducer(hinted, { type: "edit", value: "O" }).status).toEqual({ kind: "idle" });
    const saved = run(start, { type: "submit" }, { type: "saved", name: "Ops" });
    expect(nameFormReducer(saved, { type: "edit", value: "Ops2" }).status).toEqual({
      kind: "idle",
    });
  });

  it("REQ-2: the counter counts the trimmed name in code points", () => {
    expect(characterCount("  Ops ")).toBe("3 of 50 characters");
    expect(characterCount("\u{1F600}\u{1F600}")).toBe("2 of 50 characters");
  });
});

describe("REQ-2: the settings form's browser code", () => {
  it("REQ-2: imports neither Zod nor anything from src/server", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of [
      "./workspace-name-form.tsx",
      "./name-form-state.ts",
      "../../../trpc/workspace-name.ts",
    ]) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      // The shared rule module imports nothing; the others must have been read.
      if (!file.includes("trpc")) expect(imports.length, file).toBeGreaterThan(0);
      for (const name of imports) {
        expect(name, file).not.toMatch(/^zod($|\/)/);
        expect(name, file).not.toMatch(/^@\/server\//);
      }
    }
  });
});
