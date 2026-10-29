import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { getCurrentSession } from "@/server/auth";
import { getDb } from "@/server/db";
import { checkRateLimit, rateLimitResponse } from "@/server/rate-limit";
import { appRouter } from "@/server/routers/_app";
import { createTRPCContext } from "@/server/trpc";
import { MAX_BATCH_SIZE, MAX_BODY_BYTES } from "@/trpc/limits";

const ENDPOINT = "/api/trpc";

// How many procedure calls the request holds, counted the way tRPC reads it: the path is
// URL-decoded first (so "a%2Cb" is two calls) and split on "," only for ?batch=1 requests.
// A path that can't be decoded counts as an oversized batch.
function callCount(req: Request): number {
  const url = new URL(req.url);
  if (url.searchParams.get("batch") !== "1") return 1;
  const raw = url.pathname.startsWith(`${ENDPOINT}/`)
    ? url.pathname.slice(ENDPOINT.length + 1)
    : "";
  let paths: string;
  try {
    paths = decodeURIComponent(raw);
  } catch {
    return MAX_BATCH_SIZE + 1;
  }
  return Math.min(paths.split(",").length, MAX_BATCH_SIZE + 1);
}

async function handler(req: Request) {
  if (req.method === "POST") {
    // The fetch adapter has no body limit, so refuse oversized or unsized bodies up front.
    const header = req.headers.get("content-length");
    if (header === null) return new Response(null, { status: 411 });
    const length = Number(header);
    if (!Number.isInteger(length) || length < 0) return new Response(null, { status: 400 });
    if (length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  }

  // T-8 (REQ-1): who is asking is decided here, on the server, from the session cookie.
  const session = await getCurrentSession();
  if (!session) {
    // Signed-out calls are public, so they are rate-limited per IP, failing closed.
    const limited = await checkRateLimit({
      bucket: "trpc-public",
      headers: req.headers,
      cost: callCount(req),
    });
    if (!limited.ok) return rateLimitResponse(limited.status);
  }

  return fetchRequestHandler({
    endpoint: ENDPOINT,
    req,
    router: appRouter,
    createContext: () => createTRPCContext({ session, db: getDb }),
    maxBatchSize: MAX_BATCH_SIZE,
    onError({ path, error }) {
      // The path comes from the URL, so strip it to safe characters and cap it: no forged log lines.
      const safePath = (path ?? "").replace(/[^\w.,]/g, "?").slice(0, 64);
      console.error(`tRPC ${error.code} on ${safePath || "<no path>"}`);
    },
  });
}

export { handler as GET, handler as POST };
