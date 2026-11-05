// T-9 (REQ-2): the settings page's panel, rendered to HTML: the owner gets the name form, anyone
// else a plain text, and a failure the fixed error text. T-10 (REQ-3): the owner also gets the
// invite link and members list; a member gets neither. The workspace lookup, the tRPC hooks and
// the router are stubbed; the real components render.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentWorkspaceResult } from "@/server/workspace/current";

vi.mock("server-only", () => ({}));

let result: CurrentWorkspaceResult;
let inviteState: { ok: true; active: boolean } | { ok: false };
const inviteStateCalls: string[] = [];
vi.mock("@/server/workspace/current", () => ({
  getCurrentWorkspace: async () => result,
  getInviteLinkState: async (workspaceId: string) => {
    inviteStateCalls.push(workspaceId);
    return inviteState;
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
const never = (what: string) => ({
  mutationKey: [what],
  mutationFn: async () => expect.unreachable("nothing is submitted here"),
});
vi.mock("@/trpc/client", () => ({
  useTRPC: () => ({
    workspace: {
      rename: { mutationOptions: () => never("workspace.rename") },
      createInvite: { mutationOptions: () => never("workspace.createInvite") },
      disableInvite: { mutationOptions: () => never("workspace.disableInvite") },
      removeMember: { mutationOptions: () => never("workspace.removeMember") },
      members: {
        queryKey: () => ["workspace.members"],
        // Rendered on the server, a query only shows its loading state; nothing is fetched.
        queryOptions: () => ({
          queryKey: ["workspace.members"],
          queryFn: async () => expect.unreachable("not fetched during a server render"),
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
  inviteState = { ok: true, active: false };
  inviteStateCalls.length = 0;
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
    expect(html).toContain("Only its owner can rename it");
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

describe("REQ-3: invites and members on the settings page", () => {
  it("REQ-3: the owner with no link gets Make invite link, no Turn off, and the members section", async () => {
    const html = await render();
    expect(inviteStateCalls).toEqual([WS_ID]);
    expect(html).toContain("Invite link");
    expect(html).toMatch(/<button[^>]*>Make invite link<\/button>/);
    expect(html).not.toContain("Turn off link");
    expect(html).toContain("Members");
    expect(html).toContain("Loading members…");
  });

  it("REQ-3: with a link on, the owner can make a new one or turn it off, but never sees the old one", async () => {
    inviteState = { ok: true, active: true };
    const html = await render();
    expect(html).toMatch(/<button[^>]*>Make a new link<\/button>/);
    expect(html).toMatch(/<button[^>]*>Turn off link<\/button>/);
    // Only a hash is stored, so there is no link to show until a new one is made.
    expect(html).not.toContain("/invite/");
  });

  it("REQ-3: a member sees the workspace name but no invite or members controls, and nothing is asked", async () => {
    result = { ok: true, workspace: { id: WS_ID, name: "Team", role: "member" } };
    const html = await render();
    expect(html).toContain("You&#x27;re a member of");
    expect(html).not.toContain("Invite link");
    expect(html).not.toContain("Members");
    expect(html).not.toContain("<button");
    expect(inviteStateCalls).toEqual([]);
  });

  it("REQ-3: an invite state that can't be loaded shows a fixed error text instead of the controls", async () => {
    inviteState = { ok: false };
    const html = await render();
    expect(html).toContain("The invite link couldn&#x27;t be loaded");
    expect(html).not.toContain("Make invite link");
  });
});
