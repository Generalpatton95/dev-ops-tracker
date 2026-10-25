// T-8 (REQ-1): the header on every signed-in page: initials, name and "Sign out". No avatar
// image yet, so pages still load nothing from outside hosts.
import { SignOutButton } from "@/app/auth-buttons";
import { requireSession } from "@/server/auth";
import { initials } from "./initials";

function HeaderFrame({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-zinc-200 px-6 dark:border-zinc-800">
      <span className="font-semibold tracking-tight">Dev-ops-tracker</span>
      {children}
    </header>
  );
}

export function SignedInHeaderFallback() {
  return <HeaderFrame />;
}

export async function SignedInHeader() {
  // A layout doesn't know its page; requireSession() takes it from the proxy's header, so a
  // stale session's redirect keeps it.
  const { user } = await requireSession();
  return (
    <HeaderFrame>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-8 items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100"
        >
          {initials(user.name)}
        </span>
        <span className="text-sm">{user.name}</span>
        <SignOutButton />
      </div>
    </HeaderFrame>
  );
}
