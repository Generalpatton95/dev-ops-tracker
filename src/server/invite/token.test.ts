// T-10 (REQ-3): invite tokens are 32 random bytes in base64url, and only their SHA-256 is kept.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashInviteToken, isInviteTokenFormat, newInviteToken } from "./token";

describe("REQ-3: invite link tokens", () => {
  it("REQ-3: a new token is 32 random bytes in base64url (43 characters), different every time", () => {
    const tokens = Array.from({ length: 50 }, () => newInviteToken());
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      expect(isInviteTokenFormat(token)).toBe(true);
    }
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("REQ-3: the stored value is the token's SHA-256 in hex, never the token", () => {
    const token = newInviteToken();
    const hash = hashInviteToken(token);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });

  it("REQ-3: anything that isn't a token's shape is refused before hashing", () => {
    const token = newInviteToken();
    for (const bad of [
      "",
      token.slice(1),
      `${token}A`,
      `${token.slice(0, 42)}=`,
      `${token.slice(0, 42)}+`,
      `${token.slice(0, 42)}/`,
      ` ${token.slice(1)}`,
      hashInviteToken(token),
      "' or 1=1 --",
      "x".repeat(10_000),
      null,
      42,
    ]) {
      expect(isInviteTokenFormat(bad), JSON.stringify(bad)?.slice(0, 50)).toBe(false);
    }
  });
});
