import { createAdminClient } from "@supabase/server/core";

// Service-role client for backend use — bypasses RLS.
// Reads SUPABASE_URL and SUPABASE_SECRET_KEY from process.env.
export const supabaseAdmin = createAdminClient();
