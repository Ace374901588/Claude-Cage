// Mark a launch complete only after the backend accepted it for this view.
// A rejected/obsolete attempt must remain retryable when networking recovers.
export async function launchMacAppWhenReady({ networkReady, installed, launched, isCurrent, launch }) {
  if (!networkReady || !installed || launched.current || !isCurrent()) return false;
  await launch();
  if (!isCurrent()) return false;
  launched.current = true;
  return true;
}
