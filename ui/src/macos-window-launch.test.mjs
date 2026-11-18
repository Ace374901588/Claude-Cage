import test from "node:test";
import assert from "node:assert/strict";
import { launchMacAppWhenReady } from "./macos-window-launch.mjs";

test("native apps wait for network authorization and retry a denied start", async () => {
  const launched = { current: false };
  let calls = 0;
  const options = { installed: true, launched, isCurrent: () => true, launch: async () => { calls++; } };
  for (const networkReady of [false, undefined, null]) {
    assert.equal(await launchMacAppWhenReady({ ...options, networkReady }), false);
  }
  assert.equal(calls, 0);
  await assert.rejects(launchMacAppWhenReady({ ...options, networkReady: true,
    launch: async () => { throw new Error("network_not_ready"); } }), /network_not_ready/);
  assert.equal(launched.current, false);
  assert.equal(await launchMacAppWhenReady({ ...options, networkReady: true }), true);
  assert.equal(await launchMacAppWhenReady({ ...options, networkReady: true }), false);
  assert.equal(calls, 1);
});

test("an obsolete launch cannot consume a new VM or view's start", async () => {
  const launched = { current: false };
  let current = true, release;
  const pending = launchMacAppWhenReady({ networkReady: true, installed: true, launched,
    isCurrent: () => current, launch: () => new Promise(resolve => { release = resolve; }) });
  current = false;
  release();
  assert.equal(await pending, false);
  assert.equal(launched.current, false);
  assert.equal(await launchMacAppWhenReady({ networkReady: true, installed: true, launched,
    isCurrent: () => true, launch: async () => {} }), true);
});
