// Reads the presentation time of every video frame from an MP4/MOV file's index (the "moov" box),
// so frame stepping stays exact on variable-frame-rate phone footage. Only the index is read, never the
// video data. Returns null for anything we can't parse (the caller then falls back to a measured fps).

const u32 = (dv, o) => dv.getUint32(o);
const i32 = (dv, o) => dv.getInt32(o);
const tag = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

// Child boxes of dv[start, end).
function children(dv, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(dv, o);
    const type = tag(dv, o + 4);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; }
    else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) break;
    out.push({ type, start: o + hdr, end: o + size });
    o += size;
  }
  return out;
}
const find = (dv, box, type) => children(dv, box.start, box.end).find((b) => b.type === type);

async function readMoov(file) {
  let off = 0;
  while (off + 8 <= file.size) {
    const head = new DataView(await file.slice(off, off + 16).arrayBuffer());
    let size = u32(head, 0);
    const type = tag(head, 4);
    if (size === 1) size = Number(head.getBigUint64(8));
    else if (size === 0) size = file.size - off;
    if (size < 8) return null;
    if (type === "moov") return new DataView(await file.slice(off + 8, off + size).arrayBuffer());
    off += size;
  }
  return null;
}

export async function readFrameTimes(file) {
  try {
    const dv = await readMoov(file);
    if (!dv) return null;
    const root = { start: 0, end: dv.byteLength };
    const mvhd = find(dv, root, "mvhd");
    const movieScale = mvhd ? u32(dv, mvhd.start + (dv.getUint8(mvhd.start) === 1 ? 20 : 12)) : 1000;

    for (const trak of children(dv, root.start, root.end).filter((b) => b.type === "trak")) {
      const mdia = find(dv, trak, "mdia");
      if (!mdia) continue;
      const hdlr = find(dv, mdia, "hdlr");
      if (!hdlr || tag(dv, hdlr.start + 8) !== "vide") continue;

      const mdhd = find(dv, mdia, "mdhd");
      const scale = u32(dv, mdhd.start + (dv.getUint8(mdhd.start) === 1 ? 20 : 12));
      const stbl = find(dv, find(dv, mdia, "minf"), "stbl");

      // decode timestamps from stts
      const stts = find(dv, stbl, "stts");
      const dts = [];
      let t = 0;
      const nStts = u32(dv, stts.start + 4);
      for (let e = 0; e < nStts; e++) {
        const count = u32(dv, stts.start + 8 + e * 8), delta = u32(dv, stts.start + 12 + e * 8);
        for (let k = 0; k < count; k++) { dts.push(t); t += delta; }
      }

      // composition offsets (B-frame reordering) from ctts
      const ctts = find(dv, stbl, "ctts");
      if (ctts) {
        let i = 0;
        const nCtts = u32(dv, ctts.start + 4);
        for (let e = 0; e < nCtts && i < dts.length; e++) {
          const count = u32(dv, ctts.start + 8 + e * 8), off = i32(dv, ctts.start + 12 + e * 8);
          for (let k = 0; k < count && i < dts.length; k++) dts[i++] += off;
        }
      }

      // edit list: the browser shifts the timeline by the first non-empty edit
      let shift = 0, lead = 0;
      const edts = find(dv, trak, "edts");
      const elst = edts && find(dv, edts, "elst");
      if (elst) {
        const v = dv.getUint8(elst.start), n = u32(dv, elst.start + 4);
        let o = elst.start + 8;
        for (let e = 0; e < n; e++) {
          let dur, mt;
          if (v === 1) { dur = Number(dv.getBigUint64(o)); mt = Number(dv.getBigInt64(o + 8)); o += 20; }
          else { dur = u32(dv, o); mt = i32(dv, o + 4); o += 12; }
          if (mt === -1) lead += dur / movieScale;
          else { shift = mt; break; }
        }
      }

      // frames the edit list cuts off (before time 0) are never shown, so they aren't steppable either
      const times = Float64Array.from(dts, (x) => (x - shift) / scale + lead).sort().filter((x) => x >= -1e-6);
      return times.length >= 2 ? times : null;
    }
    return null;
  } catch (err) {
    return null;
  }
}
