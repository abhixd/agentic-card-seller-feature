/** 4-point homography utilities — map warp-space boundary edits back into the ORIGINAL photo.
 *  The display warp was built as `_quad_padded` (source px) → the full warp rect, so a homography from
 *  the warp rect's corners to that quad sends any warp point (e.g. a user-corrected outer boundary)
 *  back into source coordinates for a manual-contour re-grade. */

/** Homography from 4 point correspondences (src → dst) via an 8×8 DLT solve; h33 = 1. */
export function homography4(src: number[][], dst: number[][]): number[] | null {
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [u, v] = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u)
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v)
  }
  const n = 8
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    if (Math.abs(M[piv][col]) < 1e-12) return null
    ;[M[col], M[piv]] = [M[piv], M[col]]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col] / M[col][col]
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row, i) => row[n] / M[i][i])
}

export function applyH(h: number[], x: number, y: number): [number, number] {
  const w = h[6] * x + h[7] * y + 1
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]
}

/** A warp-fraction box → 4 source-photo corner points (TL,TR,BR,BL), or null. */
export function warpBoxToSourceCorners(
  quadPadded: number[][],
  warpW: number,
  warpH: number,
  box: { x1: number; y1: number; x2: number; y2: number }
): number[][] | null {
  if (!quadPadded || quadPadded.length !== 4 || !warpW || !warpH) return null
  const h = homography4([[0, 0], [warpW, 0], [warpW, warpH], [0, warpH]], quadPadded)
  if (!h) return null
  return [
    applyH(h, box.x1 * warpW, box.y1 * warpH),
    applyH(h, box.x2 * warpW, box.y1 * warpH),
    applyH(h, box.x2 * warpW, box.y2 * warpH),
    applyH(h, box.x1 * warpW, box.y2 * warpH),
  ].map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10])
}
