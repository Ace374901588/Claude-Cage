import test from "node:test";
import assert from "node:assert/strict";
import { createMacWindowInput } from "./macos-window-input.mjs";

function fixture({ request, onWindowChanged } = {}) {
  let current = { pid: 23, window: 70, geometry: "geometry-1" }, visible = true;
  const calls = [], errors = [], captured = new Set(), eventWindow = new EventTarget();
  const element = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ left: 20, top: 30, width: 400, height: 300 }),
    setPointerCapture: id => captured.add(id),
    hasPointerCapture: id => captured.has(id),
    releasePointerCapture(id) {
      captured.delete(id);
      element.dispatchEvent(new Event("lostpointercapture"));
    },
  });
  const input = createMacWindowInput({
    element, frame: () => current, active: () => visible,
    request: async (action, fields) => { calls.push({ action, ...fields }); return request ? request(action, fields) : { ok: true }; },
    onError: error => errors.push(error), onWindowChanged, eventWindow,
  });
  input.setKeyboardTarget({ focus() {}, classList: { add() {} } });
  const pointer = (type, fields = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, {
      pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1,
      clientX: 120, clientY: 105, detail: 1,
      shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...fields,
    });
    element.dispatchEvent(event);
    return event;
  };
  return { input, calls, errors, captured, eventWindow, element, pointer,
    changeTarget: () => { current = { ...current, geometry: "geometry-2" }; },
    hide: () => { visible = false; },
  };
}

test("native window drag preserves down/move/up and coalesces only adjacent moves", async () => {
  const f = fixture();
  let release;
  const gate = f.input.run(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  try {
    assert.equal(f.pointer("pointerdown").defaultPrevented, true);
    f.pointer("pointermove", { clientX: 180 });
    f.pointer("pointermove", { clientX: 300 });
    f.pointer("pointerdown", { pointerId: 2 });
    f.pointer("pointerup", { clientX: 900, clientY: -40 });
    release();
    await gate;
    await f.input.run(() => {});
    assert.deepEqual(f.calls.map(call => call.phase), ["down", "move", "up"]);
    assert.deepEqual(f.calls.map(call => call.x), [0.25, 0.7, 1 - Number.EPSILON]);
    assert.equal(f.calls[2].y, 0);
    assert(f.calls.every(call => call.pid === 23 && call.window === 70 && call.geometry === "geometry-1"));
    assert.equal(f.captured.size, 0);
    assert.deepEqual(f.errors, []);
  } finally { f.input.dispose(); }
});

test("native window forwards right button, double click and horizontal scroll", async () => {
  const f = fixture();
  try {
    f.pointer("pointerdown", { button: 2, buttons: 2 });
    f.pointer("pointerup", { button: 2 });
    f.pointer("pointerdown", { detail: 2 });
    f.pointer("pointerup", { detail: 2 });
    f.pointer("wheel", { deltaX: 54, deltaY: -2000 });
    await f.input.run(() => {});
    assert.deepEqual(f.calls.slice(0, 4).map(call => [call.phase, call.button, call.clicks]), [
      ["down", 2, 1], ["up", 2, 1], ["down", 0, 2], ["up", 0, 2],
    ]);
    assert.equal(f.calls[4].deltaX, 54);
    assert.equal(f.calls[4].delta, -1200);
    assert.equal(f.pointer("contextmenu").defaultPrevented, true);
  } finally { f.input.dispose(); }
});

test("a trackpad burst coalesces pending distance without overflowing the input queue", async () => {
  const f = fixture();
  let release;
  const gate = f.input.run(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  try {
    for (let i = 0; i < 240; i++) f.pointer("wheel", { deltaX: 0.125, deltaY: 0.25 });
    release(); await gate; await f.input.run(() => {});
    const scroll = f.calls.filter(call => call.action === "scroll");
    assert.equal(scroll.length, 1);
    assert.equal(scroll[0].deltaX, 30);
    assert.equal(scroll[0].delta, 60);
    assert.deepEqual(f.errors, []);
  } finally { f.input.dispose(); }
});

test("in-flight scroll keeps only a coalesced successor and bounds obsolete queued distance", async () => {
  let acknowledge;
  const f = fixture({ request: async action => {
    if (action === "scroll" && !acknowledge) await new Promise(resolve => { acknowledge = resolve; });
    return { ok: true };
  } });
  try {
    f.pointer("wheel", { deltaY: 12, deltaX: 0 });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(typeof acknowledge, "function");
    for (let i = 0; i < 240; i++) f.pointer("wheel", { deltaY: 120, deltaX: 0 });
    acknowledge(); await f.input.run(() => {});
    const scroll = f.calls.filter(call => call.action === "scroll");
    assert.equal(scroll.length, 5);
    assert.deepEqual(scroll.map(call => call.delta), [12, 1200, 1200, 1200, 1200]);
    assert.deepEqual(f.errors, []);
  } finally { f.input.dispose(); }
});

test("wheel units are normalized and fractional distances survive forwarding", async () => {
  const f = fixture();
  try {
    for (const [deltaY, deltaMode, expected] of [[0.25, 0, 0.25], [3, 1, 48], [1, 2, 300]]) {
      f.pointer("wheel", { deltaX: 0, deltaY, deltaMode });
      await f.input.run(() => {});
      assert.equal(f.calls.at(-1).delta, expected);
    }
    const count = f.calls.length;
    for (const deltaY of [NaN, Infinity, 0]) f.pointer("wheel", { deltaX: 0, deltaY });
    await f.input.run(() => {});
    assert.equal(f.calls.length, count);
  } finally { f.input.dispose(); }
});

test("wheel coalescing does not cross keys, cursor targets or changed modifiers", async () => {
  const f = fixture();
  let release;
  const gate = f.input.run(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  try {
    for (let i = 0; i < 4; i++) f.pointer("wheel", { deltaX: 0, deltaY: 0.25 });
    f.input.sendKey(97, "KeyA", true);
    f.pointer("wheel", { deltaX: 0, deltaY: 2 });
    f.pointer("wheel", { clientX: 220, deltaX: 0, deltaY: 3 });
    f.pointer("wheel", { clientX: 220, shiftKey: true, deltaX: 0, deltaY: 4 });
    release(); await gate; await f.input.run(() => {});
    assert.deepEqual(f.calls.map(call => call.action), ["scroll", "key", "scroll", "scroll", "scroll"]);
    assert.deepEqual(f.calls.filter(call => call.action === "scroll").map(call => call.delta), [1, 2, 3, 4]);
    assert.equal(f.calls[2].x, 0.25);
    assert.equal(f.calls[3].x, 0.5);
    assert.equal(f.calls[4].shift, true);
  } finally { f.input.dispose(); }
});

test("a resized window discards queued wheel motion without replaying it", async () => {
  const f = fixture();
  let release;
  const gate = f.input.run(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  try {
    f.pointer("wheel", { deltaX: 0, deltaY: 20 });
    f.changeTarget();
    const drained = f.input.run(() => {});
    release(); await gate;
    await assert.rejects(drained, { code: "window_changed" });
    assert.equal(f.calls.some(call => call.action === "scroll"), false);
    f.pointer("wheel", { deltaX: 0, deltaY: 10 });
    await f.input.run(() => {});
    assert.equal(f.calls.at(-1).geometry, "geometry-2");
    assert.equal(f.calls.at(-1).delta, 10);
  } finally { f.input.dispose(); }
});

test("losing host focus cancels unsent trackpad distance", async () => {
  const f = fixture();
  let release;
  const gate = f.input.run(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  try {
    f.pointer("wheel", { deltaX: 0, deltaY: 20 });
    f.eventWindow.dispatchEvent(new Event("blur"));
    release(); await gate; await f.input.run(() => {});
    assert.equal(f.calls.some(call => call.action === "scroll"), false);
    f.pointer("wheel", { deltaX: 0, deltaY: 10 });
    await f.input.run(() => {});
    assert.equal(f.calls.at(-1).delta, 10);
  } finally { f.input.dispose(); }
});

test("cancelled pointer capture resets held input before new keys", async () => {
  const f = fixture();
  try {
    f.input.sendKey(0xffeb, "MetaLeft", true);
    f.pointer("pointerdown");
    f.pointer("pointercancel");
    f.input.sendKey(97, "KeyA", true);
    await f.input.run(() => {});
    assert.equal(f.captured.size, 0);
    assert.deepEqual(f.calls.map(call => call.action), ["key", "pointer", "input-reset", "key"]);
    assert.equal(f.calls.at(-1).command, false);
  } finally { f.input.dispose(); }
});

test("queued native paste sends its chord before a following Enter", async () => {
  const f = fixture();
  let release;
  const clipboard = new Promise(resolve => { release = resolve; });
  try {
    const paste = f.input.runKeyAction(async sendKey => {
      await clipboard;
      for (const key of [[0xffeb, "MetaLeft", true], [118, "KeyV", true], [118, "KeyV", false], [0xffeb, "MetaLeft", false]])
        await sendKey(...key);
    });
    f.input.sendKey(0xff0d, "Enter", true);
    f.input.sendKey(0xff0d, "Enter", false);
    await Promise.resolve();
    assert.deepEqual(f.calls, []);
    release();
    await paste;
    await f.input.run(() => {});
    assert.deepEqual(f.calls.map(call => [call.code, call.down]), [
      ["MetaLeft", true], ["KeyV", true], ["KeyV", false], ["MetaLeft", false], ["Enter", true], ["Enter", false],
    ]);
  } finally { f.input.dispose(); }
});

test("a failed paste cancels already queued Enter and recovers for new input", async () => {
  const f = fixture();
  let fail;
  const clipboard = new Promise((_, reject) => { fail = reject; });
  try {
    const paste = f.input.runKeyAction(async () => { await clipboard; });
    f.input.sendKey(0xff0d, "Enter", true);
    const drained = f.input.run(() => {});
    fail(new Error("fixture clipboard failed"));
    await assert.rejects(paste, /fixture clipboard failed/);
    await assert.rejects(drained, /fixture clipboard failed/);
    assert.deepEqual(f.calls.map(call => call.action), ["input-reset"]);
    f.input.sendKey(97, "KeyA", true);
    await f.input.run(() => {});
    assert.equal(f.calls.at(-1).code, "KeyA");
  } finally { f.input.dispose(); }
});

test("a frame change rejects queued input and disposal releases only its connection", async () => {
  const f = fixture();
  let release;
  const gate = f.input.run(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  f.input.sendKey(97, "KeyA", true);
  const drained = f.input.run(() => {});
  f.changeTarget();
  release();
  await gate;
  await assert.rejects(drained, { code: "window_changed" });
  assert.deepEqual(f.calls.map(call => call.action), ["input-reset"]);
  f.input.dispose();
  const count = f.calls.length;
  f.pointer("pointerdown");
  f.eventWindow.dispatchEvent(new Event("blur"));
  await assert.rejects(f.input.run(() => {}), /连接已关闭/);
  assert.equal(f.calls.length, count);
});

test("a rejected user click requests recovery after releasing input without replaying the click", async () => {
  const recovered = [];
  const f = fixture({
    request: async action => {
      if (action === "pointer") throw Object.assign(new Error("window changed"), { code: "window_changed" });
      return { ok: true };
    },
    onWindowChanged: () => recovered.push(f.calls.map(call => call.action)),
  });
  try {
    f.pointer("pointerdown");
    await assert.rejects(f.input.run(() => {}), /window changed/);
    assert.deepEqual(recovered, [["pointer", "input-reset"]]);
    assert.equal(f.calls.filter(call => call.action === "pointer").length, 1);
  } finally { f.input.dispose(); }
});

test("hover and unrelated failures never activate a background guest application", async () => {
  for (const [phase, code] of [["pointermove", "window_changed"], ["pointerdown", "identity_error"], ["pointerdown", "input_owned_by_another_view"]]) {
    let recovered = 0;
    const f = fixture({
      request: async action => {
        if (action === "pointer") throw Object.assign(new Error(code), { code });
        return { ok: true };
      },
      onWindowChanged: () => recovered++,
    });
    try {
      f.pointer(phase, { buttons: phase === "pointermove" ? 0 : 1 });
      if (phase === "pointermove") {
        await f.input.run(() => {});
        assert.deepEqual(f.errors, []);
      } else await assert.rejects(f.input.run(() => {}), new RegExp(code));
      assert.equal(recovered, 0);
    } finally { f.input.dispose(); }
  }
});

test("keyboard focus loss cancels the queued Enter and requests a fresh view once", async () => {
  let recovered = 0;
  const f = fixture({
    request: async action => {
      if (action === "key") throw Object.assign(new Error("window changed"), { code: "window_changed" });
      return { ok: true };
    },
    onWindowChanged: () => recovered++,
  });
  try {
    f.input.sendKey(97, "KeyA", true);
    f.input.sendKey(0xff0d, "Enter", true);
    await assert.rejects(f.input.run(() => {}), /window changed/);
    assert.equal(recovered, 1);
    assert.deepEqual(f.calls.map(call => call.action), ["key", "input-reset"]);
    assert.equal(f.calls[0].code, "KeyA");
  } finally { f.input.dispose(); }
});

test("text and active composition can recover, but passive IME status cannot", async () => {
  for (const [action, fields, expected] of [["text", { text: "fixture" }, 1], ["ime", { mode: "begin" }, 1], ["ime", { mode: "status" }, 0]]) {
    let recovered = 0;
    const f = fixture({
      request: async value => {
        if (value !== "input-reset") throw Object.assign(new Error("window changed"), { code: "window_changed" });
        return { ok: true };
      },
      onWindowChanged: () => recovered++,
    });
    try {
      await assert.rejects(f.input.send(action, fields), /window changed/);
      assert.equal(recovered, expected);
    } finally { f.input.dispose(); }
  }
});

test("stale hover resets input without raising a layout-changing error", async () => {
  const f = fixture();
  let release;
  const gate = f.input.run(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  f.pointer("pointermove", { buttons: 0 });
  const drained = f.input.run(() => {});
  f.changeTarget(); release(); await gate;
  await assert.rejects(drained, { code: "window_changed" });
  assert.deepEqual(f.calls.map(call => call.action), ["input-reset"]);
  assert.deepEqual(f.errors, []);
  f.input.sendKey(97, "KeyA", true); await f.input.run(() => {});
  assert.equal(f.calls.at(-1).geometry, "geometry-2");
  f.input.dispose();
});
