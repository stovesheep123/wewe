/* ============================================================
   supabase.js - Supabase クライアント初期化
   ============================================================ */

const SUPABASE_URL  = 'https://dvhukbghbvuyfnhjckjs.supabase.co';
const SUPABASE_KEY  = 'sb_publishable_19-gP5T7hwVS2qyzkzDL-Q_pih-3QBp';

// CDN から読み込んだ supabase グローバルを使って初期化
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
