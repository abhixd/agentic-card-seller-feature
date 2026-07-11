// @acs/grading-contract — the stable boundary between the product and grading work streams.
// Import this in apps/web instead of hand-coding the grading response shape or URL.

export * from "./types";
import type { GradeResponse } from "./types";

/** Bump in lockstep with services/grading-api/contract.py CONTRACT_VERSION. */
export const CONTRACT_VERSION = "1.4.0";

export interface GradeInput {
  image: Blob | File;
  imageBack?: Blob | File;
  title?: string;
  price?: number;
  shipping?: number;
  /**
   * Optional MANUAL card outline — the user's 4 corners as [[x,y],...] in SOURCE-image pixels (the pixels of
   * `image`, ordered any way; the grader orders them). When set, SAM3 auto-segmentation is SKIPPED and the whole
   * grade (warp → centering → pillars) runs on this boundary. Use it to let a user override an inaccurate
   * auto-detected warp: grade once normally, and if the warped card looks wrong, re-grade with the picked corners.
   */
  contour?: [number, number][];
}

export interface GradeOptions extends Omit<RequestInit, "method" | "body"> {
  /** abort/timeout etc. */
}

/**
 * POST a card image to the grading service `/grade` and return the typed response.
 * `baseUrl` should come from config (e.g. process.env.GRADING_API_URL) so the app can point at the
 * Railway `production` deploy, a `dev` deploy, or a local mock without code changes.
 */
export async function gradeCard(baseUrl: string, input: GradeInput, opts: GradeOptions = {}): Promise<GradeResponse> {
  const fd = new FormData();
  fd.set("image", input.image);
  if (input.imageBack) fd.set("image_back", input.imageBack);
  if (input.title != null) fd.set("title", input.title);
  if (input.price != null) fd.set("price", String(input.price));
  if (input.shipping != null) fd.set("shipping", String(input.shipping));
  if (input.contour != null) fd.set("contour", JSON.stringify(input.contour));   // manual-boundary override → skips SAM3
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/grade`, { method: "POST", body: fd, ...opts });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`grade failed: ${res.status} ${detail}`.trim());
  }
  return (await res.json()) as GradeResponse;
}
