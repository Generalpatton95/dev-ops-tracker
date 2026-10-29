// T-9 (REQ-2): the server's check of a workspace name, and the name a new workspace gets. The
// rule itself lives in src/trpc/workspace-name.ts, shared with the settings form's hint.
import { z } from "zod";
import {
  WORKSPACE_NAME_MAX,
  nameLength,
  withoutForbiddenCharacters,
  workspaceNameProblem,
} from "@/trpc/workspace-name";

export { WORKSPACE_NAME_MAX, nameLength } from "@/trpc/workspace-name";

export const FALLBACK_WORKSPACE_NAME = "My workspace";
const DEFAULT_SUFFIX = "'s workspace";

/** Trimmed, then 1 to WORKSPACE_NAME_MAX code points, no control or bidi control characters. */
export const workspaceNameSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const problem = workspaceNameProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** The longest start of `value` that is whole grapheme clusters and at most `room` code points. */
function cutToGraphemes(value: string, room: number): string {
  let cut = "";
  let used = 0;
  for (const { segment } of graphemes.segment(value)) {
    const size = nameLength(segment);
    if (used + size > room) break;
    cut += segment;
    used += size;
  }
  return cut;
}

/**
 * "<name>'s workspace" from the user's (GitHub) name, or "My workspace" when nothing usable is
 * left. Control and bidi control characters become spaces first. The name is cut on whole
 * grapheme clusters (so an emoji sequence or an accent is never split) so the whole thing fits
 * WORKSPACE_NAME_MAX code points.
 */
export function defaultWorkspaceName(userName: string | null | undefined): string {
  const name = withoutForbiddenCharacters(userName ?? "").trim();
  const room = WORKSPACE_NAME_MAX - nameLength(DEFAULT_SUFFIX);
  // Trimmed again so a cut that ends on a space doesn't leave "Ada  's workspace".
  const cut = cutToGraphemes(name, room).trimEnd();
  if (!cut) return FALLBACK_WORKSPACE_NAME;
  return `${cut}${DEFAULT_SUFFIX}`;
}
