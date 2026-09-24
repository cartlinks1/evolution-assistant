import type { NextConfig } from "next";

// Sites allowed to show the chat inside the bubble (iframe). Anything else is refused.
const FRAME_ANCESTORS = ["'self'", "https://evolutionwindshields.com", "https://*.evolutionwindshields.com", "https://*.myshopify.com"];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/embed",
        headers: [{ key: "Content-Security-Policy", value: `frame-ancestors ${FRAME_ANCESTORS.join(" ")}` }],
      },
      {
        source: "/((?!embed).*)",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
      {
        source: "/widget.js",
        headers: [{ key: "Cache-Control", value: "public, max-age=300" }],
      },
    ];
  },
};

export default nextConfig;
