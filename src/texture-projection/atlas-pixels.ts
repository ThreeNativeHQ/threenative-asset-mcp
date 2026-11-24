/**
 * Rules the painted atlas' exported pixels follow, shared by the browser app and its tests: the UV
 * gutter a mip level needs (C.2), what an unpainted texel becomes, and the fills and crops that keep a
 * later view's material the same as an accepted one. Node-safe (no DOM, no GPU) so the runner and the
 * unit tests read the same rules the browser applies.
 */
/** Visible coverage the hole pass paints up to, and the share below which a run says so (B, phase 2d). */
export const VISIBLE_COVERAGE_TARGET = 95;
export const VISIBLE_COVERAGE_WARN = 90;

/** Minimum UV-island gutter in atlas texels (C.2: >= 8 px, so mip levels 0-3 sample real colour). */
export const ATLAS_GUTTER_TEXELS = 8;

export interface InpaintReport {
  /** Share of the atlas' island texels no view painted, filled from the material around them. */
  readonly unpaintedPercent: number;
}

/**
 * Fill the texels no view painted (alpha < 128) from the painted texels around them and make the
 * atlas opaque: push-pull, a mip pyramid of weighted averages, so a gap continues the material that
 * surrounds it inside its own UV island.
 *
 * A single global mean colour was the 2c fill, and it is what made the courtyard floor look painted
 * (PRD-916 phase 2d): every texel the magnification guard or a rejected view left empty became the
 * atlas' average tone, so gaps between cobbles read as smooth white plaster patches with a tan seam.
 * Push-pull replaces that with the nearest painted material: a hole in the paving fills with paving.
 *
 * An island with no painted texel at all keeps alpha 0 in the atlas, so a later view or the hole pass
 * can still paint it; its exported colour is a guess pulled from the islands around it (nothing
 * closer exists), and `unpaintedPercent` says how much of the atlas that is.
 */
export function inpaintUnpainted(
  data: Uint8ClampedArray,
  islands: Uint8Array,
  size: number,
  fallback: [number, number, number] = [128, 128, 128],
): InpaintReport {
  const n = size * size;
  const val = new Float32Array(n * 3);
  const wt = new Float32Array(n);
  let islandTexels = 0;
  let paintedTexels = 0;
  for (let i = 0; i < n; i++) {
    if (islands[i]) islandTexels += 1;
    if (data[4 * i + 3]! < 128) continue;
    paintedTexels += 1;
    for (let c = 0; c < 3; c++) val[3 * i + c] = data[4 * i + c]!;
    wt[i] = 1;
  }
  // Nothing painted (a run that projected no view): keep the level's own clay-neutral tone rather
  // than inpainting from zeroes, which would be black.
  const field =
    paintedTexels > 0
      ? pushPull(val, wt, size, size)
      : Float32Array.from({ length: n * 3 }, (_, k) => fallback[k % 3]!);
  let unpainted = 0;
  for (let i = 0; i < n; i++) {
    if (data[4 * i + 3]! >= 128) continue;
    if (islands[i]) unpainted += 1;
    data[4 * i] = field[3 * i]!;
    data[4 * i + 1] = field[3 * i + 1]!;
    data[4 * i + 2] = field[3 * i + 2]!;
    data[4 * i + 3] = 255;
  }
  return { unpaintedPercent: islandTexels ? (100 * unpainted) / islandTexels : 0 };
}

/**
 * Push-pull interpolation: values known where `wt` > 0 spread smoothly into everything else (a cheap stand-in for
 * a membrane / Poisson fill). RGB float in, RGB float out.
 */
export function pushPull(val: Float32Array, wt: Float32Array, w: number, h: number): Float32Array {
  type L = { v: Float32Array; a: Float32Array; w: number; h: number };
  const levels: L[] = [{ v: val.slice(), a: wt.slice(), w, h }];
  for (let level = levels[0]!; level.w > 1 || level.h > 1; ) {
    const F = level;
    const cw = Math.max(1, Math.ceil(F.w / 2)), ch = Math.max(1, Math.ceil(F.h / 2));
    const v = new Float32Array(cw * ch * 3), a = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        let s0 = 0, s1 = 0, s2 = 0, sa = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const fx = 2 * x + dx, fy = 2 * y + dy;
            if (fx >= F.w || fy >= F.h) continue;
            const j = fy * F.w + fx, wj = F.a[j]!;
            s0 += F.v[3 * j]! * wj; s1 += F.v[3 * j + 1]! * wj; s2 += F.v[3 * j + 2]! * wj; sa += wj;
          }
        }
        const k = y * cw + x;
        if (sa > 0) { v[3 * k] = s0 / sa; v[3 * k + 1] = s1 / sa; v[3 * k + 2] = s2 / sa; }
        a[k] = Math.min(1, sa);
      }
    }
    level = { v, a, w: cw, h: ch };
    levels.push(level);
  }
  for (let li = levels.length - 2; li >= 0; li--) {
    const F = levels[li]!, C = levels[li + 1]!;
    for (let y = 0; y < F.h; y++) {
      const cy = Math.min(C.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(cy), y1 = Math.min(C.h - 1, y0 + 1), fy = cy - y0;
      for (let x = 0; x < F.w; x++) {
        const cx = Math.min(C.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(cx), x1 = Math.min(C.w - 1, x0 + 1), fx = cx - x0;
        const j = y * F.w + x, a = F.a[j]!;
        if (a >= 1) continue;
        for (let c = 0; c < 3; c++) {
          const top = C.v[3 * (y0 * C.w + x0) + c]! * (1 - fx) + C.v[3 * (y0 * C.w + x1) + c]! * fx;
          const bot = C.v[3 * (y1 * C.w + x0) + c]! * (1 - fx) + C.v[3 * (y1 * C.w + x1) + c]! * fx;
          F.v[3 * j + c] = a * F.v[3 * j + c]! + (1 - a) * (top * (1 - fy) + bot * fy);
        }
        F.a[j] = 1;
      }
    }
  }
  return levels[0]!.v;
}

/**
 * Window of a view that is most of already-accepted texture, for the consistency reference (C, phase 2d).
 *
 * `known` is 1 where the view shows texture a previous, accepted view painted. The window is chosen by
 * an integral image of that mask, so picking the densest `size` x `size` block is one pass, not a search
 * over every position. Returns the top-left corner, top-down pixel coordinates.
 */
export function paintedWindow(known: Uint8Array, w: number, h: number, size: number): { x: number; y: number } {
  const side = Math.min(size, w, h);
  if (side <= 0) return { x: 0, y: 0 };
  const stride = Math.max(1, Math.floor(side / 8));
  const integral = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += known[y * w + x] ? 1 : 0;
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1]! + row;
    }
  }
  let best = -1;
  let bestX = 0;
  let bestY = 0;
  for (let y = 0; y + side <= h; y += stride) {
    for (let x = 0; x + side <= w; x += stride) {
      const x1 = x + side;
      const y1 = y + side;
      const sum =
        integral[y1 * (w + 1) + x1]! -
        integral[y * (w + 1) + x1]! -
        integral[y1 * (w + 1) + x]! +
        integral[y * (w + 1) + x]!;
      if (sum > best) {
        best = sum;
        bestX = x;
        bestY = y;
      }
    }
  }
  return { x: bestX, y: bestY };
}

/** A square crop of a top-down RGBA image. */
export function cropRgba(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  size: number,
): Uint8ClampedArray {
  const side = Math.min(size, w - x, h - y);
  const out = new Uint8ClampedArray(side * side * 4);
  for (let row = 0; row < side; row++) {
    const from = ((y + row) * w + x) * 4;
    out.set(src.subarray(from, from + side * 4), row * side * 4);
  }
  return out;
}
