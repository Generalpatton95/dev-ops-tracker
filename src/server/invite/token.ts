// T-10 (REQ-3): invite link tokens. The link carries a random token; the database keeps only its
// SHA-256 hash (workspace.invite_token), so a database leak gives no working link. A token's
// format is checked before hashing, so anything that can't be one costs no query.
import { createHash, randomBytes } from "node:crypto";

export const INVITE_TOKEN_BYTES = 32;
// 32 bytes in base64url without padding is always 43 characters.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/** A new random token for an invite link. Shown to the owner once; never stored. */
export function newInviteToken(): string {
  return randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
}

/** Whether `value` has the shape of a token newInviteToken() makes. */
export function isInviteTokenFormat(value: unknown): value is string {
  return typeof value === "string" && TOKEN_FORMAT.test(value);
}

/** What the database stores and looks a token up by: its SHA-256, as 64 hex characters. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
