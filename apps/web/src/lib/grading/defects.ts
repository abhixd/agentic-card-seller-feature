/**
 * inflateBox — grow a defect box [x, y, w, h] (fractions 0..1 of the warped card) outward by `pad`
 * on every side, and floor each dimension to `min`, then clamp back inside the card. This keeps the
 * (thin) overlay stroke OFF the actual defect — so the box frames the defect instead of covering it —
 * and makes very small detections big enough to see. Used by the surface + edge/corner overlays.
 */
export function inflateBox(
  box: number[],
  min = 0.045,
  pad = 0.01,
): [number, number, number, number] {
  let [x, y, w, h] = box
  x -= pad; y -= pad; w += 2 * pad; h += 2 * pad
  if (w < min) { x -= (min - w) / 2; w = min }
  if (h < min) { y -= (min - h) / 2; h = min }
  w = Math.min(w, 1); h = Math.min(h, 1)
  x = Math.max(0, Math.min(x, 1 - w))
  y = Math.max(0, Math.min(y, 1 - h))
  return [x, y, w, h]
}
