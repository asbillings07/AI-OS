/** @type {import('next').NextConfig} */
const nextConfig = {
  // The core/ai/skill packages ship as TypeScript source; let Next transpile them.
  transpilePackages: ["@orion/core", "@orion/ai", "@orion/gmail-skill", "@orion/fixtures"],
  // better-sqlite3 is a native module; keep it out of the bundle (server-only).
  // Stable top-level option in Next 15 (was experimental.serverComponentsExternalPackages).
  serverExternalPackages: ["better-sqlite3"],
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
