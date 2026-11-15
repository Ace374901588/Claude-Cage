import { runtimeSocketURL } from "./client-context.mjs";
import { createMacVideoDecoder } from "./macos-video-decoder.mjs";
import { createMacFrameMetrics } from "./macos-frame-metrics.mjs";

export function createMacFrameConnection(onFrame, onError, base = "/macos/claude", { video = false, onStats, onDiagnostic } = {}) {
  const socket = new WebSocket(runtimeSocketURL(base + "/frames"));
  socket.binaryType = "arraybuffer";
  const urls = new Set();
  let configuration, viewport, size = "", revision = 0, latestSequence = "", closed = false, decoder;
  let useVideo = video && typeof globalThis.VideoDecoder === "function" && typeof globalThis.EncodedVideoChunk === "function";
  const metrics = createMacFrameMetrics({ onDiagnostic });
  if (video && !useVideo) metrics.fallback("webcodecs_unavailable");
  const publish = () => { if (!closed) { try { onStats?.(metrics.sample()); } catch { /* Observers cannot break the frame channel. */ } } };
  const statsTimer = onStats ? setInterval(publish, 2000) : undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(statsTimer);
    metrics.close();
    socket.close();
    decoder?.close();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  };
  const resize = nextViewport => {
    if (closed || !nextViewport) return;
    viewport = { ...nextViewport };
    const next = { ...viewport, scale: Math.max(1, Math.min(2, window.devicePixelRatio || 1)), video: useVideo };
    const key = JSON.stringify(next);
    if (key === size) return;
    size = key;
    decoder?.reset();
    configuration = { ...next, revision: ++revision };
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(configuration));
  };
  const disableVideo = (reason = "video_decoder_unavailable") => {
    if (closed || !useVideo) return;
    metrics.fallback(reason);
    useVideo = false;
    decoder?.close(); decoder = undefined;
    resize(viewport);
  };
  const fail = (reason = "window_unavailable") => {
    if (closed) return;
    close();
    onError(reason);
  };
  socket.addEventListener("open", () => {
    if (configuration) socket.send(JSON.stringify(configuration));
  });
  socket.addEventListener("error", () => fail());
  socket.addEventListener("close", () => fail());
  socket.addEventListener("message", event => {
    if (closed) return;
    try {
      const data = event.data;
      if (!(data instanceof ArrayBuffer) || data.byteLength < 4) throw new Error();
      const length = new DataView(data).getUint32(0);
      if (!length || length > 16384 || 4 + length > data.byteLength) throw new Error();
      const header = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, length)));
      if (header.imageLength !== data.byteLength - 4 - length) throw new Error();
      if (header.revision !== revision) return;
      if (header.error) { fail(header.error); return; }
      if (!["image/png", "image/jpeg", "video/h264"].includes(header.mime) || !header.imageLength || !header.sequence || header.imageLength >= 8 * 1024 * 1024) throw new Error();
      const packetRevision = revision;
      const receivedAt = performance.now();
      latestSequence = header.sequence;
      let acknowledged = false;
      const acknowledge = () => {
        if (closed || acknowledged || latestSequence !== header.sequence || packetRevision !== revision) return;
        acknowledged = true;
        metrics.present(header, receivedAt);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ack: header.sequence }));
      };
      if (header.mime === "video/h264") {
        if (!useVideo) throw new Error();
        decoder ||= createMacVideoDecoder({
          onFrame(next) {
            if (closed || next.revision !== revision) { next.videoFrame.close(); return; }
            onFrame(next);
          },
          onFallback: disableVideo,
        });
        void decoder.decode({ ...header, acknowledge }, new Uint8Array(data, 4 + length));
      } else {
        if (useVideo) { disableVideo(header.mime === "image/png" ? "sharp_png" : "guest_image_fallback"); return; }
        const src = URL.createObjectURL(new Blob([new Uint8Array(data, 4 + length)], { type: header.mime }));
        urls.add(src);
        onFrame({ ...header, src, acknowledge() {
          if (closed || acknowledged || latestSequence !== header.sequence || packetRevision !== revision) return;
          for (const previous of urls) {
            if (previous !== src) { URL.revokeObjectURL(previous); urls.delete(previous); }
          }
          acknowledge();
        } });
      }
    } catch { fail(); }
  });
  return {
    resize,
    close,
    fallback: disableVideo,
  };
}
