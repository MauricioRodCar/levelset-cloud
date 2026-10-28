import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Migrations are read at runtime by /api/ready; make sure they ship in the standalone output.
  outputFileTracingIncludes: { "/api/ready": ["./drizzle/**/*"] },
};

export default nextConfig;
