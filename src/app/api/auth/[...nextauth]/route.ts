// T-8 (REQ-1): Auth.js's endpoints, behind an allow-list, body cap and Postgres rate limit
// (see src/server/auth/route-handler.ts).
import { handlers } from "@/server/auth";
import { createAuthRouteHandler } from "@/server/auth/route-handler";

const handler = createAuthRouteHandler(handlers);

export { handler as GET, handler as POST };
