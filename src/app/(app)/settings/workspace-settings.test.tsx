// T-9 (REQ-2): the settings page's panel, rendered to HTML: the owner gets the name form, anyone
// else a plain text, and a failure the fixed error text. The workspace lookup, the tRPC hook and
// the router are stubbed; the real form component renders.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentWorkspaceResult } from "@/server/workspace/current";

vi.mock("server-only", () => ({}));

let result: CurrentWorkspaceResult;
vi.mock("@/server/workspace/current", () => ({ getCurrentWorkspace: async () => result }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/trpc/client", () => ({
  useTRPC: () => ({
    workspace: {
      rename: {
        mutationOptions: () => ({
          mutationKey: ["workspace.rename"],
          mutationFn: async () => expect.unreachable("nothing is submitted here"),
        }),
      },
    },
  }),
}));

const { WorkspaceSettings } = await import("./workspace-settings");

async function render(): Promise<string> {
  const element = await WorkspaceSettings();
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>,
  );
}

const WS_ID = "6f1c2f5e-8d1a-4a53-9a43-2b4c1f9e7a10";

beforeEach(() => {
  result = { ok: true, workspace: { id: WS_ID, name: "Ada's workspace", role: "owner" } };
});

describe("REQ-2: the settings page", () => {
  it("REQ-2: the owner gets the name field, filled with the current name, and Save", async () => {
    const html = await render();
    expect(html).toContain("Workspace name");
    expect(html).toMatch(/<input[^>]*value="Ada&#x27;s workspace"/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Save<\/button>/);
    expect(html).toContain("15 of 50 characters");
    expect(html).not.toContain('role="alert"');
  });

  it("REQ-2: the name is rendered as text in the field", async () => {
    result = { ok: true, workspace: { id: WS_ID, name: '"><img src=x>', role: "owner" } };
    const html = await render();
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;&gt;&lt;img src=x&gt;");
  });

  it("REQ-2: someone who isn't the owner sees the name as text and no form", async () => {
    result = { ok: true, workspace: { id: WS_ID, name: "<b>Team</b>", role: "member" } };
    const html = await render();
    expect(html).toContain("Only the owner can rename");
    expect(html).toContain("&lt;b&gt;Team&lt;/b&gt;");
    expect(html).not.toContain("<form");
  });

  it("REQ-2: a workspace that can't be loaded shows the fixed error text", async () => {
    result = { ok: false };
    const html = await render();
    expect(html).toContain('role="alert"');
    expect(html).toContain("couldn&#x27;t be loaded");
    expect(html).not.toContain("<form");
  });
});
