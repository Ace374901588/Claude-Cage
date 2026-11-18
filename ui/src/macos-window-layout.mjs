export const macDesktopZoomKey = "cage-macos-desktop-zoom";
export const macBrowserZoomKey = "cage-macos-browser-zoom";

export function readDesktopZoom(storage, automatic, key) {
  try {
    const stored = storage.getItem(key) ?? (key === macBrowserZoomKey ? storage.getItem(macDesktopZoomKey) : null);
    if (automatic && (stored === null || stored === "auto")) return "auto";
    const value = Number(stored);
    return [0.75, 0.9, 1, 1.1, 1.25, 1.5].includes(value) ? value : automatic ? "auto" : 1;
  } catch { return automatic ? "auto" : 1; }
}

export function macWindowViewport({ width, height }, zoom) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const factor = typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    width: Math.min(2560, Math.max(320, Math.round(width / factor))),
    height: Math.min(1600, Math.max(240, Math.round(height / factor))),
  };
}

// Publish an initial size immediately, then settle native window/encoder
// changes after a drag instead of rebuilding them on every ResizeObserver tick.
export function observeMacWindowViewport(element, zoom, changed, {
  Observer = ResizeObserver, schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  let timer, disposed = false, previous;
  const publish = () => {
    timer = undefined;
    if (disposed) return;
    const next = macWindowViewport(element.getBoundingClientRect(), zoom);
    if (JSON.stringify(next) === previous) return;
    previous = JSON.stringify(next);
    changed(next);
  };
  const observer = new Observer(() => {
    cancel(timer);
    timer = schedule(publish, 120);
  });
  publish();
  observer.observe(element);
  return () => { disposed = true; cancel(timer); observer.disconnect(); };
}
