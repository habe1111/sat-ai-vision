import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 開発中に左下へ出る Next.js のバッジが、地図の縮尺表示と重なるため消す
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
