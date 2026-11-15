// Decode AVCC packets directly to VideoFrame. The renderer owns and closes each
// delivered frame; resize/disconnect discard pending work without presenting it.
export function createMacVideoDecoder({ onFrame, onFallback, Decoder = globalThis.VideoDecoder, Chunk = globalThis.EncodedVideoChunk }) {
  let decoder, configuration = "", closed = false, generation = 0;
  const pending = new Map();
  const clear = () => {
    generation++;
    for (const value of pending.values()) clearTimeout(value.timer);
    pending.clear();
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = undefined;
    configuration = "";
  };
  const fail = () => {
    if (closed) return;
    closed = true;
    clear();
    onFallback("video_decoder_unavailable");
  };
  return {
    async decode(header, data) {
      if (closed) return;
      const epoch = generation;
      try {
        if (!Decoder || !Chunk || !/^avc1\.[0-9a-f]{6}$/.test(header.codec) ||
            typeof header.description !== "string" || header.description.length > 5500 ||
            !Number.isSafeInteger(header.timestamp) || header.timestamp <= 0 ||
            !Number.isInteger(header.pixelWidth) || !Number.isInteger(header.pixelHeight) ||
            header.pixelWidth < 2 || header.pixelHeight < 2 || header.pixelWidth > 8192 || header.pixelHeight > 8192 ||
            header.pixelWidth * header.pixelHeight > 40000000 || typeof header.keyFrame !== "boolean") throw new Error();
        const key = JSON.stringify([header.codec, header.description, header.pixelWidth, header.pixelHeight, header.geometry]);
        if (key !== configuration) {
          if (!header.keyFrame) throw new Error();
          const description = Uint8Array.from(atob(header.description), character => character.charCodeAt(0));
          if (description.length < 7 || description.length > 4096 || description[0] !== 1 || (description[4] & 3) !== 3) throw new Error();
          const config = { codec: header.codec, description, codedWidth: header.pixelWidth, codedHeight: header.pixelHeight,
            optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" };
          let support, timer;
          try {
            support = await Promise.race([
              Decoder.isConfigSupported(config),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("video_support_timeout")), 1500); }),
            ]);
          } finally { clearTimeout(timer); }
          if (closed || epoch !== generation) return;
          if (!support.supported) throw new Error();
          clear();
          const decodeEpoch = generation;
          decoder = new Decoder({
            output(frame) {
              const value = pending.get(frame.timestamp);
              if (closed || decodeEpoch !== generation || !value) { frame.close(); return; }
              pending.delete(frame.timestamp);
              clearTimeout(value.timer);
              if (frame.displayWidth !== value.header.pixelWidth || frame.displayHeight !== value.header.pixelHeight) {
                frame.close(); fail(); return;
              }
              try { onFrame({ ...value.header, videoFrame: frame }); }
              catch { frame.close(); fail(); }
            },
            error() { if (decodeEpoch === generation) fail(); },
          });
          decoder.configure(config);
          configuration = key;
        }
        if (closed || pending.size >= 2 || decoder.decodeQueueSize > 1 || pending.has(header.timestamp)) throw new Error();
        pending.set(header.timestamp, { header, timer: setTimeout(fail, 1500) });
        decoder.decode(new Chunk({ type: header.keyFrame ? "key" : "delta", timestamp: header.timestamp, data }));
      } catch { fail(); }
    },
    reset() { if (!closed) clear(); },
    close() { closed = true; clear(); },
  };
}
