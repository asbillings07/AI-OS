/** @type {import('next').NextConfig} */
const nextConfig = {
  // The core/ai/skill packages ship as TypeScript source; let Next transpile them.
  transpilePackages: ["@orion/core", "@orion/ai", "@orion/gmail-skill", "@orion/fixtures"],
  experimental: {
    // better-sqlite3 is a native module; keep it out of the bundle (server-only).
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
  webpack: (config) => {
    // Our packages use ESM-style ".js" import specifiers that point at ".ts"
    // source (resolved natively by tsx/Vitest). Teach webpack the same mapping.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
