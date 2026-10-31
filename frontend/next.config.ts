import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// The whole repo shares ../.env. Hosting providers set these as real env vars instead.
const rootEnv = resolve(process.cwd(), "../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Only these reach the browser. Never list the service role key here.
  env: {
    NEXT_SUPABASE_URL:
      process.env.NEXT_SUPABASE_URL || process.env.SUPABASE_URL || "",
    NEXT_SUPABASE_ANON_KEY:
      process.env.NEXT_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "",
    NEXT_KAKAO_MAP_KEY: process.env.NEXT_KAKAO_MAP_KEY ?? "",
  },
};

export default nextConfig;
