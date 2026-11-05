// T-10 (REQ-3): the invite page, rendered to HTML. Opening it only looks the invite up: it shows
// "Join <name>" (as text) and a Join button, and joining needs that button's POST. A token that
// isn't working gets the one neutral text. The lookup and the tRPC hook are stubbed.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INVITE_NOT_WORKING as SERVER_TEXT } from "@/server/routers/invite";
import type { InvitePreview } from "@/server/invite/page";

vi.mock("server-only", () => ({}));

let preview: InvitePreview;
const previewed: string[] = [];
vi.mock("@/server/invite/page", () => ({
  previewInvite: async (token: string) => {
    previewed.push(token);
    return preview;
  },
}));
vi.mock("@/trpc/client", () => ({
  useTRPC: () => ({
    invite: {
      join: {
        mutationOptions: () => ({
          mutationKey: ["invite.join"],
          mutationFn: async () => expect.unreachable("opening the page never joins"),
        }),
      },
    },
  }),
}));

const { InvitePanel } = await import("./invite-panel");
const { INVITE_NOT_WORKING, inviteProblemFromCode, inviteProblemMessage } =
  await import("./invite-messages");

const TOKEN = "A".repeat(43);

async function render(): Promise<string> {
  const element = await InvitePanel({ token: TOKEN });
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>,
  );
}

beforeEach(() => {
  previewed.length = 0;
  preview = { ok: true, name: "Platform team" };
});

describe("REQ-3: the invite page", () => {
  it('REQ-3: a working link shows "Join <workspace name>" and a Join button, without joining', async () => {
    const html = await render();
    expect(previewed).toEqual([TOKEN]);
    expect(html).toMatch(/<h1[^>]*>Join Platform team<\/h1>/);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Join<\/button>/);
    expect(html).toContain("owner will see your GitHub name and when you joined");
  });

  it("REQ-3: the workspace name is rendered as text", async () => {
    preview = { ok: true, name: '<img src="https://evil.example/x">' };
    const html = await render();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=&quot;https://evil.example/x&quot;&gt;");
  });

  it("REQ-3: a link that isn't working gets the neutral text and no Join button", async () => {
    preview = { ok: false, reason: "not-working" };
    const html = await render();
    expect(html).toContain("This invite link isn&#x27;t working. Ask the owner for a new one.");
    expect(html).not.toContain("<button");
  });

  it("REQ-3: over the rate limit or with the limiter down, the page says so, with no Join button", async () => {
    preview = { ok: false, reason: "too-many" };
    expect(await render()).toContain("Too many attempts");
    preview = { ok: false, reason: "unavailable" };
    const html = await render();
    expect(html).toContain("aren&#x27;t available right now");
    expect(html).not.toContain("<button");
  });

  it("REQ-3: the page's neutral text is the server's, and join errors map from codes only", () => {
    expect(INVITE_NOT_WORKING).toBe(SERVER_TEXT);
    expect(inviteProblemMessage(inviteProblemFromCode("NOT_FOUND"))).toBe(SERVER_TEXT);
    expect(inviteProblemFromCode("TOO_MANY_REQUESTS")).toBe("too-many");
    expect(inviteProblemFromCode("SERVICE_UNAVAILABLE")).toBe("unavailable");
    expect(inviteProblemFromCode("UNAUTHORIZED")).toBe("signed-out");
    expect(inviteProblemFromCode(undefined)).toBe("failed");
  });
});
