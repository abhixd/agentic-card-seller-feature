import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Sharp requires native binaries. Marking it as an external package tells
  // Next.js to exclude it from the serverless bundle and let Node resolve it
  // from node_modules at runtime (which is where Vercel installs platform-
  // specific binaries for the Lambda execution environment).
  serverExternalPackages: ['sharp'],
};

export default nextConfig;
