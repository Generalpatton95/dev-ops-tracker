// T-8 (REQ-1): small pieces of the sign-in UI that decide what the browser does.
import { describe, expect, it } from "vitest";
import { initials } from "@/app/(app)/initials";
import { isAllowedDestination } from "@/app/auth-buttons";

const ORIGIN = "https://dot.example";

describe("REQ-1: sign-in UI", () => {
  it("REQ-1: after sign-in or sign-out the browser goes only to this site or GitHub's authorize page", () => {
    const github = "https://github.com/login/oauth/authorize?client_id=x&scope=read%3Auser";
    expect(isAllowedDestination(github, ORIGIN, true)).toBe(true);
    expect(isAllowedDestination(github, ORIGIN, false)).toBe(false);
    expect(isAllowedDestination(`${ORIGIN}/sign-in`, ORIGIN, false)).toBe(true);
    expect(isAllowedDestination("/sign-in", ORIGIN, false)).toBe(true);
    for (const url of [
      "https://evil.example/login/oauth/authorize",
      "https://github.com/evil",
      "https://github.com.evil.example/login/oauth/authorize",
      "javascript:alert(1)",
      "//evil.example",
    ]) {
      expect(isAllowedDestination(url, ORIGIN, true), url).toBe(false);
    }
  });

  it("REQ-1: the signed-in header shows up to two initials from the name", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("octocat")).toBe("O");
    expect(initials("  grace  brewster murray hopper ")).toBe("GB");
    expect(initials("élodie ñuñez")).toBe("ÉÑ");
    expect(initials("")).toBe("?");
  });
});
