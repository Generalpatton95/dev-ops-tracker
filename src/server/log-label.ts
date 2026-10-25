// T-8 (REQ-1): what the server may log about an error: its kind and code, never its message.
// Library and database errors carry query values, URLs or profile data in their messages, so
// only the name (or Auth.js's error type) and a short code from the cause chain are kept.

const SAFE = /[^\w.-]/g;
const MAX_PART = 64;

function clean(value: string): string {
  return value.replace(SAFE, "?").slice(0, MAX_PART);
}

function kindOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  // Auth.js errors have a fixed `type` (e.g. "OAuthCallbackError"), which survives minifying.
  if ("type" in error && typeof error.type === "string" && error.type) return error.type;
  if ("name" in error && typeof error.name === "string" && error.name) return error.name;
  return undefined;
}

// The first string `code` down the cause chain (e.g. a Postgres SQLSTATE such as 23514).
// Auth.js wraps the original error as `cause.err`, so that is followed too.
function codeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    if ("code" in current && typeof current.code === "string" && current.code) {
      return current.code;
    }
    const cause: unknown = "cause" in current ? current.cause : undefined;
    current =
      cause && typeof cause === "object" && "err" in cause && cause.err instanceof Error
        ? cause.err
        : cause;
  }
  return undefined;
}

/** e.g. `SessionTokenError (23514)`, or `Error` when nothing more is known. */
export function errorLabel(error: unknown): string {
  const kind = clean(kindOf(error) ?? "Error");
  const code = codeOf(error);
  return code ? `${kind} (${clean(code)})` : kind;
}
