// Counts frames acknowledged by the renderer, not physical display refreshes.
// Only numbers and fixed codec/reason names leave this collector.
export function createMacFrameMetrics({ now = () => performance.now(), onDiagnostic = () => {} } = {}) {
  const started = now();
  let format = "", fallback = "", frames = 0, bytes = 0, draw = 0, encoded = 0, encodes = 0, measuredFrames = 0;
  let width = 0, height = 0, closed = false, sampled = started, sampledFrames = 0, sampledBytes = 0;
  const reasons = new Set(["webcodecs_unavailable", "video_decoder_unavailable", "guest_image_fallback", "sharp_png", "presentation_failed"]);
  const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
  const summary = () => ({ format, fallback, frames, bytes, width, height,
    elapsedMs: Math.round(Math.max(0, now() - started)),
    decodeDrawMs: measuredFrames ? Math.round(draw / measuredFrames * 10) / 10 : null,
    encodeMs: encodes ? Math.round(encoded / encodes * 10) / 10 : null });
  const diagnostic = event => { try { onDiagnostic(event, summary()); } catch { /* Diagnostics never block rendering. */ } };
  return {
    present(header, receivedAt) {
      if (closed || !["video/h264", "image/jpeg", "image/png"].includes(header.mime)) return;
      const changed = format !== header.mime;
      if (changed || width !== number(header.pixelWidth) || height !== number(header.pixelHeight)) {
        draw = 0; encoded = 0; encodes = 0; measuredFrames = 0;
      }
      format = header.mime; frames++; bytes += number(header.imageLength);
      width = number(header.pixelWidth); height = number(header.pixelHeight);
      draw += Math.max(0, now() - receivedAt);
      measuredFrames++;
      if (Number.isFinite(header.encodeMilliseconds) && header.encodeMilliseconds >= 0) {
        encoded += header.encodeMilliseconds; encodes++;
      }
      if (changed) diagnostic("mode");
    },
    fallback(reason) {
      if (closed) return;
      const next = reasons.has(reason) ? reason : "video_decoder_unavailable";
      if (next !== fallback) { fallback = next; diagnostic("fallback"); }
    },
    sample() {
      const time = now(), seconds = (time - sampled) / 1000;
      const result = { ...summary(), updatesPerSecond: seconds >= .5 ? Math.round((frames - sampledFrames) / seconds * 10) / 10 : null,
        bytesPerSecond: seconds >= .5 ? Math.round((bytes - sampledBytes) / seconds) : null };
      sampled = time; sampledFrames = frames; sampledBytes = bytes;
      return result;
    },
    close() { if (!closed) { if (frames || fallback) diagnostic("closed"); closed = true; } },
  };
}
