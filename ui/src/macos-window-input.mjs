const identity = frame => frame && `${frame.pid}:${frame.window}:${frame.geometry || ""}`;
const staleWindow = () => Object.assign(new Error("输入窗口已变化，请重新操作"), { code: "window_changed" });
const modifiers = keys => ({
  shift: keys.has("ShiftLeft") || keys.has("ShiftRight"),
  control: keys.has("ControlLeft") || keys.has("ControlRight"),
  alt: keys.has("AltLeft") || keys.has("AltRight"),
  command: keys.has("MetaLeft") || keys.has("MetaRight"),
});

export function createMacWindowInput({ element, frame, active, request, onError, onWindowChanged, eventWindow = window }) {
  let keyboard, disposed = false, queued, pending = 0, move, wheel, drag, lastClick, resetSequence = 0;
  const keys = new Set(), listeners = [];
  const recoverable = new WeakSet();
  const requestInput = async (action, fields) => {
    try { return await request(action, fields); }
    catch (error) {
      if (error?.code === "window_changed" && action === "pointer" && fields.phase === "move" && !fields.buttons) {
        keys.clear();
        await request("input-reset").catch(() => {});
        return { available: false };
      }
      // Only a deliberate input gesture may reactivate the guest. Hover and
      // caret polling must never take focus from another application.
      if (error?.code === "window_changed" && (action === "text" || action === "scroll" ||
          action === "key" && fields.down || action === "pointer" && fields.phase === "down" ||
          action === "ime" && ["begin", "update", "commit"].includes(fields.mode))) recoverable.add(error);
      throw error;
    }
  };
  const run = action => {
    if (disposed) return Promise.reject(new Error("窗口输入连接已关闭"));
    if (pending >= 128) return Promise.reject(new Error("窗口输入等待过多，请重新连接"));
    // A new key, click or other operation is an ordering barrier for wheel
    // coalescing. Never merge a later gesture across that operation.
    wheel = undefined;
    pending++;
    const result = (queued || Promise.resolve()).then(async () => {
      if (disposed) throw new Error("窗口输入连接已关闭");
      try { return await action(); }
      catch (error) {
        keys.clear();
        await request("input-reset").catch(() => {});
        if (!disposed && recoverable.has(error)) {
          // Do not replay a click or queued keys against a newly focused window.
          // The viewer obtains a fresh frame before the user acts again.
          void Promise.resolve().then(() => !disposed && onWindowChanged?.()).catch(() => {});
        }
        throw error;
      }
    });
    queued = result;
    const finish = () => {
      pending--;
      if (queued === result) queued = undefined;
    };
    result.then(finish, finish);
    return result;
  };
  const valid = target => !disposed && active() && identity(target) === identity(frame());
  const send = (action, fields, target = frame()) => run(() => {
    if (!target || !valid(target)) throw staleWindow();
    return requestInput(action, { ...target, ...fields });
  });
  const report = (promise, passive = false) => { void promise.catch(error => {
    if (!disposed && !(passive && error.code === "window_changed")) onError(error.message, error.code);
  }); };
  const on = (target, name, callback, options) => {
    target.addEventListener(name, callback, options);
    listeners.push(() => target.removeEventListener(name, callback, options));
  };
  const point = event => {
    const box = element.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1 - Number.EPSILON, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1 - Number.EPSILON, (event.clientY - box.top) / box.height)),
    };
  };
  const focus = () => keyboard?.focus({ preventScroll: true });
  const key = (symbol, code, down, target) => {
    if (!target || !valid(target)) throw staleWindow();
    if (down) keys.add(code); else keys.delete(code);
    const character = symbol >= 0x01000000 ? symbol & 0x00ffffff : symbol;
    const name = character >= 32 && character < 0xff00 ? String.fromCodePoint(character) : code;
    return requestInput("key", { ...target, code, key: name, down, ...modifiers(keys) });
  };
  on(element, "pointerdown", event => {
    if (!active() || !frame() || ![0, 1, 2].includes(event.button)) return;
    if (drag && drag.pointer !== event.pointerId) return;
    event.preventDefault(); focus(); move = undefined;
    const now = event.timeStamp;
    const nearby = lastClick && lastClick.button === event.button && now - lastClick.time < 500 &&
      Math.abs(lastClick.x - event.clientX) < 4 && Math.abs(lastClick.y - event.clientY) < 4;
    const clicks = Math.min(3, event.detail || (nearby ? lastClick.count + 1 : 1));
    lastClick = { button: event.button, x: event.clientX, y: event.clientY, count: clicks, time: now };
    drag ||= { pointer: event.pointerId, target: { ...frame() }, buttons: 0 };
    drag.buttons = event.buttons;
    element.setPointerCapture(event.pointerId);
    report(send("pointer", { phase: "down", button: event.button, buttons: event.buttons, clicks, ...point(event),
      shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, command: event.metaKey }, drag.target));
  });
  on(element, "pointermove", event => {
    if (!active() || !frame() || (drag && drag.pointer !== event.pointerId)) return;
    const target = drag?.target || { ...frame() };
    const fields = { phase: "move", buttons: event.buttons, ...point(event),
      shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, command: event.metaKey };
    if (move) { move.fields = fields; return; }
    const entry = { fields };
    move = entry;
    report(run(() => {
      if (move === entry) move = undefined;
      if (!valid(target)) throw staleWindow();
      return requestInput("pointer", { ...target, ...entry.fields });
    }), true);
  });
  on(element, "pointerup", event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault(); move = undefined;
    const target = drag.target;
    drag.buttons = event.buttons;
    if (!event.buttons) {
      drag = undefined;
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    }
    report(send("pointer", { phase: "up", button: event.button, buttons: event.buttons, clicks: lastClick?.count || 1,
      ...point(event), shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, command: event.metaKey }, target));
  });
  const reset = () => {
    if (disposed) return;
    resetSequence++;
    wheel = undefined;
    move = undefined; keys.clear();
    const hadInput = Boolean(drag || keyboard);
    const pointer = drag?.pointer;
    drag = undefined;
    if (pointer !== undefined && element.hasPointerCapture(pointer)) element.releasePointerCapture(pointer);
    if (hadInput) report(run(() => { keys.clear(); return request("input-reset"); }));
  };
  on(element, "pointercancel", reset);
  on(element, "lostpointercapture", () => { if (drag) reset(); });
  on(element, "contextmenu", event => event.preventDefault());
  // A trackpad emits dozens of wheel events per second, while each request
  // waits for the guest. Merge the ones still queued into a single scroll so
  // the page follows the gesture instead of replaying a backlog afterwards.
  on(element, "wheel", event => {
    if (!active() || !frame()) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.getBoundingClientRect().height : 1;
    const dx = (event.deltaX ?? 0) * unit, dy = (event.deltaY ?? 0) * unit;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !dx && !dy) return;
    const bounded = value => Math.max(-1200, Math.min(1200, value));
    const fields = { ...point(event), shift: event.shiftKey, control: event.ctrlKey,
      alt: event.altKey, command: event.metaKey };
    const target = { ...frame() };
    if (wheel && identity(wheel.target) === identity(target) &&
        Object.keys(fields).every(key => fields[key] === wheel.fields[key])) {
      // Bound queued distance as well as request count. A slow or disconnected
      // guest must not replay seconds of obsolete scrolling after recovery.
      wheel.dx = Math.max(-4800, Math.min(4800, wheel.dx + bounded(dx)));
      wheel.dy = Math.max(-4800, Math.min(4800, wheel.dy + bounded(dy)));
      return;
    }
    const entry = { target, fields, dx: bounded(dx), dy: bounded(dy), resetSequence };
    const result = run(async () => {
      if (wheel === entry) wheel = undefined;
      let x = entry.dx, y = entry.dy;
      while (x || y) {
        if (entry.resetSequence !== resetSequence) return;
        if (!valid(target)) throw staleWindow();
        const deltaX = bounded(x), delta = bounded(y);
        await requestInput("scroll", { ...target, ...fields, deltaX, delta });
        x -= deltaX; y -= delta;
      }
    });
    wheel = entry;
    report(result);
  }, { passive: false });
  on(eventWindow, "blur", reset);

  return {
    events: new EventTarget(), run, send, valid,
    target: () => frame() && { ...frame() },
    setKeyboardTarget(target) { keyboard = target; keyboard?.classList.add("mac-claude-typing"); },
    focus,
    pasteText: text => send("text", { text }),
    sendKey(symbol, code, down) {
      const target = frame() && { ...frame() };
      report(run(() => key(symbol, code, down, target)));
    },
    runKeyAction(action) {
      const target = frame() && { ...frame() };
      return run(() => action((...fields) => key(...fields, target)));
    },
    dispose() {
      if (disposed) return;
      disposed = true; move = undefined; wheel = undefined; keys.clear(); drag = undefined;
      void request("input-reset").catch(() => {});
      listeners.forEach(remove => remove());
      keyboard = undefined;
    },
  };
}
