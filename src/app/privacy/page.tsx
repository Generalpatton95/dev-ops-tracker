// T-8 (REQ-1): what the app keeps, open to everyone and live before sign-in is. Keep it in step
// with specs/m1-skeleton.md ("User data from GitHub", "Sign-in") whenever either changes.
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy · Dev-ops-tracker" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-24 text-zinc-800 dark:text-zinc-200">
      <h1 className="text-3xl font-semibold tracking-tight">Privacy</h1>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">What we keep</h2>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            From your GitHub account: your GitHub user id, your name (or username) and the address
            of your avatar picture. GitHub shares these when you sign in.
          </li>
          <li>
            A session: a random token in a cookie on your device, and a matching row on our side
            with your user id and when it expires. A session ends when you sign out or 30 days after
            you sign in, whichever comes first. Signing out deletes that device&apos;s session row;
            expired ones are deleted as the site handles later requests.
          </li>
          <li>
            A few short-lived cookies Auth.js uses while you sign in, to protect the sign-in from
            forgery.
          </li>
          <li>
            For rate limiting: sign-in requests and app calls made while signed out are counted per
            IP address for one minute at a time (IPv6 addresses per /64 network, the block of
            addresses one connection is usually given, rather than one by one). We store a keyed
            hash of the address, never the address itself, with that count. Each one is kept for
            about a day after your last request, then deleted as the site handles later requests.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">What we don&apos;t keep</h2>
        <ul className="list-disc space-y-1 pl-6">
          <li>No email address.</li>
          <li>
            No GitHub access tokens: the one GitHub issues at sign-in is used only during sign-in to
            read your profile, then dropped.
          </li>
          <li>No analytics or tracking, and no third-party scripts, fonts or images.</li>
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Where it lives</h2>
        <p>
          The app is hosted on Vercel and its database on Neon, both in the United States (US East).
        </p>
      </section>

      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        <Link href="/sign-in" className="underline underline-offset-2">
          Back to sign-in
        </Link>
      </p>
    </main>
  );
}
