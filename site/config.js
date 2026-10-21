// ============================================================================
// site/config.js — the only file you edit to point the web app at your project.
//
// Both values live in the Supabase dashboard → Settings → API.
// The anon key is PUBLIC by design: it only lets a signed-in user reach their
// own rows, because every table has row level security switched on.
// The service key must NEVER appear in this file — it belongs to the sweep job.
// ============================================================================

export const CONFIG = {
  supabaseUrl: 'https://xhweiyofwuyyrnbztkgx.supabase.co',
  supabaseAnonKey: 'sb_publishable_WWwGFVSyJQIh266YIz7GRA_shB_qR9_'
};

export function isConfigured() {
  return !!CONFIG.supabaseUrl &&
         !!CONFIG.supabaseAnonKey &&
         !CONFIG.supabaseUrl.includes('YOUR-PROJECT') &&
         !CONFIG.supabaseAnonKey.startsWith('YOUR-');
}
