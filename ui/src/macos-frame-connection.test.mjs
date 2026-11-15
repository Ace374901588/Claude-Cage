import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMacFrameConnection } from "./macos-frame-connection.mjs";

const native = readFileSync(new URL("../../internal/workbench/testdata/macos-window-h264-key.bin", import.meta.url));
const headerLength = native.readUInt32BE(0);
const nativeHeader = JSON.parse(native.subarray(4, 4 + headerLength));
const nativePixels = native.subarray(4 + headerLength);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=", "base64");
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { supported = true, video = true, available = true } = {}) {
  const originals = new Map(["WebSocket", "window", "location", "VideoDecoder", "EncodedVideoChunk"].map(key => [key, globalThis[key]]));
  const frames = [], failures = [], revoked = [], decoders = [];
  let socket, serial = 0;
  class Socket extends EventTarget {
    static OPEN = 1;
    constructor() { super(); this.readyState = 0; this.sent = []; socket = this; }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
    packet(fields, pixels = nativePixels) {
      const header = { ...nativeHeader, revision: 1, ...fields, imageLength: pixels.length };
      const json = new TextEncoder().encode(JSON.stringify(header));
      const data = new Uint8Array(4 + json.length + pixels.length);
      new DataView(data.buffer).setUint32(0, json.length);
      data.set(json, 4); data.set(pixels, 4 + json.length);
      this.dispatchEvent(Object.assign(new Event("message"), { data: data.buffer }));
    }
  }
  class Decoder {
    static async isConfigSupported() { return { supported }; }
    constructor(callbacks) { this.callbacks = callbacks; this.state = "unconfigured"; this.decodeQueueSize = 0; decoders.push(this); }
    configure(value) { this.config = value; this.state = "configured"; }
    decode(chunk) {
      queueMicrotask(() => this.callbacks.output({ timestamp: chunk.timestamp, displayWidth: 320, displayHeight: 240,
        closed: false, close() { this.closed = true; } }));
    }
    close() { this.state = "closed"; }
  }
  class Chunk { constructor(value) { Object.assign(this, value); } }
  Object.assign(globalThis, { WebSocket: Socket, window: { devicePixelRatio: 2 }, location: { protocol: "http:", host: "localhost:17777", origin: "http://localhost:17777" },
    VideoDecoder: available ? Decoder : undefined, EncodedVideoChunk: available ? Chunk : undefined });
  t.mock.method(URL, "createObjectURL", () => `blob:fixture-${++serial}`);
  t.mock.method(URL, "revokeObjectURL", value => revoked.push(value));
  const connection = createMacFrameConnection(frame => frames.push(frame), reason => failures.push(reason), "/macos-browser", { video });
  t.after(() => {
    connection.close();
    for (const frame of frames) frame.videoFrame?.close();
    for (const [key, value] of originals) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  connection.resize({ width: 800, height: 600 });
  socket.open();
  return { connection, socket, frames, failures, revoked, decoders };
}

test("video is negotiated only when WebCodecs is available and ACK follows presentation", async t => {
  const f = fixture(t);
  assert.equal(f.socket.sent[0].video, true);
  f.socket.packet({});
  await settle();
  assert.equal(f.frames.length, 1);
  assert.equal(f.socket.sent.length, 1);
  assert.equal(f.frames[0].videoFrame.closed, false);
  f.frames[0].videoFrame.close();
  f.frames[0].acknowledge(); f.frames[0].acknowledge();
  assert.equal(f.socket.sent.length, 2);
  assert.deepEqual(f.socket.sent[1], { ack: nativeHeader.sequence });
  assert.deepEqual(f.failures, []);
});

test("unsupported video automatically requests a new image subscription", async t => {
  const f = fixture(t, { supported: false });
  f.socket.packet({});
  await settle();
  assert.equal(f.socket.sent[1].video, false);
  assert.equal(f.socket.sent[1].revision, 2);
  assert.equal(f.frames.length, 0);
  f.socket.packet({ mime: "image/png", revision: 2, sequence: "image-fallback" }, png);
  assert.equal(f.frames.length, 1);
  f.frames[0].acknowledge();
  assert.deepEqual(f.socket.sent.at(-1), { ack: "image-fallback" });
  assert.deepEqual(f.failures, []);
});

test("an older signed helper can return an image when video was requested", async t => {
  const f = fixture(t);
  f.socket.packet({ mime: "image/png" }, png);
  assert.equal(f.socket.sent[1].video, false);
  assert.equal(f.frames.length, 0);
  f.socket.packet({ mime: "image/png", revision: 2, sequence: "fallback" }, png);
  assert.equal(f.frames.length, 1);
  assert.deepEqual(f.failures, []);
});

test("a presentation failure requests JPEG on the existing socket and ignores old video", async t => {
  const f = fixture(t);
  f.socket.packet({}); await settle();
  f.connection.fallback("presentation_failed");
  assert.equal(f.socket.readyState, WebSocket.OPEN);
  assert.equal(f.socket.sent.at(-1).video, false);
  assert.equal(f.socket.sent.at(-1).revision, 2);
  assert.equal(f.decoders[0].state, "closed");
  f.frames[0].acknowledge();
  assert.equal(f.socket.sent.length, 2);
  f.socket.packet({ mime: "image/jpeg", revision: 2, sequence: "jpeg" }, png);
  f.frames[1].acknowledge();
  assert.deepEqual(f.socket.sent.at(-1), { ack: "jpeg" });
  assert.deepEqual(f.failures, []);
});

test("resize rejects stale video and clears its decoder", async t => {
  const f = fixture(t);
  f.socket.packet({}); await settle();
  f.connection.resize({ width: 900, height: 640 });
  assert.equal(f.decoders[0].state, "closed");
  f.frames[0].acknowledge();
  assert.equal(f.socket.sent.length, 2);
  f.socket.packet({ timestamp: nativeHeader.timestamp + 1 });
  await settle();
  assert.equal(f.frames.length, 1);
  f.socket.packet({ revision: 2, timestamp: nativeHeader.timestamp + 2 });
  await settle();
  assert.equal(f.frames.length, 2);
  assert.equal(f.decoders.length, 2);
});

test("stale image onLoad cannot revoke the current frame URL", t => {
  const f = fixture(t, { video: false });
  f.socket.packet({ mime: "image/png", sequence: "old" }, png);
  f.connection.resize({ width: 900, height: 640 });
  f.socket.packet({ mime: "image/png", sequence: "new", revision: 2 }, png);
  f.frames[0].acknowledge();
  assert.equal(f.revoked.includes(f.frames[1].src), false);
  f.frames[1].acknowledge();
  assert.equal(f.revoked.includes(f.frames[0].src), true);
});

test("image-only clients do not advertise video support", t => {
  const f = fixture(t, { available: false });
  assert.equal(f.socket.sent[0].video, false);
  f.socket.packet({ mime: "image/png" }, png);
  assert.equal(f.frames.length, 1);
  assert.deepEqual(f.failures, []);
});
