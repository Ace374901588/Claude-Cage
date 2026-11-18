// Render only local synthetic frames in a separate headless Chrome profile.
// No Cage service, guest session, account or external page is accessed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const directory = mkdtempSync(path.join(tmpdir(), "cage-window-fit-"));
const css = readFileSync(process.env.CAGE_WINDOW_FIT_CSS || new URL("../src/macos-claude-window.css", import.meta.url), "utf8");
const cases = [
  { name: "adaptive canvas fills a larger pane", kind: "canvas", fit: "adaptive", pane: [1280, 800], source: [640, 400], expected: [1280, 800] },
  { name: "adaptive image fills a larger pane", kind: "img", fit: "adaptive", pane: [1280, 800], source: [640, 400], expected: [1280, 800] },
  { name: "fixed login keeps native text size", kind: "img", fit: "native", pane: [1280, 800], source: [320, 240], expected: [320, 240] },
  { name: "manual size remains explicit", kind: "canvas", fit: "native", zoom: 1.25, pane: [1280, 800], source: [640, 400], expected: [800, 500] },
  { name: "a narrow pane contains the full window", kind: "canvas", fit: "adaptive", pane: [480, 800], source: [1280, 800], expected: [480, 300] },
  { name: "a short pane contains the full window", kind: "img", fit: "adaptive", pane: [1280, 400], source: [1280, 800], expected: [640, 400] },
  { name: "resizing recomputes the fit", kind: "canvas", fit: "adaptive", pane: [1000, 700], source: [640, 400], expected: [1000, 625], initial: [1280, 800] },
];
const html = `<!doctype html><meta charset="utf-8"><style>${css}</style><body><pre id="result" data-status="pending"></pre><script>
const cases = ${JSON.stringify(cases)};
(async () => {
  const results = [];
  try {
    for (const item of cases) {
      const pane = document.createElement('div'); pane.className = 'mac-claude-frame'; pane.dataset.fit = item.fit;
      pane.style.width = (item.initial || item.pane)[0] + 'px'; pane.style.height = (item.initial || item.pane)[1] + 'px';
      pane.style.setProperty('--desktop-zoom', item.zoom || 1);
      const frame = document.createElement(item.kind);
      frame.width = item.source[0] * 2; frame.height = item.source[1] * 2;
      frame.style.setProperty('--frame-width', item.source[0] + 'px'); frame.style.setProperty('--frame-aspect', item.source[0] / item.source[1]);
      if (item.kind === 'img') {
        frame.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="' + frame.width + '" height="' + frame.height + '"></svg>');
        await frame.decode();
      }
      pane.append(frame); document.body.append(pane);
      frame.getBoundingClientRect();
      if (item.initial) { pane.style.width = item.pane[0] + 'px'; pane.style.height = item.pane[1] + 'px'; }
      const rect = frame.getBoundingClientRect();
      const passed = Math.abs(rect.width - item.expected[0]) < 1 && Math.abs(rect.height - item.expected[1]) < 1;
      results.push({ name: item.name, width: rect.width, height: rect.height, passed });
      pane.remove();
    }
    result.dataset.status = results.every(value => value.passed) ? 'passed' : 'failed';
    result.textContent = JSON.stringify(results);
  } catch (error) { result.dataset.status = 'failed'; result.textContent = error.message; }
})();</script>`;

try {
  const file = path.join(directory, "fit.html");
  writeFileSync(file, html);
  const output = execFileSync(process.env.CAGE_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost", `--user-data-dir=${path.join(directory, "profile")}`,
    "--virtual-time-budget=2500", "--dump-dom", pathToFileURL(file).href,
  ], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  const result = output.match(/<pre id="result" data-status="([^"]+)">([\s\S]*?)<\/pre>/);
  assert(result, "headless browser did not report layout results");
  assert.equal(result[1], "passed", result[2]);
  console.log(result[2]);
  console.log("Adaptive canvas/image, manual zoom, fixed login, narrow/short panes and resize passed.");
} finally { rmSync(directory, { recursive: true, force: true }); }
