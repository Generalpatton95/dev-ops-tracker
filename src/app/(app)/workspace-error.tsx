// T-9 (REQ-2): shown when the user's workspace couldn't be loaded or created. A fixed text only;
// the cause is logged on the server by code.
export function WorkspaceError() {
  return (
    <p role="alert" className="text-sm text-red-700 dark:text-red-400">
      Your workspace couldn&apos;t be loaded right now. Reload the page to try again.
    </p>
  );
}
