import test from "node:test";
import assert from "node:assert/strict";
import { createMacFrameMetrics } from "./macos-frame-metrics.mjs";

test("renderer acknowledgments measure completed updates and idle periods", () => {
  let time = 0;
  const events = [], metrics = createMacFrameMetrics({ now: () => time, onDiagnostic: (event, value) => events.push({ event, value }) });
  time = 1000;
  metrics.present({ mime: "video/h264", imageLength: 10000, pixelWidth: 1920, pixelHeight: 1350, encodeMilliseconds: 12 }, 994);
  time = 2000;
  metrics.present({ mime: "video/h264", imageLength: 20000, pixelWidth: 1920, pixelHeight: 1350, encodeMilliseconds: 14 }, 1990);
  const sample = metrics.sample();
  assert.equal(sample.updatesPerSecond, 1);
  assert.equal(sample.bytesPerSecond, 15000);
  assert.equal(sample.decodeDrawMs, 8);
  assert.equal(sample.encodeMs, 13);
  assert.equal(events.length, 1);
  time = 4000;
  assert.equal(metrics.sample().updatesPerSecond, 0);
  metrics.close(); metrics.close();
  assert.equal(events.length, 2);
  assert.equal(events[1].event, "closed");
});

test("fallback reason and confirmed format are distinct until an image is presented", () => {
  let time = 100;
  const metrics = createMacFrameMetrics({ now: () => time });
  metrics.present({ mime: "video/h264", imageLength: 10 }, 95);
  metrics.fallback("presentation_failed");
  assert.equal(metrics.sample().format, "video/h264");
  time = 1000;
  metrics.present({ mime: "image/jpeg", imageLength: 20 }, 980);
  const image = metrics.sample();
  assert.equal(image.format, "image/jpeg");
  assert.equal(image.decodeDrawMs, 20);
  assert.equal(image.encodeMs, null);
  assert.equal(metrics.sample().fallback, "presentation_failed");
  metrics.close();
  metrics.present({ mime: "image/png", imageLength: 20 }, 990);
  assert.equal(metrics.sample().frames, 2);
});

test("diagnostic observer errors cannot break a running renderer", () => {
  const metrics = createMacFrameMetrics({ now: () => 100, onDiagnostic: () => { throw new Error("observer failed"); } });
  assert.doesNotThrow(() => {
    metrics.present({ mime: "image/jpeg", imageLength: 1 }, 95);
    metrics.fallback("guest_image_fallback"); metrics.close();
  });
});
