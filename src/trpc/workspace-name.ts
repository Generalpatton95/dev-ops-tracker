// T-9 (REQ-2): the workspace name rule, shared by the server's Zod schema and the settings form's
// hint so they agree. Plain functions only: no Zod and nothing from src/server, so the browser
// bundle stays small.

export const WORKSPACE_NAME_MAX = 50;

// Control characters (NUL included, which Postgres text can't hold, and line breaks) and the
// bidi embedding, override and isolate controls, which can make a name display as other text.
const FORBIDDEN = /[\p{Cc}‪-‮⁦-⁩]/u;
const FORBIDDEN_ALL = /[\p{Cc}‪-‮⁦-⁩]/gu;

/** Length in code points, so an emoji counts as one character, not two UTF-16 units. */
export function nameLength(value: string): number {
  return Array.from(value).length;
}

/** Whether the text holds a control or bidi control character. */
export function hasForbiddenCharacter(value: string): boolean {
  return FORBIDDEN.test(value);
}

/** The text with every control and bidi control character replaced by a space. */
export function withoutForbiddenCharacters(value: string): string {
  return value.replace(FORBIDDEN_ALL, " ");
}

/**
 * What is wrong with an already trimmed name, or null when it is fine: 1 to WORKSPACE_NAME_MAX
 * code points, with no control or bidi control characters.
 */
export function workspaceNameProblem(trimmed: string): string | null {
  if (trimmed.length === 0) return "Enter a name.";
  if (nameLength(trimmed) > WORKSPACE_NAME_MAX) {
    return `Use ${WORKSPACE_NAME_MAX} characters or fewer.`;
  }
  if (hasForbiddenCharacter(trimmed)) {
    return "Remove line breaks and other control characters.";
  }
  return null;
}
