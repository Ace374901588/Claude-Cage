import test from "node:test";
import assert from "node:assert/strict";
import { macDesktopZoomKey, readDesktopZoom, macWindowViewport, observeMacWindowViewport } from "./macos-window-layout.mjs";

test("Mac defaults to adaptive sizing without changing Windows/Linux preferences", () => {
  const values = new Map([["cage-desktop-zoom", "1.5"], ["cage-windows-desktop-zoom", "0.9"]]);
  const storage = { getItem: key => values.get(key) ?? null };
  assert.equal(readDesktopZoom(storage, true, macDesktopZoomKey), "auto");
  assert.equal(readDesktopZoom(storage, true, "cage-windows-desktop-zoom"), 0.9);
  assert.equal(readDesktopZoom(storage, false, "cage-desktop-zoom"), 1.5);
  values.set(macDesktopZoomKey, "1.25");
  assert.equal(readDesktopZoom(storage, true, macDesktopZoomKey), 1.25);
  values.set(macDesktopZoomKey, "invalid");
  assert.equal(readDesktopZoom(storage, true, macDesktopZoomKey), "auto");
  assert.equal(readDesktopZoom({ getItem() { throw Error(); } }, true, macDesktopZoomKey), "auto");
});

test("adaptive and manual zoom produce finite bounded guest dimensions", () => {
  assert.deepEqual(macWindowViewport({ width: 1180, height: 820 }, "auto"), { width: 1180, height: 820 });
  assert.deepEqual(macWindowViewport({ width: 1180, height: 820 }, 1.25), { width: 944, height: 656 });
  assert.deepEqual(macWindowViewport({ width: 5000, height: 3000 }, 0.75), { width: 2560, height: 1600 });
  assert.deepEqual(macWindowViewport({ width: 100, height: 100 }, 1.5), { width: 320, height: 240 });
  for (const width of [0, -1, NaN, Infinity]) assert.equal(macWindowViewport({ width, height: 500 }, "auto"), null);
});

test("rapid pane resizing publishes only the final size and cancels on unmount", () => {
  let dimensions = { width: 1100, height: 750 }, observe, pending;
  let disconnected = false;
  const values = [];
  const stop = observeMacWindowViewport({ getBoundingClientRect: () => dimensions }, "auto", value => values.push(value), {
    Observer: class { constructor(fn) { observe = fn; } observe() {} disconnect() { disconnected = true; } },
    schedule: fn => { pending = fn; return fn; }, cancel: id => { if (id === pending) pending = undefined; },
  });
  assert.deepEqual(values, [{ width: 1100, height: 750 }]);
  for (let width = 1000; width >= 600; width -= 10) { dimensions = { width, height: 650 }; observe(); }
  assert.equal(values.length, 1);
  pending();
  assert.deepEqual(values.at(-1), { width: 600, height: 650 });
  observe(); pending();
  assert.equal(values.length, 2, "identical dimensions must not restart capture");
  dimensions = { width: 0, height: 0 }; observe(); pending();
  assert.equal(values.at(-1), null, "a hidden pane must not retain an obsolete viewport");
  dimensions = { width: 800, height: 600 }; observe();
  const late = pending; stop(); late();
  assert.equal(values.length, 3);
  assert.equal(pending, undefined);
  assert.equal(disconnected, true);
});
