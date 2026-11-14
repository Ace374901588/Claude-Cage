import test from "node:test";
import assert from "node:assert/strict";
import { createMacWindowRecovery } from "./macos-window-recovery.mjs";

test("window recovery coalesces failures and refreshes only after activation", async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const recovery = createMacWindowRecovery({
    active: () => true,
    request: async action => { calls.push(action); await gate; },
    onRecovered: () => calls.push("fresh-view"),
    onError: error => { throw error; },
  });
  const first = recovery.recover(), second = recovery.recover();
  assert.equal(first, second);
  await Promise.resolve();
  assert.deepEqual(calls, ["launch"]);
  release();
  assert.equal(await first, true);
  assert.deepEqual(calls, ["launch", "fresh-view"]);
  assert.equal(recovery.pending, false);
  recovery.dispose();
});

test("a hidden or disposed viewer neither steals focus nor refreshes a stale view", async () => {
  let visible = false, release;
  const calls = [], gate = new Promise(resolve => { release = resolve; });
  const recovery = createMacWindowRecovery({
    active: () => visible,
    request: async action => { calls.push(action); await gate; },
    onRecovered: () => calls.push("stale-view"), onError: () => calls.push("stale-error"),
  });
  assert.equal(await recovery.recover(), false);
  assert.deepEqual(calls, []);
  visible = true;
  const pending = recovery.recover();
  await Promise.resolve();
  recovery.dispose();
  release();
  assert.equal(await pending, false);
  assert.equal(await recovery.recover(), false);
  assert.deepEqual(calls, ["launch"]);
});

test("activation failure is reported once without retrying in the background", async () => {
  let requests = 0, refreshes = 0;
  const errors = [], error = Object.assign(new Error("identity failed"), { code: "identity_error" });
  const recovery = createMacWindowRecovery({
    active: () => true, request: async () => { requests++; throw error; },
    onRecovered: () => refreshes++, onError: value => errors.push(value),
  });
  assert.equal(await recovery.recover(), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, [error]);
  assert.equal(requests, 1); assert.equal(refreshes, 0);
  recovery.dispose();
});
