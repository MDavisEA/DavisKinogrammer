"use strict";

import { readFrameTimes } from "./mp4times.js";

/* ===================================================================== *
 *  Sprint Cropper — client
 *  Server: upload, frame JPEGs, person detection.
 *  Client: navigation, athlete selection, cropping, board, grid export.
 * ===================================================================== */

const SLOT_COUNT = 10;
const COLS = 5;
const TILE_ASPECT = 4 / 5;          // width / height of every board tile
const CROP_PAD = 0.06;              // extra margin around the detected box (each side)
const DEFAULT_PHASES = ["Toe off", "Max vert pos", "Strike", "Touch down", "Full support"];

const $ = (id) => document.getElementById(id);
const el = {
  fileInput: $("fileInput"), stage: $("stage"), dropzone: $("dropzone"),
  frameWrap: $("frameWrap"), frameCanvas: $("frameCanvas"), video: $("video"), overlay: $("overlay"),
  uploading: $("uploading"), progressBar: $("progressBar"), uploadText: $("uploadText"),
  controls: $("controls"), scrubber: $("scrubber"),
  frameNum: $("frameNum"), frameTotal: $("frameTotal"), frameTime: $("frameTime"),
  videoName: $("videoName"), detectPill: $("detectPill"),
  addBtn: $("addBtn"), nextPersonBtn: $("nextPersonBtn"),
  board: $("board"), boardTitle: $("boardTitle"), filledCount: $("filledCount"),
  resetBtn: $("resetBtn"), downloadBtn: $("downloadBtn"), toast: $("toast"),
  phaseToggle: $("phaseToggle"), slotTotal: $("slotTotal"),
  refInclude: $("refInclude"), downloadLabel: $("downloadLabel"),
  helpDialog: $("helpDialog"), helpLink: $("helpLink"), helpLead: $("helpLead"), helpDetail: $("helpDetail"),
};

const state = {
  video: null,            // {id, name, frames, fps, width, height}
  frame: 0,               // frame the user wants
  shownFrame: -1,         // frame currently displayed
  loading: false,
  people: [],             // detections for shownFrame: [{box:[x1,y1,x2,y2] (0..1), conf}]
  peopleFrame: -1,
  selected: -1,           // index into people
  manualBox: null,        // {box, predicted:bool} — user-drawn or extrapolated box
  detections: new Map(),  // frame -> people (per video)
  slots: Array(SLOT_COUNT).fill(null), // {src, frame}
  active: 0,              // slot the next crop goes into
  trail: [],              // recent crops [{frame, box}] used to predict the athlete's position
  phases: [...DEFAULT_PHASES],
  phaseOn: Array(COLS).fill(true), // which phase columns are on the board and in the download
};

/* --------------------------------------------------------------------- utils */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
let toastTimer;
function toast(msg, isError = false) {
  el.toast.textContent = msg;
  el.toast.classList.toggle("error", isError);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
}
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ==================================================================== upload */
// Nothing is uploaded: the file is played straight from disk by a hidden <video>.
el.fileInput.addEventListener("change", () => {
  if (el.fileInput.files[0]) openVideo(el.fileInput.files[0]);
  el.fileInput.value = "";
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("dragover"); });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragover"); } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragover");
  const f = e.dataTransfer.files[0];
  if (f) openVideo(f);
});

const STD_FPS = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 90, 100, 119.88, 120, 239.76, 240];
const HELP_LEAD = el.helpLead.textContent;

// Help dialog: opened by the "Video won't open?" link, and automatically when a video fails to open.
function showHelp(failedName, detail) {
  el.helpLead.textContent = failedName
    ? "Couldn't open “" + failedName + "”. This almost always means the browser can't decode it. " +
      "iPhone videos use HEVC (H.265), which Chrome decodes with your computer's graphics hardware."
    : HELP_LEAD;
  el.helpDetail.hidden = !detail;
  el.helpDetail.textContent = detail ? "Technical detail: " + detail : "";
  if (!el.helpDialog.open) el.helpDialog.showModal();
}
el.helpLink.addEventListener("click", () => showHelp());
let videoSeq = 0;
let objectUrl = null;

const once = (target, ok, fail) => new Promise((res, rej) => {
  const done = (fn, v) => { target.removeEventListener(ok, onOk); target.removeEventListener(fail, onFail); fn(v); };
  const onOk = () => done(res);
  const onFail = () => done(rej, new Error(fail));
  target.addEventListener(ok, onOk);
  target.addEventListener(fail, onFail);
});

// <video> doesn't report its frame rate, so play a few frames and measure the gaps.
async function measureFps(v) {
  if (!("requestVideoFrameCallback" in v)) return { fps: 30, guessed: true };
  const times = [];
  await new Promise((resolve) => {
    const stop = () => { v.pause(); resolve(); };
    const timer = setTimeout(stop, 2500);
    const tick = (_, md) => {
      times.push(md.mediaTime);
      if (times.length >= 16) { clearTimeout(timer); stop(); } else v.requestVideoFrameCallback(tick);
    };
    v.requestVideoFrameCallback(tick);
    v.play().catch(() => { clearTimeout(timer); resolve(); });
  });
  const gaps = [];
  for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) gaps.push(times[i] - times[i - 1]);
  if (gaps.length < 3) return { fps: 30, guessed: true };
  gaps.sort((a, b) => a - b);
  const raw = 1 / gaps[Math.floor(gaps.length / 2)];
  const snap = STD_FPS.find((s) => Math.abs(s - raw) / s < 0.02);
  return { fps: snap || raw, guessed: false };
}

async function openVideo(file) {
  const seq = ++videoSeq;
  el.uploading.hidden = false;
  el.uploadText.textContent = "Opening " + file.name + "...";
  const v = el.video;
  try {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    v.src = objectUrl;
    v.load();
    await once(v, "loadeddata", "error");
    if (!v.videoWidth || !v.videoHeight) throw new Error("no video track");
    // Best: the real presentation time of every frame, read from the file's index (exact, even if the
    // frame rate varies). Fallback: play a few frames and measure a constant fps.
    el.uploadText.textContent = "Reading frame times...";
    const times = await readFrameTimes(file);
    if (seq !== videoSeq) return;
    let fps, frames;
    if (times) {
      frames = times.length;
      fps = (frames - 1) / (times[frames - 1] - times[0]);
    } else {
      el.uploadText.textContent = "Measuring frame rate...";
      const m = await measureFps(v);
      if (seq !== videoSeq) return;
      if (m.guessed) toast("Couldn't detect the frame rate, assuming 30 fps.");
      fps = m.fps;
      frames = Math.max(1, Math.round(v.duration * fps));
    }
    loadVideo({ id: seq, name: file.name, frames, fps, times, width: v.videoWidth, height: v.videoHeight });
  } catch (err) {
    const detail = (v.error && (v.error.message || "media error " + v.error.code)) || (err && err.message) || "unknown";
    console.error("openVideo failed:", err, v.error, "type:", file.type,
      "hevc:", v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'), "h264:", v.canPlayType('video/mp4; codecs="avc1.42E01E"'));
    if (seq === videoSeq) showHelp(file.name, detail);
  } finally {
    if (seq === videoSeq) el.uploading.hidden = true;
  }
}

function loadVideo(v) {
  state.video = v;
  state.detections = new Map();
  state.trail = [];
  state.shownFrame = -1;
  state.loading = false;
  el.frameCanvas.width = v.width;
  el.frameCanvas.height = v.height;
  el.videoName.textContent = v.name + " · " + v.width + "×" + v.height + " · " +
    v.fps.toFixed(2).replace(/\.?0+$/, "") + " fps · " + v.frames + " frames";
  el.scrubber.max = Math.max(0, v.frames - 1);
  el.frameTotal.textContent = v.frames - 1;
  el.controls.setAttribute("aria-disabled", "false");
  el.dropzone.hidden = true;
  el.frameWrap.hidden = false;
  el.stage.style.aspectRatio = clamp(v.width / v.height, 1, 2.4);
  layoutFrame();
  goTo(0);
}

/* ================================================================ navigation */
// Presentation time (s) of frame n: exact from the file's index when we have it, else n / fps.
function frameTime(n) {
  const { times, fps } = state.video;
  return times ? times[n] - times[0] : n / fps;
}

function goTo(n) {
  if (!state.video) return;
  state.frame = clamp(Math.round(n), 0, state.video.frames - 1);
  el.scrubber.value = state.frame;
  el.frameNum.textContent = state.frame;
  el.frameTime.textContent = frameTime(state.frame).toFixed(3) + " s";
  requestFrame();
}

let frameWaiters = [];

// Seek to the middle of frame n's time slot, then wait until that frame is actually presented.
async function seekToFrame(n) {
  // Aim for the middle of frame n's time slot so rounding can't land on a neighbour.
  const { times, fps } = state.video;
  const v = el.video, t = (times ? times[n] : n / fps) + 0.5 / fps;
  if (Math.abs(v.currentTime - t) > 1e-4) {
    const seeked = once(v, "seeked", "error");
    v.currentTime = t;
    await seeked;
  }
  if ("requestVideoFrameCallback" in v) {
    await new Promise((r) => { v.requestVideoFrameCallback(() => r()); setTimeout(r, 120); });
  }
}

// Only one seek in flight; when it lands, jump to whatever the user wants *now*.
async function requestFrame() {
  if (state.loading || state.frame === state.shownFrame) return;
  state.loading = true;
  const n = state.frame, vid = state.video.id;
  let ok = true;
  try { await seekToFrame(n); } catch (err) { ok = false; }
  state.loading = false;
  if (!state.video || state.video.id !== vid) return;
  if (!ok) {
    toast("Couldn't decode frame " + n + ".", true);
    frameWaiters.forEach((r) => r());
    frameWaiters = [];
    return;
  }
  el.frameCanvas.getContext("2d").drawImage(el.video, 0, 0, state.video.width, state.video.height);
  state.shownFrame = n;
  onFrameShown();
  if (state.frame !== n) requestFrame();
  else { frameWaiters.forEach((r) => r()); frameWaiters = []; }
}
const frameReady = () => state.shownFrame === state.frame && !state.loading
  ? Promise.resolve() : new Promise((r) => frameWaiters.push(r));

function onFrameShown() {
  state.people = [];
  state.peopleFrame = -1;
  state.selected = -1;
  state.manualBox = null;
  drawOverlay();
  scheduleDetect();
}

el.scrubber.addEventListener("input", () => goTo(+el.scrubber.value));
document.querySelectorAll("[data-step]").forEach((b) =>
  b.addEventListener("click", () => goTo(state.frame + +b.dataset.step)));

/* ================================================================= detection */
// YOLOv8-pose runs in a worker via ONNX Runtime Web (WASM). The frame is letterboxed to 640x640.
const MODEL_URL = new URL("./models/yolov8s-pose.onnx", import.meta.url).href;
const DETECT_CONF = 0.3, SIZE = 640;
const worker = new Worker(new URL("./detector.worker.js", import.meta.url), { type: "module" });
let jobId = 0;
const jobs = new Map();
let modelReady = false;
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "ready") { modelReady = true; el.detectPill.hidden = true; return; }
  const job = jobs.get(m.id);
  if (!job) return;
  jobs.delete(m.id);
  if (m.type === "result") job.res(m.people); else job.rej(new Error(m.message));
};
worker.onerror = () => toast("Couldn't start the detector in this browser.", true);
worker.postMessage({ type: "init", modelUrl: MODEL_URL }); // start loading the model right away

const lbCanvas = document.createElement("canvas");
lbCanvas.width = lbCanvas.height = SIZE;
const lbCtx = lbCanvas.getContext("2d", { willReadFrequently: true });

function detectFrame() {
  const src = el.frameCanvas, W = src.width, H = src.height;
  const scale = SIZE / Math.max(W, H);
  const w = Math.round(W * scale), h = Math.round(H * scale);
  const padX = Math.floor((SIZE - w) / 2), padY = Math.floor((SIZE - h) / 2);
  lbCtx.fillStyle = "rgb(114,114,114)";
  lbCtx.fillRect(0, 0, SIZE, SIZE);
  lbCtx.imageSmoothingQuality = "high";
  lbCtx.drawImage(src, 0, 0, W, H, padX, padY, w, h);
  const px = lbCtx.getImageData(0, 0, SIZE, SIZE).data;
  const input = new Float32Array(3 * SIZE * SIZE), plane = SIZE * SIZE;
  for (let i = 0; i < plane; i++) {
    input[i] = px[4 * i] / 255;
    input[plane + i] = px[4 * i + 1] / 255;
    input[2 * plane + i] = px[4 * i + 2] / 255;
  }
  const id = ++jobId;
  return new Promise((res, rej) => {
    jobs.set(id, { res, rej });
    worker.postMessage({ type: "detect", id, modelUrl: MODEL_URL, input, scale, padX, padY, W, H, conf: DETECT_CONF }, [input.buffer]);
  });
}

let detectTimer;

function scheduleDetect() {
  clearTimeout(detectTimer);
  detectTimer = setTimeout(() => runDetect(state.shownFrame), 180);
}

async function runDetect(n) {
  clearTimeout(detectTimer);
  if (!state.video || n < 0) return;
  if (state.peopleFrame === n) return;
  let people = state.detections.get(n);
  if (!people) {
    if (state.shownFrame !== n) return;
    el.detectPill.textContent = modelReady ? "Detecting..." : "Loading model...";
    el.detectPill.hidden = false;
    try {
      people = await detectFrame();
      state.detections.set(n, people);
    } catch (err) {
      toast("Detection failed for this frame.", true);
      return;
    } finally {
      el.detectPill.hidden = true;
    }
  }
  if (state.shownFrame !== n) return;
  state.people = people;
  state.peopleFrame = n;
  autoSelect(n);
  drawOverlay();
}

const centerX = (b) => (b[0] + b[2]) / 2;

// Where we expect the athlete to be, extrapolated from the last two crops.
function predictBox(n) {
  const t = state.trail;
  if (!t.length) return null;
  const b = t[t.length - 1];
  let dx = 0;
  if (t.length >= 2) {
    const a = t[t.length - 2];
    if (b.frame !== a.frame) dx = ((centerX(b.box) - centerX(a.box)) / (b.frame - a.frame)) * (n - b.frame);
  }
  const w = b.box[2] - b.box[0];
  const x1 = clamp(b.box[0] + dx, 0, 1 - w);
  return [x1, b.box[1], x1 + w, b.box[3]];
}

function autoSelect(n) {
  state.manualBox = null;
  if (!state.people.length) {
    const p = predictBox(n);
    state.selected = -1;
    if (p) state.manualBox = { box: p, predicted: true };
    return;
  }
  const p = predictBox(n);
  if (!p) { state.selected = 0; return; } // largest person
  // Best overlap with the predicted box (accounts for size, so a small bystander
  // next to the athlete doesn't win); fall back to nearest centre if nothing overlaps.
  let best = 0, bestIoU = 0, bestD = Infinity;
  state.people.forEach((person, i) => {
    const o = iou(person.box, p);
    const d = Math.abs(centerX(person.box) - centerX(p));
    if (o > bestIoU || (bestIoU === 0 && o === 0 && d < bestD)) { best = i; bestIoU = o; bestD = d; }
  });
  state.selected = best;
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / (area(a) + area(b) - inter || 1);
}

function nextPerson() {
  if (state.people.length === 0) { toast("No people detected in this frame."); return; }
  state.manualBox = null;
  state.selected = (state.selected + 1) % state.people.length;
  drawOverlay();
}
el.nextPersonBtn.addEventListener("click", nextPerson);

/* =================================================================== overlay */
function layoutFrame() {
  if (!state.video) return;
  const sw = el.stage.clientWidth, sh = el.stage.clientHeight;
  const ar = state.video.width / state.video.height;
  let w = sw, h = sw / ar;
  if (h > sh) { h = sh; w = sh * ar; }
  el.frameWrap.style.width = Math.floor(w) + "px";
  el.frameWrap.style.height = Math.floor(h) + "px";
  const dpr = window.devicePixelRatio || 1;
  el.overlay.width = Math.round(w * dpr);
  el.overlay.height = Math.round(h * dpr);
  drawOverlay();
}
new ResizeObserver(layoutFrame).observe(el.stage);

let dragBox = null;

function selectedBox() {
  if (state.manualBox) return state.manualBox.box;
  if (state.selected >= 0 && state.people[state.selected]) return state.people[state.selected].box;
  return null;
}

function drawOverlay() {
  const c = el.overlay, ctx = c.getContext("2d");
  const W = c.width, H = c.height, dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, W, H);
  if (!state.video) return;

  const accent = cssVar("--accent"), boxColor = cssVar("--box");
  const rect = (b) => [b[0] * W, b[1] * H, (b[2] - b[0]) * W, (b[3] - b[1]) * H];
  const label = (text, x, y, color) => {
    ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
    const tw = ctx.measureText(text).width + 10 * dpr, th = 18 * dpr;
    const ly = y - th < 0 ? y : y - th;
    ctx.fillStyle = color;
    ctx.fillRect(x, ly, tw, th);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, x + 5 * dpr, ly + 13 * dpr);
  };

  state.people.forEach((p, i) => {
    if (i === state.selected && !state.manualBox) return;
    const [x, y, w, h] = rect(p.box);
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = boxColor;
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.85;
    ctx.strokeRect(x, y, w, h);
    ctx.globalAlpha = 1;
    label(`${Math.round(p.conf * 100)}%`, x, y, boxColor);
  });

  const sel = dragBox || selectedBox();
  if (sel) {
    const [x, y, w, h] = rect(sel);
    const dashed = dragBox || state.manualBox?.predicted;
    ctx.fillStyle = "rgba(255, 90, 31, 0.10)";
    ctx.fillRect(x, y, w, h);
    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = accent;
    ctx.setLineDash(dashed ? [6 * dpr, 4 * dpr] : []);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    const text = dragBox ? "Custom box" : state.manualBox?.predicted ? "Predicted — not detected"
      : state.manualBox ? "Custom box" : "Athlete";
    label(text, x, y, accent);
  }
}

// Click a box to select it; drag to draw a custom box.
let pointerStart = null;
const toNorm = (e) => {
  const r = el.overlay.getBoundingClientRect();
  return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)];
};
el.overlay.addEventListener("pointerdown", (e) => {
  if (!state.video) return;
  el.overlay.setPointerCapture(e.pointerId);
  pointerStart = { p: toNorm(e), x: e.clientX, y: e.clientY };
});
el.overlay.addEventListener("pointermove", (e) => {
  if (!pointerStart) return;
  if (Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y) < 6 && !dragBox) return;
  const [ax, ay] = pointerStart.p, [bx, by] = toNorm(e);
  dragBox = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  drawOverlay();
});
el.overlay.addEventListener("pointerup", (e) => {
  if (!pointerStart) return;
  if (dragBox) {
    const big = (dragBox[2] - dragBox[0]) > 0.01 && (dragBox[3] - dragBox[1]) > 0.02;
    if (big) { state.manualBox = { box: dragBox, predicted: false }; state.selected = -1; }
  } else {
    const [px, py] = toNorm(e);
    // smallest box containing the click wins (handles overlapping people)
    let hit = -1, hitArea = Infinity;
    state.people.forEach((p, i) => {
      const [x1, y1, x2, y2] = p.box;
      const area = (x2 - x1) * (y2 - y1);
      if (px >= x1 && px <= x2 && py >= y1 && py <= y2 && area < hitArea) { hit = i; hitArea = area; }
    });
    if (hit >= 0) { state.selected = hit; state.manualBox = null; }
  }
  dragBox = null; pointerStart = null;
  drawOverlay();
});
el.overlay.addEventListener("pointercancel", () => { dragBox = null; pointerStart = null; drawOverlay(); });

/* =================================================================== cropping */
// Crop the box out of the displayed frame, padded and widened/heightened to the tile aspect.
function cropFrame(box) {
  const img = el.frameCanvas, W = img.width, H = img.height;
  let w = (box[2] - box[0]) * W, h = (box[3] - box[1]) * H;
  const cx = ((box[0] + box[2]) / 2) * W, cy = ((box[1] + box[3]) / 2) * H;
  w *= 1 + 2 * CROP_PAD; h *= 1 + 2 * CROP_PAD;
  if (w / h < TILE_ASPECT) w = h * TILE_ASPECT; else h = w / TILE_ASPECT;

  // If the crop is bigger than the frame, shrink it; otherwise slide it inside the frame.
  const fit = Math.min(1, W / w, H / h);
  w *= fit; h *= fit;
  const sx = clamp(cx - w / 2, 0, W - w), sy = clamp(cy - h / 2, 0, H - h);

  const outH = 1000, outW = Math.round(outH * TILE_ASPECT);
  const c = document.createElement("canvas");
  c.width = outW; c.height = outH;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, w, h, 0, 0, outW, outH);
  return c.toDataURL("image/jpeg", 0.92);
}

async function addToBoard() {
  if (!state.video) return;
  if (state.active < 0) { toast("Board is full — click a slot to replace it."); return; }
  await frameReady();
  if (!state.manualBox && state.peopleFrame !== state.shownFrame) await runDetect(state.shownFrame);
  const box = selectedBox();
  if (!box) { toast("No athlete found — drag a box around them on the frame."); return; }

  const slot = state.active;
  state.slots[slot] = { src: cropFrame(box), frame: state.shownFrame };
  state.trail.push({ frame: state.shownFrame, box });
  if (state.trail.length > 4) state.trail.shift();
  state.active = nextEmptySlot(slot);
  renderBoard();
}
el.addBtn.addEventListener("click", addToBoard);

const slotOn = (i) => state.phaseOn[i % COLS];

function nextEmptySlot(from) {
  for (let k = 1; k <= SLOT_COUNT; k++) {
    const i = (from + k + SLOT_COUNT) % SLOT_COUNT;
    if (slotOn(i) && !state.slots[i]) return i;
  }
  return -1;
}

function removeSlot(i) {
  state.slots[i] = null;
  state.active = i;
  renderBoard();
}

function removeCurrent() {
  if (state.active >= 0 && state.slots[state.active]) return removeSlot(state.active);
  for (let i = SLOT_COUNT - 1; i >= 0; i--) if (slotOn(i) && state.slots[i]) return removeSlot(i);
}

/* ====================================================================== board */
function buildBoard() {
  el.board.innerHTML = "";
  state.phases.forEach((name, i) => {
    const input = document.createElement("input");
    input.className = "phase-input";
    input.value = name;
    input.maxLength = 24;
    input.setAttribute("aria-label", `Phase ${i + 1} name`);
    input.addEventListener("input", () => { state.phases[i] = input.value; store.set("phases", state.phases); renderPhaseToggle(); });
    el.board.appendChild(input);
  });
  for (let i = 0; i < SLOT_COUNT; i++) {
    const s = document.createElement("div");
    s.className = "slot";
    s.tabIndex = 0;
    s.setAttribute("role", "button");
    s.dataset.index = i;
    s.addEventListener("click", (e) => {
      if (e.target.closest(".remove")) return;
      state.active = i; renderBoard();
    });
    s.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); state.active = i; renderBoard(); }
    });
    el.board.appendChild(s);
  }
  renderBoard();
}

function renderBoard() {
  const on = state.phaseOn.filter(Boolean).length;
  el.board.style.gridTemplateColumns = `repeat(${on}, minmax(0, 1fr))`;
  el.board.querySelectorAll(".phase-input").forEach((inp, j) => inp.classList.toggle("off", !state.phaseOn[j]));
  const slots = el.board.querySelectorAll(".slot");
  slots.forEach((s, i) => {
    s.classList.toggle("off", !slotOn(i));
    const data = state.slots[i];
    s.classList.toggle("filled", !!data);
    s.classList.toggle("active", i === state.active);
    s.setAttribute("aria-label", `${state.phases[i % COLS] || "Slot"} ${i < COLS ? "row 1" : "row 2"}${data ? `, frame ${data.frame}` : ", empty"}`);
    if (data) {
      if (s.dataset.src !== data.src) {
        s.innerHTML = `<img alt=""><span class="badge"></span>
          <button class="remove" title="Remove" aria-label="Remove frame">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
        s.querySelector("img").src = data.src;
        s.querySelector(".remove").addEventListener("click", () => removeSlot(i));
        s.dataset.src = data.src;
      }
      s.querySelector(".badge").textContent = `#${data.frame}`;
    } else if (s.dataset.src !== "") {
      s.innerHTML = `<span class="slot-num">${i + 1}</span>`;
      s.dataset.src = "";
    }
  });
  const filled = state.slots.filter((d, i) => d && slotOn(i)).length;
  el.filledCount.textContent = filled;
  el.slotTotal.textContent = on * (SLOT_COUNT / COLS);
  el.downloadBtn.disabled = filled === 0;
}

// Phase on/off buttons: turning a phase off hides its column (frames in it are kept, just not shown or exported).
function renderPhaseToggle() {
  if (el.phaseToggle.children.length !== COLS) {
    el.phaseToggle.innerHTML = "";
    for (let j = 0; j < COLS; j++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "phase-chip";
      b.addEventListener("click", () => togglePhase(j));
      el.phaseToggle.appendChild(b);
    }
  }
  [...el.phaseToggle.children].forEach((b, j) => {
    b.textContent = state.phases[j].trim() || "Phase " + (j + 1);
    b.setAttribute("aria-pressed", String(state.phaseOn[j]));
    b.title = state.phaseOn[j] ? "Click to leave this phase out" : "Click to include this phase";
  });
}

function togglePhase(j) {
  if (state.phaseOn[j] && state.phaseOn.filter(Boolean).length === 1) { toast("Keep at least one phase."); return; }
  state.phaseOn[j] = !state.phaseOn[j];
  store.set("phaseOn", state.phaseOn);
  if (state.active < 0 || !slotOn(state.active)) state.active = nextEmptySlot(-1);
  renderPhaseToggle();
  renderBoard();
}

el.resetBtn.addEventListener("click", () => {
  if (state.slots.some(Boolean) && !confirm("Clear all frames from the board?")) return;
  state.slots = Array(SLOT_COUNT).fill(null);
  state.active = nextEmptySlot(-1);
  state.trail = [];
  renderBoard();
});

el.boardTitle.value = store.get("title", "");
el.boardTitle.addEventListener("input", () => store.set("title", el.boardTitle.value));

/* ===================================================================== export */
const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

async function downloadGrid() {
  const TW = 600, TH = Math.round(TW / TILE_ASPECT), GAP = 10, PAD = 40;
  const title = el.boardTitle.value.trim();
  const TITLE_H = title ? 64 : 0, LABEL_H = 54;
  // Only the phases that are switched on, and only rows with at least one frame in them.
  const usedCols = [];
  for (let j = 0; j < COLS; j++) if (state.phaseOn[j]) usedCols.push(j);
  const usedRows = [];
  for (let r = 0; r < SLOT_COUNT / COLS; r++) {
    if (usedCols.some((j) => state.slots[r * COLS + j])) usedRows.push(r);
  }
  const cols = usedCols.length, rows = Math.max(1, usedRows.length);
  const W = PAD * 2 + cols * TW + (cols - 1) * GAP;
  const GRID_H = PAD + TITLE_H + LABEL_H + rows * TH + (rows - 1) * GAP;
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

  // Optional reference kinogram: the same phase columns, cut from the 5-column picture and lined up under the grid.
  let ref = null, REF_LABEL_H = 0, REF_H = 0;
  const REF_GAP = 48;
  if (el.refInclude.checked) {
    try {
      ref = await loadImage("reference/" + refView + ".webp");
      REF_LABEL_H = 44;
      REF_H = Math.round(TW * ref.naturalHeight / (ref.naturalWidth / COLS));
    } catch (err) {
      toast("Couldn't load the reference picture, downloading the grid without it.", true);
      ref = null;
    }
  }
  const H = GRID_H + (ref ? REF_GAP + REF_LABEL_H + REF_H : 0) + PAD;

  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  if (title) {
    ctx.fillStyle = "#111418";
    ctx.font = `700 36px ${FONT}`;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(title, PAD, PAD + 38, W - 2 * PAD);
  }

  const top = PAD + TITLE_H;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  usedCols.forEach((j, k) => {
    const x = PAD + k * (TW + GAP);
    ctx.fillStyle = "#111418";
    ctx.font = `650 24px ${FONT}`;
    ctx.fillText(state.phases[j] || "", x + TW / 2, top + LABEL_H / 2 - 6, TW - 16);
    ctx.fillStyle = "#ff5a1f";
    ctx.fillRect(x, top + LABEL_H - 10, TW, 4);
  });
  ctx.textAlign = "left";

  const imgs = await Promise.all(state.slots.map((s) => (s ? loadImage(s.src) : null)));
  imgs.forEach((img, i) => {
    const r = usedRows.indexOf(Math.floor(i / COLS)), k = usedCols.indexOf(i % COLS);
    if (!img || r < 0 || k < 0) return; // empty slots stay blank so the filled ones keep their phase column
    const x = PAD + k * (TW + GAP), y = top + LABEL_H + r * (TH + GAP);
    ctx.drawImage(img, x, y, TW, TH);
  });

  if (ref) {
    const y = GRID_H + REF_GAP;
    ctx.fillStyle = "#ff5a1f";
    ctx.fillRect(PAD, y - REF_GAP / 2, W - 2 * PAD, 2);
    ctx.fillStyle = "#111418";
    ctx.font = `650 26px ${FONT}`;
    ctx.textBaseline = "alphabetic";
    ctx.fillText("Reference: " + REF_ALT[refView], PAD, y + 28, W - 2 * PAD);
    ctx.imageSmoothingQuality = "high";
    const cw = ref.naturalWidth / COLS;
    usedCols.forEach((j, k) => {
      ctx.drawImage(ref, j * cw, 0, cw, ref.naturalHeight, PAD + k * (TW + GAP), y + REF_LABEL_H, TW, REF_H);
    });
  }

  const name = (title || "sprint-grid").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sprint-grid";
  c.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name + ".jpg";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, "image/jpeg", 0.93);
}
el.downloadBtn.addEventListener("click", downloadGrid);

/* ================================================================== keyboard */
window.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t.matches("input, textarea, select") || t.isContentEditable) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const step = e.shiftKey ? 10 : 1;
  switch (e.key) {
    case "ArrowRight": goTo(state.frame + step); break;
    case "ArrowLeft":  goTo(state.frame - step); break;
    case "ArrowUp":    goTo(state.frame + 60); break;
    case "ArrowDown":  goTo(state.frame - 60); break;
    case "Enter":      if (t.matches("button, summary")) return; addToBoard(); break;
    case "n": case "N": nextPerson(); break;
    case "Backspace": case "Delete": removeCurrent(); break;
    default: return;
  }
  e.preventDefault();
});

/* ================================================================= reference */
// Example kinogram to compare against: both legs, or one leg's stride at a time.
const REF_ALT = {
  "both-legs": "both legs",
  "left-leg": "left-leg toe-off",
  "right-leg": "right-leg toe-off",
};
const refImg = $("refImg");
const refBtns = document.querySelectorAll(".ref-btn");
let refView = "both-legs";
function showReference(key) {
  if (!REF_ALT[key]) key = "both-legs";
  refView = key;
  refImg.src = "reference/" + key + ".webp";
  refImg.alt = "Reference kinogram of an elite sprinter at toe-off, MVP, strike, touch-down and full-support, " + REF_ALT[key];
  refBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ref === key)));
  store.set("refView", key);
}
refBtns.forEach((b) => b.addEventListener("click", () => showReference(b.dataset.ref)));
showReference(store.get("refView", "both-legs"));
const refPanel = $("reference");
refPanel.open = store.get("refOpen", false);
refPanel.addEventListener("toggle", () => store.set("refOpen", refPanel.open));

// "Add this reference ... when downloading": the button label says so, so it's clear even with the panel closed.
function syncRefInclude() {
  el.downloadLabel.textContent = el.refInclude.checked ? "Download grid + reference" : "Download grid";
  store.set("refInclude", el.refInclude.checked);
}
el.refInclude.checked = store.get("refInclude", false) === true;
el.refInclude.addEventListener("change", syncRefInclude);
syncRefInclude();

/* ====================================================================== init */
const savedPhases = store.get("phases", null);
if (Array.isArray(savedPhases) && savedPhases.length === COLS) state.phases = savedPhases.map(String);
const savedOn = store.get("phaseOn", null);
if (Array.isArray(savedOn) && savedOn.length === COLS && savedOn.some(Boolean)) state.phaseOn = savedOn.map(Boolean);
state.active = nextEmptySlot(-1);
renderPhaseToggle();
buildBoard();
