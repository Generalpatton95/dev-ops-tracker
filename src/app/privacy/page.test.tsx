// T-10 (REQ-3): the privacy page says what invites add: the owner sees a member's name and join
// date, the current-workspace cookie (by the name production uses), and the per-account count
// of invite attempts.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SECURE_WORKSPACE_COOKIE, WORKSPACE_COOKIE_MAX_AGE } from "@/server/workspace/cookie";
import PrivacyPage from "./page";

const html = renderToStaticMarkup(<PrivacyPage />);

describe("REQ-3: the privacy page", () => {
  it("REQ-3: says a workspace's owner sees your GitHub name and when you joined", () => {
    expect(html).toContain("its owner sees your GitHub name and when you joined");
  });

  it("REQ-3: lists the current-workspace cookie by its production name, kept up to a year", () => {
    expect(html).toContain(SECURE_WORKSPACE_COOKIE);
    expect(WORKSPACE_COOKIE_MAX_AGE).toBe(365 * 24 * 60 * 60);
    expect(html).toContain("kept for up to a year");
  });

  it("REQ-3: says invite attempts are counted by a keyed hash of your user id", () => {
    expect(html).toContain("by a keyed hash of your user id");
  });
});
