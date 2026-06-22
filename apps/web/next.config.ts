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
  // @acs/grading-contract ships raw TypeScript — Next must transpile it.
  transpilePackages: ['@acs/grading-contract'],
};

export default nextConfig;
