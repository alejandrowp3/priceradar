import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@priceradar/config",
    "@priceradar/domain",
    "@priceradar/providers",
    "@priceradar/database",
    "@priceradar/ui",
  ],
};

export default nextConfig;
