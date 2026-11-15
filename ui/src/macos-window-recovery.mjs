// Recovery is initiated by a rejected user gesture, never by a polling timer.
// Activating the signed guest app does not authorize replaying the old input.
export function createMacWindowRecovery({ request, active, onRecovered, onError }) {
  let pending = null, disposed = false;
  const live = () => !disposed && active();
  return {
    get pending() { return pending !== null; },
    recover() {
      if (!live()) return Promise.resolve(false);
      if (pending) return pending;
      pending = Promise.resolve().then(async () => {
        if (!live()) return false;
        await request("launch");
        if (!live()) return false;
        await onRecovered();
        return true;
      }).catch(error => {
        if (live()) onError(error);
        return false;
      }).finally(() => { pending = null; });
      return pending;
    },
    dispose() { disposed = true; },
  };
}
