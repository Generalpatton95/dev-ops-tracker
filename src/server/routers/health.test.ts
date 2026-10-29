import { describe, expect, it } from "vitest";
import { appRouter } from "@/server/routers/_app";
import { createCallerFactory, createTRPCContext } from "@/server/trpc";

const createCaller = createCallerFactory(appRouter);

describe("health.ping", () => {
  it("reports ok", async () => {
    const caller = createCaller(await createTRPCContext());
    await expect(caller.health.ping()).resolves.toEqual({ status: "ok" });
  });

  it("REQ-1: stays public: it answers with no session", async () => {
    const caller = createCaller(await createTRPCContext({ session: null }));
    await expect(caller.health.ping()).resolves.toEqual({ status: "ok" });
  });
});
