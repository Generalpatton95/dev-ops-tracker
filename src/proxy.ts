// T-8 (REQ-1): signed-out visits to app pages go to the sign-in page, carrying only a validated
// same-site path to come back to. This is a fast first check on the cookie's presence; pages,
// layouts and tRPC look the session up in the database themselves, so the proxy is never the
// only check (a stale or forged cookie gets past here and is caught there).
import { NextResponse, type NextRequest } from "next/server";
import { RETURN_PATH_HEADER, signedOutRedirect } from "@/server/auth/gate";
import { safeReturnPath } from "@/server/auth/return-path";

export function proxy(request: NextRequest) {
  const target = signedOutRedirect(request.nextUrl, (name) =>
    Boolean(request.cookies.get(name)?.value),
  );
  if (target === null) {
    // Tell the page's layout which page this is (see RETURN_PATH_HEADER); any value the client
    // sent is replaced.
    const headers = new Headers(request.headers);
    const { pathname, search } = request.nextUrl;
    headers.set(RETURN_PATH_HEADER, safeReturnPath(`${pathname}${search}`));
    return NextResponse.next({ request: { headers } });
  }
  return NextResponse.redirect(new URL(target, request.nextUrl.origin));
}

export const config = {
  // Every page. API routes check sessions themselves (tRPC answers UNAUTHORIZED rather than
  // redirecting), and Next's static files and the favicon need no session.
  matcher: ["/((?!api/|_next/static/|_next/image|favicon\\.ico$).*)"],
};
