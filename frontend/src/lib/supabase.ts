import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_SUPABASE_URL;
const key = process.env.NEXT_SUPABASE_ANON_KEY;

// null when the env vars are missing: the app then falls back to local mock data.
export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;
