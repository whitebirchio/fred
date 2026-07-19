import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // Keep the dev-only embedded database external so Turbopack doesn't bundle
  // its WASM (it self-locates files on disk). The Workers build is unaffected:
  // nothing imports PGlite statically, so it never enters the Worker bundle.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;

// Makes Cloudflare bindings/context available during `next dev` (no-op for
// production builds; the OpenNext adapter handles the deployed runtime).
initOpenNextCloudflareForDev();
