import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { getCurrentSession } from "@/server/auth";
import { getDb } from "@/server/db";
import { checkRateLimit, limitUser, rateLimitResponse } from "@/server/rate-limit";
import { appRouter } from "@/server/routers/_app";
import { createTRPCContext } from "@/server/trpc";
import { workspaceCookieHeader, workspaceIdFromCookieHeader } from "@/server/workspace/cookie";
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

type BodyResult = { ok: true; body: Uint8Array<ArrayBuffer> } | { ok: false; status: 400 | 413 };

// T-10: reads the body counting bytes as they arrive, and stops reading (cancelling the stream)
// as soon as it passes MAX_BODY_BYTES, so a Content-Length that lies (or a host that doesn't
// check it) can't get a bigger body through. A body that doesn't match its declared length, or
// a stream that fails, is refused.
async function readCappedBody(req: Request, declared: number): Promise<BodyResult> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          return { ok: false, status: 413 };
        }
        chunks.push(value);
      }
    } catch {
      return { ok: false, status: 400 };
    }
  }
  if (total !== declared) return { ok: false, status: 400 };
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}

// T-10: only JSON POSTs. tRPC also parses multipart/form-data and application/octet-stream, which
// a plain cross-site <form> can send; refusing them means no form can reach a mutation (even a
// no-input one such as workspace.createInvite), with or without SameSite cookies. The browser
// client sends application/json on every POST. Parameters such as charset are allowed.
function isJson(contentType: string | null): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

async function handler(incoming: Request) {
  let req = incoming;
  let declaredLength = 0;
  if (req.method === "POST") {
    // These checks cost nothing, so they come before the session lookup and the limiter. The
    // fetch adapter has no body limit, so unsized or declared-oversized bodies are refused here.
    if (!isJson(req.headers.get("content-type"))) return new Response(null, { status: 415 });
    const header = req.headers.get("content-length");
    if (header === null) return new Response(null, { status: 411 });
    declaredLength = Number(header);
    if (!/^\d+$/.test(header.trim()) || !Number.isSafeInteger(declaredLength)) {
      return new Response(null, { status: 400 });
    }
    if (declaredLength > MAX_BODY_BYTES) return new Response(null, { status: 413 });
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

  if (req.method === "POST") {
    // Only now is the body read (after the limiter, so a caller over the limit uploads nothing
    // more), counting the bytes actually sent rather than trusting Content-Length.
    const read = await readCappedBody(req, declaredLength);
    if (!read.ok) return new Response(null, { status: read.status });
    // The same request with the body already read, for tRPC to parse.
    req = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: read.body,
      signal: req.signal,
    });
  }

  // T-10 (REQ-3): the current-workspace cookie, a preference the procedures check against the
  // caller's memberships before using.
  const workspaceCookie = workspaceIdFromCookieHeader(req.headers.get("cookie"), process.env);

  return fetchRequestHandler({
    endpoint: ENDPOINT,
    req,
    router: appRouter,
    createContext: ({ resHeaders }) =>
      createTRPCContext({
        session,
        db: getDb,
        workspaceCookie,
        setWorkspaceCookie: (workspaceId) =>
          resHeaders.append("set-cookie", workspaceCookieHeader(workspaceId)),
        limitUser,
      }),
    maxBatchSize: MAX_BATCH_SIZE,
    onError({ path, error }) {
      // The path comes from the URL, so strip it to safe characters and cap it: no forged log lines.
      const safePath = (path ?? "").replace(/[^\w.,]/g, "?").slice(0, 64);
      console.error(`tRPC ${error.code} on ${safePath || "<no path>"}`);
    },
  });
}

export { handler as GET, handler as POST };
