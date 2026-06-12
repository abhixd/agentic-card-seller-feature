import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These packages must not be bundled by Turbopack — they must be resolved
  // from node_modules at runtime inside the Lambda:
  //
  //   sharp             — native binary; platform-specific build installed by Vercel
  //   @techstark/opencv-js — 10 MB WASM blob embedded as a base64 data URI inside
  //                          opencv.js.  Bundling corrupts the URI and silently breaks
  //                          WASM initialization, causing every cropCard() call to hang.
  serverExternalPackages: ['sharp', '@techstark/opencv-js'],
};

export default nextConfig;
