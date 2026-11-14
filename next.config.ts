import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  headers() {
    return [{ source: "/models/fsaverage6.bin.gz", headers: [
      { key: "Content-Encoding", value: "gzip" },
      { key: "Content-Type", value: "application/octet-stream" },
    ] }];
  },
  // The dev badge sits on top of the panel footer.
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
