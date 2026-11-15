import React, { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { DesktopToolbar, useDesktopZoom } from "./claude-desktop";
import { MacOSLogin } from "./macos-login";
import { api, native, nativeAvailable } from "./api";
import { BrowserFavorites } from "./browser-favorites";
import { BrowserUploads } from "./browser-uploads";
import { sendFiles } from "./file-transfer";
import { prepareClipboardPaste, sendImage } from "./image-transfer";
import { installRemoteInput } from "./remote-input";
import { createMacWindowInput } from "./macos-window-input.mjs";
import { copyGuestText } from "./shared-clipboard.mjs";
import { useWindowVisibility } from "./window-visibility";
import { createMacWindowConnection } from "./macos-window-connection.mjs";
import { createMacFrameConnection } from "./macos-frame-connection.mjs";
import { createMacWindowRecovery } from "./macos-window-recovery.mjs";
import { macDesktopZoomKey, observeMacWindowViewport } from "./macos-window-layout.mjs";
import { reportDiagnostic, reportDisplayDiagnostic } from "./diagnostics.mjs";
import "./macos-claude-window.css";

const messages = {
  requires_gui_login: "请先登录并解锁虚拟 Mac 的图形账户。",
  screen_recording_permission: "请在虚拟 Mac 的系统授权中，允许 Cage Guest Window 录制屏幕。",
  accessibility_permission: "要操作窗口，请允许虚拟 Mac 中的 Cage Guest Window 使用辅助功能。",
  not_running: "请打开虚拟 Mac 中的应用。",
  no_visible_window: "应用尚未显示窗口，请重新打开应用。",
  identity_error: "虚拟 Mac 中的应用未通过签名检查。",
  window_changed: "活动窗口已变化，请在新画面中重试。",
  unknown_action: "客机窗口输入组件需要更新，请在环境设置中更新组件后重试。",
  input_connection_required: "窗口输入需要重新连接，请恢复画面后重试。",
  input_owned_by_another_view: "另一个连接正在操作此窗口，请等待它释放按键或拖动。",
};

async function windowRequest(base, action, fields = {}, connection) {
  const result = connection ? await connection.request(action, fields) : await api(base + "/window", { action, ...fields });
  if (result.error) {
    const error = new Error(messages[result.error] || "未能读取或操作虚拟 Mac 中的应用窗口。");
    error.code = result.error;
    throw error;
  }
  return result;
}

// Fixed-size native sign-in sheets stay at their real text size. Extend a
// uniform window background across the pane without scaling those pixels.
function matchWindowBackground(img, pane, canvasRef) {
  if (!pane) return;
  if (img.clientWidth >= pane.clientWidth - 1 && img.clientHeight >= pane.clientHeight - 1) return;
  if (!canvasRef.current) {
    canvasRef.current = document.createElement("canvas");
    canvasRef.current.width = 4;
    canvasRef.current.height = 1;
  }
  const canvas = canvasRef.current;
  const now = performance.now();
  if (canvas.nextSampleAt > now) return;
  canvas.nextSampleAt = now + 2000;
  const ctx = canvas.getContext("2d", {willReadFrequently:true});
  if (!ctx) return;
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  if (w < 16 || h < 16) return;
  [[8,8],[w-9,8],[8,h-9],[w-9,h-9]].forEach(([x,y],i) =>
    ctx.drawImage(img,x,y,1,1,i,0,1,1));
  const pixels = ctx.getImageData(0,0,4,1).data;
  const uniform = pixels.every((value, index) => Math.abs(value - pixels[index % 4]) <= 4);
  pane.style.backgroundColor = uniform && pixels[3] === 255 ? `rgb(${pixels[0]}, ${pixels[1]}, ${pixels[2]})` : "";
}

export function MacOSAppWindow({ browser = false, onOpenPage, visible, keyboard = "mac", remoteRef, sidebarCollapsed, onExpand, onConfirm, uploads = [], onStatus = () => {}, onFallback = () => {} }) {
  const appName = browser ? "Google Chrome" : "Claude Desktop";
  const base = browser ? "/macos-browser" : "/macos/claude";
  const windowVisible = useWindowVisibility();
  const [webLoginOpen, setWebLoginOpen] = useState(false);
  const screenVisible = visible && windowVisible && !webLoginOpen;
  const connection = useRef(null);
  const [inputChannel, setInputChannel] = useState(null);
  const frameConnection = useRef(null);
  const request = (action, fields) => windowRequest(base, action, fields, connection.current);
  const [zoom, setZoom] = useDesktopZoom(true, macDesktopZoomKey);
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [revision, refresh] = useState(0);
  const [image, setImage] = useState(null);
  const [displayStats, setDisplayStats] = useState(null);
  const pendingVideo = useRef(null);
  const frame = useRef(null);
  const surface = useRef(null);
  const controls = useRef(null);
  const current = useRef(null);
  current.current = { screenVisible, keyboard, input: state?.input, onStatus, onFallback };
  const pane = useRef(null);
  const backgroundSample = useRef(null);
  const viewport = useRef(null);
  useLayoutEffect(() => {
    const element = pane.current;
    if (!visible || !element) return;
    const stop = observeMacWindowViewport(element, zoom, value => {
      viewport.current = value;
      if (value) frameConnection.current?.resize(value);
    });
    return () => { stop(); viewport.current = null; };
  }, [visible, zoom]);
  const picker = useRef(null);
  const pickerTarget = useRef(null);
  const generation = useRef(0);
  const launched = useRef(false);

  useEffect(() => {
    if (!screenVisible) return;
    setDisplayStats(null);
    if (browser) launched.current = false;
    const epoch = ++generation.current;
    let timer;
    let current, nextStatus = 0, after = "", captureSize = "", checkFrame = true;
    const live = () => generation.current === epoch;
    function receiveFrame(next) {
      if (!live()) { next.videoFrame?.close(); return; }
      pendingVideo.current?.close();
      pendingVideo.current = next.videoFrame || null;
      if (frame.current?.window !== next.window || frame.current?.pid !== next.pid || frame.current?.geometry !== next.geometry) frame.current = null;
      setImage({
        videoFrame: next.videoFrame, video: Boolean(next.videoFrame),
        src: next.videoFrame ? undefined : next.src || `data:${next.mime === "image/jpeg" ? "image/jpeg" : "image/png"};base64,${next.image}`,
        window: next.window, pid: next.pid,
        geometry: next.geometry, width: next.contentWidth, height: next.contentHeight,
        acknowledge: next.acknowledge,
      });
      setError("");
    }
    async function poll() {
      let delay = 2200;
      try {
        if (!current || Date.now() >= nextStatus) {
          current = await request("status");
          if (browser && current.surface !== "browser") throw new Error("请更新 macOS 环境组件以显示 Chrome 窗口。");
          checkFrame = true;
          nextStatus = Date.now() + 2200;
          if (live() && current.persistent && !connection.current) {
            connection.current = createMacWindowConnection(base);
            setInputChannel(connection.current);
          }
        }
        if (!live()) return;
        setState(current);
        // Opening this tab focuses the signed guest application. A background
        // Electron window can still be captured but cannot receive targeted input.
        if (current.installed && !launched.current) {
          launched.current = true;
          await request("launch");
          nextStatus = 0;
          delay = 100;
          return;
        }
        if (current.running && current.screen) {
          if (current.push_frames && viewport.current) {
            if (!frameConnection.current) {
              setDisplayStats(null);
              frameConnection.current = createMacFrameConnection(receiveFrame, reason => {
                if (!live()) return;
                // Login restoration can focus another guest app after our
                // initial launch. Re-activate the explicitly open browser on a
                // failed capture; retain all native ownership/input checks.
                if (browser && reason === "capture_no_frame") {
                  launched.current = false;
                  reportDiagnostic("frontend", "macos-capture recovery surface=browser reason=capture_no_frame", "info");
                }
                frameConnection.current = null;
                setDisplayStats(null);
                nextStatus = 0;
                frame.current = null;
                // A transient target change must not blank a valid image. Input
                // stays disabled until a new frame has decoded and been acked.
                if (reason !== "window_changed") setImage(null);
                setError(messages[reason] || "未能读取虚拟 Mac 的窗口画面，请重新连接。");
              }, base, { video: current.frame_encodings?.includes("h264") === true,
                onStats: value => { if (live()) setDisplayStats(value); },
                onDiagnostic: (event, value) => reportDisplayDiagnostic(browser ? "browser" : "claude", event, value),
              });
            }
            frameConnection.current.resize(viewport.current);
            return;
          }
          const nextSize = JSON.stringify(viewport.current);
          if (nextSize !== captureSize) { after = ""; captureSize = nextSize; }
          const next = await request("frame", viewport.current ? {
            after, refresh: checkFrame,
            ...viewport.current, scale: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
          } : {});
          if (!live()) return;
          checkFrame = false;
          delay = current.persistent ? 50 : 350;
          if (next.unchanged) return;
          after = next.sequence || "";
          receiveFrame(next);
        } else { frameConnection.current?.close(); frameConnection.current = null; frame.current = null; setImage(null); setDisplayStats(null); }
        setError("");
      } catch (e) {
        if (!live()) return;
        connection.current?.close(); connection.current = null;
        setInputChannel(null);
        frameConnection.current?.close(); frameConnection.current = null;
        setDisplayStats(null);
        current = null; after = "";
        if (live()) { frame.current = null; setImage(null); setError(e.message); }
      } finally { if (live()) timer = setTimeout(poll, delay); }
    }
    poll();
    return () => {
      generation.current++; clearTimeout(timer); frame.current = null;
      pendingVideo.current?.close(); pendingVideo.current = null;
      connection.current?.close(); connection.current = null;
      setInputChannel(null);
      frameConnection.current?.close(); frameConnection.current = null;
    };
  }, [screenVisible, revision, base]);

  useLayoutEffect(() => {
    if (!image?.videoFrame || pendingVideo.current !== image.videoFrame) return;
    const video = image.videoFrame, canvas = surface.current;
    try {
      const ctx = canvas?.getContext("2d");
      if (!ctx) throw new Error();
      if (canvas.width !== video.displayWidth) canvas.width = video.displayWidth;
      if (canvas.height !== video.displayHeight) canvas.height = video.displayHeight;
      canvas.style.setProperty("--frame-width", image.width + "px");
      canvas.style.setProperty("--frame-aspect", image.width / image.height);
      ctx.drawImage(video, 0, 0);
      frame.current = { window: image.window, pid: image.pid, geometry: image.geometry, surface: browser ? "browser" : undefined };
      matchWindowBackground(canvas, pane.current, backgroundSample);
      requestAnimationFrame(() => image.acknowledge?.());
    } catch {
      frame.current = null;
      frameConnection.current?.fallback("presentation_failed");
      setImage(null);
    } finally {
      video.close();
      if (pendingVideo.current === video) pendingVideo.current = null;
    }
  }, [image, browser]);

  async function action(name) {
    try { if (name === "stop") launched.current = true; await request(name); setError(""); refresh((n) => n + 1); }
    catch (e) { setError(e.message); }
  }
  useImperativeHandle(remoteRef, () => ({
    focus: () => controls.current?.transport.focus(),
    closeNativeTab: () => controls.current?.transport.runKeyAction(async send => {
      for (const [symbol, code, down] of [[0xffeb, "MetaLeft", true], [119, "KeyW", true], [119, "KeyW", false], [0xffeb, "MetaLeft", false]]) {
        await send(symbol, code, down);
      }
    }).catch(e => setError(e.message)),
    edit: command => controls.current?.input.focused() ? controls.current.input.edit(command) : false,
    copy: () => controls.current?.input.copy(),
    paste: () => controls.current?.input.readAndPaste(),
    pasteText: text => controls.current?.input.paste(text),
    transfer: () => onFallback("", "可在此使用本机复制、粘贴。"),
  }));

  useEffect(() => {
    if (!screenVisible || !state?.input || !surface.current || !pane.current || (state.persistent && !inputChannel)) return;
    const inputRequest = (action, fields) => windowRequest(base, action, fields, inputChannel);
    const recovery = createMacWindowRecovery({
      request: action => inputRequest(action),
      active: () => Boolean(current.current.screenVisible && current.current.input),
      onRecovered: () => {
        setError("");
        current.current.onStatus(`已激活 ${appName}，请在更新后的画面中继续操作。`);
        refresh(n => n + 1);
      },
      onError: error => setError(error.message),
    });
    const inputError = (message, code) => {
      if (code === "window_changed" || message === messages.window_changed || message === "输入窗口已变化，请重新操作") {
        // Stale input is discarded and reset. Resizing capture with an error
        // banner here would create another geometry change and repeat it.
        setError("");
        current.current.onStatus(browser ? message : "窗口已切换。网页登录请点上方“网页登录”；返回应用请刷新。");
        return;
      }
      setError(message);
    };
    const transport = createMacWindowInput({
      element: surface.current,
      frame: () => frame.current,
      active: () => Boolean(current.current.screenVisible && current.current.input && frame.current),
      request: inputRequest,
      onError: (message, code) => { if (!recovery.pending) inputError(message, code); },
      onWindowChanged: () => recovery.recover(),
    });
    const preparePaste = () => {
      const lease = { target: transport.target(), epoch: generation.current, transport };
      return Object.assign(prepareClipboardPaste("desktop", "", { windowTarget: lease.target, valid: () => transport.valid(lease.target) }), { lease });
    };
    const input = installRemoteInput(transport, pane.current, {
      mode: () => current.current.keyboard,
      guestPlatform: () => "darwin",
      systemClipboard: () => true,
      copyText: (sendCopy, valid) => copyGuestText({ request: value => api("/clipboard/copy", value), sendCopy, valid }),
      surface: () => surface.current,
      inputLabel: "向 " + appName + " 输入",
      tabId: () => frame.current ? `${frame.current.pid}:${frame.current.window}:${frame.current.geometry}` : "",
      isActive: () => Boolean(current.current.screenVisible && current.current.input && frame.current),
      onStatus: text => current.current.onStatus(text),
      onFallback: (...values) => current.current.onFallback(...values),
      insertText: text => transport.send("text", { text }),
      caretRect: session => inputRequest("ime", { ...frame.current, mode: "status", session }).catch(error => {
        if (error.code === "unknown_action") setError(error.message);
        return { available: false };
      }),
      insertComposition: (_, value) => transport.send("ime", value).then(result => {
        if (value.mode !== "cancel" && !result.available) throw new Error("输入位置已变化，请重新输入");
        return result;
      }),
      preparePaste,
      pasteContent: (content, prepared) => receive(content, prepared?.lease || { target: transport.target(), epoch: generation.current, transport }, prepared),
    });
    controls.current = { transport, input };
    return () => {
      recovery.dispose();
      input.dispose(); transport.dispose();
      if (controls.current?.transport === transport) controls.current = null;
    };
  }, [screenVisible, state?.input, state?.persistent, inputChannel, image?.geometry, image?.pid, image?.window, image?.video]);

  function receive(content, lease, prepared) {
    const target = lease?.target || frame.current;
    const epoch = lease?.epoch ?? generation.current;
    const transport = lease?.transport || controls.current?.transport;
    const valid = () => target && epoch === generation.current && transport?.valid(target);
    const ready = Promise.resolve(content).then(value => ({ value }), error => ({ error }));
    if (!transport) { prepared?.dispose(); return Promise.reject(new Error("窗口尚未连接，请稍后重试")); }
    return transport.run(async () => {
      const { value, error } = await ready;
      if (error) throw error;
      if (!valid()) throw new Error("窗口已切换，请回到原窗口重新粘贴");
      setFileError(""); setTransferring(true);
      if (value.files || value.fileSelection) {
        await sendFiles(value, "desktop", "", { valid, windowTarget: target, onProgress: (loaded, total) => onStatus(total ? `正在传递附件 · ${Math.floor(loaded * 100 / total)}%` : "正在传递附件…") });
      } else if (value.png) {
        await sendImage(value, "desktop", "", { prepared });
      } else if (value.text) {
        await request("text", { ...target, text: value.text });
      }
      if (valid()) onStatus(value.text ? "已粘贴" : `附件已交给 ${appName}，请在应用中确认上传结果`);
    }).finally(() => { prepared?.dispose(); setTransferring(false); });
  }
  const fileFailure = error => { setFileError(error.message); onStatus(error.message); };
  async function chooseFiles() {
    const lease = { target: frame.current, epoch: generation.current, transport: controls.current?.transport };
    if (!nativeAvailable()) { pickerTarget.current = lease; picker.current?.click(); return; }
    try {
      const selected = await native("chooseUploadFiles", { multiple: true });
      if (!selected.canceled) await receive({ fileSelection: selected.fileSelection, kind: "paste" }, lease);
    } catch (error) { fileFailure(error); }
  }
  if (!visible) return null;
  return <section className="claude-desktop-view mac-claude" aria-label={"虚拟 Mac 中的 " + appName}>
    {(browser || !nativeAvailable()) && <BrowserUploads requests={uploads} onStatus={onStatus} />}
    <DesktopToolbar title={appName} desktop={state} platform="macOS" automatic zoomPreferenceKey={macDesktopZoomKey} zoom={zoom} setZoom={setZoom} onConfirm={onConfirm}
      onStop={browser ? undefined : () => action("stop")} refresh={() => {
        if (!browser && state?.running) void action("launch");
        else refresh(n => n + 1);
      }} refreshLabel={"激活并重新连接 " + appName} sidebarCollapsed={sidebarCollapsed} onExpand={onExpand}>
      {browser && <BrowserFavorites ready={Boolean(state?.installed)} onOpen={onOpenPage} />}
      <MacOSLogin />
      {!browser && <MacOSLogin manualConsole webSignIn label="网页登录" disabled={!state?.running}
        onOpenChange={setWebLoginOpen} onReturn={() => void action("launch")} />}
      {displayStats?.format && <details className="mac-frame-status">
        <summary>画面状态</summary>
        <div className="mac-frame-status-panel">
          <strong>{({ "video/h264": "H.264 视频", "image/jpeg": "JPEG 图像", "image/png": "PNG 清晰图像" })[displayStats.format]}</strong>
          <dl>
            <div><dt>画面像素</dt><dd>{displayStats.width} × {displayStats.height}</dd></div>
            <div><dt>画面更新</dt><dd>{displayStats.updatesPerSecond == null ? "正在测量" : `${displayStats.updatesPerSecond} 次/秒`}</dd></div>
            <div><dt>接收速率</dt><dd>{displayStats.bytesPerSecond == null ? "正在测量" : `${Math.round(displayStats.bytesPerSecond / 1024)} KiB/秒`}</dd></div>
            {displayStats.encodeMs != null && <div><dt>客机编码</dt><dd>{displayStats.encodeMs} ms</dd></div>}
            {displayStats.decodeDrawMs != null && <div><dt>解码与绘制提交</dt><dd>{displayStats.decodeDrawMs} ms</dd></div>}
          </dl>
          <p>统计已完成处理的画面更新。静止画面会暂停更新；此数值不代表显示器刷新率或完整输入延迟。</p>
          {displayStats.fallback && <p>{({
            webcodecs_unavailable: "当前显示组件不支持视频解码，使用图像传输。",
            video_decoder_unavailable: "视频解码不可用，已切换为兼容图像。",
            guest_image_fallback: "客机暂未提供视频帧，已切换为兼容图像。",
            sharp_png: "当前清晰模式使用无损 PNG 图像。",
            presentation_failed: "视频绘制失败，已切换为兼容图像。",
          })[displayStats.fallback]}</p>}
          {displayStats.fallback && displayStats.fallback !== "sharp_png" && <button onClick={() => refresh(n => n + 1)}>重试视频连接</button>}
        </div>
      </details>}
      {!browser && <button disabled={!state?.input || !image || transferring} onClick={() => void chooseFiles()}>添加附件</button>}
      {!browser && <input ref={picker} type="file" multiple hidden aria-label="选择 Claude 附件" onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ""; if (files.length) void receive({ files, kind: "paste" }, pickerTarget.current || undefined).catch(fileFailure); }} />}
      {(!state?.running || error) && <button onClick={() => action("launch")} disabled={!state?.installed}>{state?.running ? "重新连接应用" : "打开应用"}</button>}
      {state?.installed && !state.screen && <button onClick={() => action("request-screen")}>授权窗口画面</button>}
      {state?.installed && !state.input && <button onClick={() => action("request-input")}>授权键鼠</button>}
    </DesktopToolbar>
    {fileError && <p role="alert">{fileError}</p>}
    {state && !state.installed && <p>此虚拟 Mac 尚未安装 {appName}。</p>}
    {state?.running && !state.screen && <p>{messages.screen_recording_permission}</p>}
    {state?.running && state.screen && !state.input && <p>{messages.accessibility_permission}</p>}
    <div ref={pane} className="mac-claude-frame" style={{ "--desktop-zoom": zoom === "auto" ? 1 : zoom }}>
      {error && <p role="alert" className="mac-claude-error">{error}</p>}
      {image?.video ? <canvas ref={surface} key={image.geometry || `${image.pid}-${image.window}`} role="img" aria-label={appName + " 客机窗口"} /> : image && <img ref={surface} key={image.geometry || `${image.pid}-${image.window}`} alt={appName + " 客机窗口"} src={image.src} draggable={false}
        onLoad={e => {
          const img = e.currentTarget;
          const width = image.width || img.naturalWidth;
          const height = image.height || img.naturalHeight;
          img.style.setProperty("--frame-width", width + "px");
          img.style.setProperty("--frame-aspect", width / height);
          frame.current = { window: image.window, pid: image.pid, geometry: image.geometry, surface: browser ? "browser" : undefined };
          matchWindowBackground(img, pane.current, backgroundSample);
          requestAnimationFrame(() => image.acknowledge?.());
        }}
        onError={() => { frameConnection.current?.close(); frameConnection.current = null; frame.current = null; setImage(null); setError("窗口画面无法解码，请重新连接。"); }}
        />}
    </div>
  </section>;
}
