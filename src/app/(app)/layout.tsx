// T-8 (REQ-1): every page in this group needs a session. The header checks it on the server
// (and each page checks again, since a layout doesn't re-render on every navigation).
import { Suspense } from "react";
import { SignedInHeader, SignedInHeaderFallback } from "./signed-in-header";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={<SignedInHeaderFallback />}>
        <SignedInHeader />
      </Suspense>
      {children}
    </>
  );
}
