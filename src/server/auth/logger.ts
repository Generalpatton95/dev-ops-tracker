// T-8 (REQ-1): Auth.js's own logger prints error messages, causes and stack traces, which can
// carry query values (Drizzle), profile data or tokens. This one records the error's type and
// code only, warnings by their fixed code, and never debug output.
import { errorLabel } from "@/server/log-label";

export const authLogger = {
  error(error: Error) {
    console.error(`[auth] ${errorLabel(error)}`);
  },
  warn(code: string) {
    console.warn(
      `[auth] warning ${String(code)
        .replace(/[^\w.-]/g, "?")
        .slice(0, 64)}`,
    );
  },
  debug() {},
};
