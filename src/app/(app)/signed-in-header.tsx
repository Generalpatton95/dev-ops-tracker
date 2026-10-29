// T-8 (REQ-1): the header on every signed-in page: initials, name and "Sign out". No avatar
// image yet, so pages still load nothing from outside hosts.
// T-9 (REQ-2): it also makes sure the user owns a workspace (so every signed-in page has one)
// and links to the settings page.
import Link from "next/link";
import { SignOutButton } from "@/app/auth-buttons";
import { requireSession } from "@/server/auth";
import { getCurrentWorkspace } from "@/server/workspace/current";
import { initials } from "./initials";

function HeaderFrame({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-zinc-200 px-6 dark:border-zinc-800">
      <Link href="/" className="font-semibold tracking-tight">
        Dev-ops-tracker
      </Link>
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
  // Creates the workspace if the user owns none. Cached per render, so the page's own call
  // reuses it; if it fails, the page shows the error state and the header still renders.
  await getCurrentWorkspace();
  return (
    <HeaderFrame>
      <div className="flex items-center gap-3">
        <Link href="/settings" className="text-sm underline-offset-2 hover:underline">
          Settings
        </Link>
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
