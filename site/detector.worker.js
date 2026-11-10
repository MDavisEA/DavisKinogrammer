// Runs YOLOv8-pose in a worker so the page stays responsive.
// Input  : Float32 CHW 1x3x640x640 (0..1 RGB, letterboxed)
// Output : normalised person boxes (0..1 of the original frame), sorted largest first.
import * as ort from "./vendor/ort.wasm.min.mjs";

const SIZE = 640;
const NMS_IOU = 0.45;
let session = null;
let loading = null;

ort.env.wasm.wasmPaths = new URL("./vendor/", import.meta.url).href;

async function load(modelUrl) {
  if (session) return session;
  if (!loading) {
    loading = ort.InferenceSession.create(modelUrl, { executionProviders: ["wasm"], graphOptimizationLevel: "all" })
      .then((s) => (session = s));
  }
  return loading;
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter || 1);
}

function postprocess(out, { scale, padX, padY, W, H, conf }) {
  // out: [1, 56, N] = cx, cy, w, h, score, 17 x (x, y, vis)
  const [, C, N] = out.dims;
  const d = out.data;
  const cands = [];
  for (let i = 0; i < N; i++) {
    const score = d[4 * N + i];
    if (score < conf) continue;
    const cx = d[i], cy = d[N + i], w = d[2 * N + i], h = d[3 * N + i];
    const kp = [];
    for (let k = 0; k < (C - 5) / 3; k++) kp.push([d[(5 + 3 * k) * N + i], d[(6 + 3 * k) * N + i], d[(7 + 3 * k) * N + i]]);
    cands.push({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, score, kp });
  }
  cands.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const c of cands) if (keep.every((k) => iou(k, c) < NMS_IOU)) keep.push(c);

  const nx = (x) => Math.min(1, Math.max(0, (x - padX) / scale / W));
  const ny = (y) => Math.min(1, Math.max(0, (y - padY) / scale / H));
  const people = keep.map((c) => ({
    box: [nx(c.x1), ny(c.y1), nx(c.x2), ny(c.y2)],
    conf: Math.round(c.score * 1000) / 1000,
    kp: c.kp.map(([x, y, v]) => [nx(x), ny(y), Math.round(v * 100) / 100]),
  }));
  people.sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]));
  return people;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      await load(m.modelUrl);
      self.postMessage({ type: "ready" });
    } else if (m.type === "detect") {
      await load(m.modelUrl);
      const input = new ort.Tensor("float32", m.input, [1, 3, SIZE, SIZE]);
      const res = await session.run({ [session.inputNames[0]]: input });
      const people = postprocess(res[session.outputNames[0]], m);
      self.postMessage({ type: "result", id: m.id, people });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, message: String((err && err.message) || err) });
  }
};
