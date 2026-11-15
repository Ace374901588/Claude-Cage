import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMacVideoDecoder } from "./macos-video-decoder.mjs";

const packet = readFileSync(new URL("../../internal/workbench/testdata/macos-window-h264-key.bin", import.meta.url));
const length = packet.readUInt32BE(0);
const header = JSON.parse(packet.subarray(4, 4 + length));
const data = packet.subarray(4 + length);

function fixture(options = {}) {
  const frames = [], failures = [], instances = [];
  class Decoder {
    static async isConfigSupported(config) { return options.support ? options.support(config) : { supported: true }; }
    constructor(callbacks) { this.callbacks = callbacks; this.state = "unconfigured"; this.decodeQueueSize = 0; this.chunks = []; instances.push(this); }
    configure(config) { this.config = config; this.state = "configured"; }
    decode(chunk) { this.chunks.push(chunk); }
    close() { this.state = "closed"; }
    emit(timestamp, width = 320) {
      const frame = { timestamp, displayWidth: width, displayHeight: 240, closed: false, close() { this.closed = true; } };
      this.callbacks.output(frame);
      return frame;
    }
  }
  class Chunk { constructor(value) { Object.assign(this, value); } }
  const decoder = createMacVideoDecoder({ Decoder, Chunk,
    onFrame: frame => frames.push(frame), onFallback: reason => failures.push(reason) });
  return { decoder, instances, frames, failures };
}

test("native AVC config decodes key and delta frames without reconfiguration", async () => {
  const f = fixture();
  try {
    await f.decoder.decode(header, data);
    const decoder = f.instances[0];
    assert.equal(decoder.config.optimizeForLatency, true);
    assert.equal(decoder.config.hardwareAcceleration, "prefer-hardware");
    assert.equal(decoder.chunks[0].type, "key");
    decoder.emit(header.timestamp);
    await f.decoder.decode({ ...header, timestamp: header.timestamp + 1, keyFrame: false }, data);
    assert.equal(f.instances.length, 1);
    assert.equal(decoder.chunks[1].type, "delta");
    decoder.emit(header.timestamp + 1);
    assert.equal(f.frames.length, 2);
    assert.equal(f.frames[0].geometry, header.geometry);
    assert.deepEqual(f.failures, []);
  } finally { for (const frame of f.frames) frame.videoFrame.close(); f.decoder.close(); }
});

test("a subscription cannot begin with a dependent delta frame", async () => {
  const f = fixture();
  await f.decoder.decode({ ...header, keyFrame: false }, data);
  assert.equal(f.instances.length, 0);
  assert.equal(f.failures.length, 1);
  f.decoder.close();
});

test("resize closes old decoder outputs and requires a new keyframe", async () => {
  const f = fixture();
  await f.decoder.decode(header, data);
  const old = f.instances[0];
  f.decoder.reset();
  assert.equal(old.state, "closed");
  assert.equal(old.emit(header.timestamp).closed, true);
  await f.decoder.decode({ ...header, geometry: "new", timestamp: header.timestamp + 1 }, data);
  assert.equal(f.instances.length, 2);
  f.decoder.close();
});

test("closing during asynchronous capability lookup cannot create a decoder", async () => {
  let release;
  const f = fixture({ support: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.decoder.decode(header, data);
  f.decoder.close();
  release({ supported: true });
  await pending;
  assert.equal(f.instances.length, 0);
  assert.deepEqual(f.failures, []);
});

test("unsupported AVC and incorrect decoded dimensions request image fallback", async () => {
  const unsupported = fixture({ support: () => ({ supported: false }) });
  await unsupported.decoder.decode(header, data);
  assert.equal(unsupported.failures.length, 1);
  unsupported.decoder.close();
  const mismatch = fixture();
  await mismatch.decoder.decode(header, data);
  assert.equal(mismatch.instances[0].emit(header.timestamp, 8192).closed, true);
  assert.equal(mismatch.frames.length, 0);
  assert.equal(mismatch.failures.length, 1);
  mismatch.decoder.close();
});

test("decoder allocation rejects unsafe timestamp, configuration and dimensions", async () => {
  for (const change of [{ timestamp: 2 ** 53 }, { timestamp: 0 }, { pixelWidth: 9000 },
                        { pixelHeight: 0 }, { description: "bad" }, { codec: "invalid" }, { keyFrame: undefined }]) {
    const f = fixture();
    await f.decoder.decode({ ...header, ...change }, data);
    assert.equal(f.instances.length, 0);
    assert.equal(f.failures.length, 1);
    f.decoder.close();
  }
});

test("queued or failed video decoding cannot accumulate unlimited frames", async () => {
  const f = fixture();
  await f.decoder.decode(header, data);
  await f.decoder.decode({ ...header, timestamp: header.timestamp + 1, keyFrame: false }, data);
  await f.decoder.decode({ ...header, timestamp: header.timestamp + 2, keyFrame: false }, data);
  assert.equal(f.failures.length, 1);
  assert.equal(f.instances[0].state, "closed");
  assert.equal(f.instances[0].emit(header.timestamp).closed, true);
  f.decoder.close();
});

test("a decoder that never emits a frame falls back after its deadline", async () => {
  const f = fixture();
  await f.decoder.decode(header, data);
  await new Promise(resolve => setTimeout(resolve, 1550));
  assert.equal(f.failures.length, 1);
  assert.equal(f.instances[0].state, "closed");
  f.decoder.close();
});

test("a capability lookup that never resolves requests image fallback", async () => {
  const f = fixture({ support: () => new Promise(() => {}) });
  await f.decoder.decode(header, data);
  assert.equal(f.instances.length, 0);
  assert.equal(f.failures.length, 1);
  f.decoder.close();
});
