import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { describe, expect, it } from "vitest";
import { createTRPCContext, createTRPCRouter, publicProcedure } from "@/server/trpc";

const testRouter = createTRPCRouter({
  boom: publicProcedure.query(() => {
    throw new Error('relation "users" does not exist');
  }),
});

describe("error formatting", () => {
  it("hides the message of unexpected errors from the client", async () => {
    const res = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request("http://localhost/api/trpc/boom"),
      router: testRouter,
      createContext: createTRPCContext,
    });
    const body = await res.text();

    expect(res.status).toBe(500);
    expect(body).toContain("Internal server error");
    expect(body).not.toContain("relation");
    expect(body).not.toContain("stack");
  });
});
