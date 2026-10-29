// T-9 (REQ-2): the signed-in header ensures the workspace on every app page, and the home page
// shows its name as text (or a fixed error text). The session and workspace are stubbed here.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentWorkspaceResult } from "@/server/workspace/current";

vi.mock("server-only", () => ({}));

vi.mock("@/server/auth", () => ({
  requireSession: async () => ({ user: { id: "user-1", name: "Ada" }, expires: "2099-01-01" }),
}));
let result: CurrentWorkspaceResult;
let calls = 0;
vi.mock("@/server/workspace/current", () => ({
  getCurrentWorkspace: async () => {
    calls++;
    return result;
  },
}));

const { SignedInHeader } = await import("./signed-in-header");
const { WorkspaceSummary } = await import("./workspace-summary");

beforeEach(() => {
  calls = 0;
  result = { ok: true, workspace: { id: "ws-1", name: "Ada's workspace", role: "owner" } };
});

describe("REQ-2: workspace on signed-in pages", () => {
  it("REQ-2: the signed-in header (on every app page) ensures the user's workspace", async () => {
    await SignedInHeader();
    expect(calls).toBe(1);
  });

  it("REQ-2: the header still renders when the workspace can't be loaded", async () => {
    result = { ok: false };
    await expect(SignedInHeader()).resolves.toBeTruthy();
  });

  it("REQ-2: the home page shows the workspace name, rendered as text", async () => {
    result = {
      ok: true,
      workspace: { id: "ws-1", name: '<img src="https://evil.example/x">', role: "owner" },
    };
    const html = renderToStaticMarkup(await WorkspaceSummary());
    expect(html).toContain("&lt;img src=&quot;https://evil.example/x&quot;&gt;");
    expect(html).not.toContain("<img");
  });

  it("REQ-2: the home page shows a fixed error text when the workspace can't be loaded", async () => {
    result = { ok: false };
    const html = renderToStaticMarkup(await WorkspaceSummary());
    expect(html).toContain('role="alert"');
    expect(html).toContain("couldn&#x27;t be loaded");
  });
});
