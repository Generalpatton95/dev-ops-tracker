import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/routers/_app";
import { createTRPCContext } from "@/server/trpc";
import { MAX_BATCH_SIZE, MAX_BODY_BYTES } from "@/trpc/limits";

function handler(req: Request) {
  if (req.method === "POST") {
    // The fetch adapter has no body limit, so refuse oversized or unsized bodies up front.
    const header = req.headers.get("content-length");
    if (header === null) return new Response(null, { status: 411 });
    const length = Number(header);
    if (!Number.isInteger(length) || length < 0) return new Response(null, { status: 400 });
    if (length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  }

  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: createTRPCContext,
    maxBatchSize: MAX_BATCH_SIZE,
    onError({ path, error }) {
      // The path comes from the URL, so strip it to safe characters and cap it: no forged log lines.
      const safePath = (path ?? "").replace(/[^\w.,]/g, "?").slice(0, 64);
      console.error(`tRPC ${error.code} on ${safePath || "<no path>"}`);
    },
  });
}

export { handler as GET, handler as POST };
