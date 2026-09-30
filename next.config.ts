import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // config/*.yaml + prompt_template.md are read at runtime, so ship them with every server route.
  outputFileTracingIncludes: {
    "/*": ["./config/**/*"],
  },
  poweredByHeader: false,
  devIndicators: false,
};

export default nextConfig;
