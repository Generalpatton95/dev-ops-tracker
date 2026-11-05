// T-10 (REQ-3): the header's workspace switcher, rendered to HTML. It lists the workspaces it is
// given (as text), with the current one chosen; with only one, it shows just that name. The tRPC
// hook and the router are stubbed; nothing is switched here.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/trpc/client", () => ({
  useTRPC: () => ({
    workspace: {
      switch: {
        mutationOptions: () => ({
          mutationKey: ["workspace.switch"],
          mutationFn: async () => expect.unreachable("nothing is switched here"),
        }),
      },
    },
  }),
}));

const { WorkspaceSwitcher, switcherLabel } = await import("./workspace-switcher");

const OWN = { id: "6f1c2f5e-8d1a-4a53-9a43-2b4c1f9e7a10", name: "Ada's workspace", role: "owner" };
const TEAM = { id: "0b8e4c9a-3f2d-4e71-8c55-7d9a1e2f3b40", name: "<i>Team</i>", role: "member" };

function render(currentId: string, workspaces: (typeof OWN)[]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceSwitcher currentId={currentId} workspaces={workspaces} />
    </QueryClientProvider>,
  );
}

describe("REQ-3: the workspace switcher", () => {
  it("REQ-3: lists every workspace the user is in, with the current one selected", () => {
    const html = render(TEAM.id, [OWN, TEAM]);
    expect(html).toContain("<select");
    expect(html).toContain(`<option value="${OWN.id}">Ada&#x27;s workspace (yours)</option>`);
    expect(html).toMatch(new RegExp(`<option value="${TEAM.id}" selected="">`));
    expect(html).toContain("&lt;i&gt;Team&lt;/i&gt;");
    expect(html).not.toContain("<i>");
  });

  it("REQ-3: with one workspace there is nothing to switch to, so only its name shows", () => {
    const html = render(OWN.id, [OWN]);
    expect(html).not.toContain("<select");
    expect(html).toContain("Ada&#x27;s workspace");
  });

  it("REQ-3: the owned workspace is marked as yours", () => {
    expect(switcherLabel(OWN)).toBe("Ada's workspace (yours)");
    expect(switcherLabel(TEAM)).toBe("<i>Team</i>");
  });
});
