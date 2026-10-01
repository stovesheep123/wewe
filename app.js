/* ============================================================
   wewe - app.js  先生/生徒 Chat + Feed + Requests
   ============================================================ */
'use strict';

// ==================== 状態 ====================
let currentUser    = null;
let currentProfile = null;
let allProfiles    = [];
let conversations  = [];
let activeConvId   = null;
let activePartner  = null;
let pendingFiles   = [];      // chat attach
let annFiles       = [];      // announcement attach
let feedFilter     = 'all';   // 'all' | 'exam' | 'test' | 'announce'
let pendingReqId   = null;    // popup中のリクエストID

let msgChannel  = null;
let convChannel = null;
let annChannel  = null;
let reqChannel  = null;

// ==================== 起動 ====================
document.addEventListener('DOMContentLoaded', async () => {
  setupAuthUI();
  const { data: { session } } = await sb.auth.getSession();
  if (session) await onSignedIn(session.user);
  else showAuthScreen();

  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN'  && session) await onSignedIn(session.user);
    if (event === 'SIGNED_OUT')             onSignedOut();
  });
});

// ==================== 認証UI ====================
function setupAuthUI() {
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const t = tab.dataset.auth;
      document.getElementById('loginForm').classList.toggle('hidden', t !== 'login');
      document.getElementById('registerForm').classList.toggle('hidden', t !== 'register');
    });
  });

  document.querySelectorAll('.pw-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById(btn.dataset.target);
      if (!inp) return;
      inp.type = inp.type === 'password' ? 'text' : 'password';
      btn.textContent = inp.type === 'password' ? '👁' : '🙈';
    });
  });

  document.getElementById('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const handle = document.getElementById('loginHandle').value.trim().toLowerCase().replace(/[^a-z0-9_]/g,'');
    const pw     = document.getElementById('loginPassword').value;
    const err    = document.getElementById('loginError');
    err.textContent = '';
    if (!handle || !pw) { err.textContent = '全項目を入力してください'; return; }
    setBtnLoading('loginForm', true, 'ログイン');
    const { error } = await sb.auth.signInWithPassword({ email: handle + '@wewe.local', password: pw });
    setBtnLoading('loginForm', false, 'ログイン');
    if (error) err.textContent = authErr(error.message);
  });

  document.getElementById('registerForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name   = document.getElementById('regName').value.trim();
    const handle = document.getElementById('regHandle').value.trim().replace(/[^a-zA-Z0-9_]/g,'').toLowerCase();
    const pw     = document.getElementById('regPassword').value;
    const color  = document.getElementById('regColor').value;
    const role   = (document.querySelector('input[name="regRole"]:checked') || {}).value || 'seito';
    const err    = document.getElementById('registerError');
    err.textContent = '';
    if (!name)             { err.textContent = '表示名を入力してください'; return; }
    if (handle.length < 2) { err.textContent = 'ユーザー名は2文字以上'; return; }
    if (pw.length < 6)     { err.textContent = 'パスワードは6文字以上'; return; }
    const { data: ex } = await sb.from('profiles').select('handle').eq('handle', handle).maybeSingle();
    if (ex) { err.textContent = 'そのユーザー名は使われています'; return; }
    setBtnLoading('registerForm', true, '登録する');
    const { error } = await sb.auth.signUp({
      email: handle + '@wewe.local', password: pw,
      options: { data: { handle, name, color, role } },
    });
    setBtnLoading('registerForm', false, '登録する');
    if (error) err.textContent = authErr(error.message);
  });
}

function setBtnLoading(formId, loading, label) {
  const btn = document.querySelector(`#${formId} .auth-submit-btn`);
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? '処理中...' : label;
}
function authErr(msg) {
  if (msg.includes('Invalid login'))       return 'ユーザー名またはパスワードが違います';
  if (msg.includes('Email not confirmed')) return 'メール確認が必要です';
  if (msg.includes('already registered')) return 'そのユーザー名は既に登録されています';
  if (msg.includes('Password'))           return 'パスワードは6文字以上';
  return msg;
}

// ==================== サインイン/アウト ====================
async function onSignedIn(authUser) {
  currentUser = authUser;
  let profile = null;
  for (let i = 0; i < 6; i++) {
    const { data } = await sb.from('profiles').select('*').eq('id', authUser.id).maybeSingle();
    if (data) { profile = data; break; }
    await sleep(700);
  }
  if (!profile) { showToast('プロフィール読み込み失敗。再読み込みしてください。'); return; }
  currentProfile = profile;
  showAppScreen();
  await initApp();
}

function onSignedOut() {
  currentUser = currentProfile = activeConvId = activePartner = pendingReqId = null;
  allProfiles = conversations = pendingFiles = annFiles = nbFiles = [];
  nbPosts = []; nbFilter = 'all'; nbEditId = null;
  myGoal = null;
  srResources = []; srSubject = 'math'; srLevel = 'jhs'; srTypeFilter = 'all'; srEditId = null;
  feedFilter = 'all';
  if (cdInterval) { clearInterval(cdInterval); cdInterval = null; }
  if (infoHubRefreshTimer) { clearInterval(infoHubRefreshTimer); infoHubRefreshTimer = null; }
  if (goalsChannel) { sb.removeChannel(goalsChannel); goalsChannel = null; }
  cleanupRealtime();
  document.getElementById('loginHandle').value = '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').textContent = '';
  showAuthScreen();
}

function showAuthScreen() {
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('appScreen').classList.add('hidden');
}
function showAppScreen() {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('appScreen').classList.remove('hidden');
}

// ==================== アプリ初期化 ====================
async function initApp() {
  renderSidebarProfile();
  setupNavTabs();
  setupLogout();
  setupLightbox();
  setupProfileModal();

  await loadAllProfiles();

  // ロールに応じてUI表示
  if (currentProfile.role === 'sensei') {
    document.querySelectorAll('.sensei-only').forEach(el => el.classList.remove('hidden'));
  } else {
    document.querySelectorAll('.seito-only').forEach(el => el.classList.remove('hidden'));
  }

  // フィード
  setupFeedTabs();
  setupAnnModal();
  setupRequestModal();
  await loadAnnouncements();
  setupInfoHub();

  // チャット
  setupNewChatModal();
  setupChatInput();
  await loadConversations();
  renderConvList();

  // メンバー
  renderUsersList();

  // 先生: 許可管理
  if (currentProfile.role === 'sensei') {
    await renderPermissionsPanel();
    setupReqPopup();
  }

  setupRealtime();
}

// ==================== サイドバープロフィール ====================
function renderSidebarProfile() {
  const av = document.getElementById('sidebarAvatar');
  if (av) setAvatarEl(av, currentProfile, 'sm');
  setText('sidebarName',   currentProfile.name);
  setText('sidebarHandle', '@' + currentProfile.handle);
  const badge = document.getElementById('currentUserBadge');
  if (badge) {
    badge.textContent = currentProfile.role === 'sensei' ? '👨‍🏫 先生' : '🎓 生徒';
    badge.className = 'current-user-badge ' + currentProfile.role;
  }
}

// ==================== ナビタブ ====================
function setupNavTabs() {
  const panels = {
    home:         ['homePanel',            'homeView'],
    chat:         ['chatPanel-side',       'chatView'],
    users:        ['usersPanel',           'usersView'],
    noticeboard:  ['noticeboard-side',     'noticeboardView'],
    goals:        ['goalsPanel',           'goalsView'],
    subjects:     ['subjectsPanel',        'subjectsView'],
    permissions:  ['permissionsPanel-side','permissionsView'],
  };

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;

      // サイドパネル切り替え
      Object.values(panels).forEach(([sp]) => document.getElementById(sp)?.classList.add('hidden'));
      document.getElementById(panels[view]?.[0])?.classList.remove('hidden');

      // メインビュー切り替え
      Object.values(panels).forEach(([, mv]) => document.getElementById(mv)?.classList.add('hidden'));
      document.getElementById(panels[view]?.[1])?.classList.remove('hidden');

      // 掲示板は初回表示時に初期化
      if (view === 'noticeboard' && !nbPosts.length) initNoticeBoard();
      // 目標は初回表示時に初期化
      if (view === 'goals') initGoals();
      // 教科は初回表示時に初期化
      if (view === 'subjects' && !srResources.length) initSubjects();
    });
  });
}

// ==================== ログアウト ====================
function setupLogout() {
  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    if (!confirm('ログアウトしますか？')) return;
    await sb.auth.signOut();
  });
}

// ==================== 全プロフィール ====================
async function loadAllProfiles() {
  const { data } = await sb.from('profiles').select('*').order('created_at');
  if (data) allProfiles = data;
}
function getProfile(id) { return allProfiles.find(p => p.id === id) || null; }

// ============================================================
//  FEED タブ
// ============================================================
function setupFeedTabs() {
  document.querySelectorAll('.feed-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.feed-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      feedFilter = btn.dataset.feed;
      renderAnnFeed();
    });
  });
}

// ============================================================
//  INFO HUB  (入試ニュース・勉強情報・模試・オープンハイスクール)
// ============================================================
let infoHubRefreshTimer = null;
const INFO_HUB_REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes

// Curated study resources — always available, no network needed
const STUDY_RESOURCES = {
  free: [
    { name: 'NHK for School',        url: 'https://www.nhk.or.jp/school/',          icon: '📺', desc: '理科・社会・国語など全教科の動画授業。無料で視聴可能' },
    { name: 'すらら',                url: 'https://surala.jp/',                      icon: '💻', desc: '中学・高校の全教科をアニメ動画で学べるオンライン教材' },
    { name: 'スタディサプリ',        url: 'https://studysapuri.jp/',                 icon: '📱', desc: '月額定額で有名講師の映像授業が見放題。中学〜大学受験対応' },
    { name: 'Quizlet',               url: 'https://quizlet.com/ja',                  icon: '🃏', desc: '単語帳・フラッシュカードで英語・社会の暗記に最適' },
    { name: 'Khan Academy (日本語)', url: 'https://ja.khanacademy.org/',             icon: '🎓', desc: '数学・理科を段階的に学べる無料プラットフォーム' },
    { name: 'e-Stat 統計で学ぶ',     url: 'https://www.e-stat.go.jp/',               icon: '📊', desc: '社会科のデータ調べに便利な政府統計ポータル' },
    { name: '古文単語・文法まとめ',  url: 'https://kobun.weblio.jp/',                icon: '📜', desc: '古文の単語・助動詞・文法をまとめて確認できる辞典' },
    { name: 'Duolingo',              url: 'https://ja.duolingo.com/',                icon: '🦜', desc: '英語・他の外国語を楽しく習慣化できるゲーム感覚アプリ' },
  ],
  exam: [
    { name: '大学入試センター公式',  url: 'https://www.dnc.ac.jp/',                  icon: '🏛️', desc: '共通テストの公式情報・過去問・出願日程' },
    { name: '東京都教育委員会',      url: 'https://www.metro.ed.jp/',                icon: '🗼', desc: '都立高校入試情報・入試問題・スピーキングテスト' },
    { name: '文部科学省',            url: 'https://www.mext.go.jp/',                 icon: '📋', desc: '学習指導要領・入試制度の公式情報' },
    { name: '旺文社 入試情報',       url: 'https://www.obunsha.co.jp/',              icon: '📚', desc: '入試データ・過去問・参考書の老舗' },
    { name: 'Benesse 進研ゼミ',      url: 'https://www.benesse.co.jp/',              icon: '✏️', desc: '高校・大学受験対策の情報と模試日程' },
    { name: '河合塾 入試情報',       url: 'https://www.keinet.ne.jp/',               icon: '📈', desc: '大学偏差値・入試難易度・合格ボーダーライン' },
  ],
  tips: [
    { name: 'ポモドーロ・テクニック', url: 'https://studyhacker.net/pomodoro-technique', icon: '🍅', desc: '25分集中→5分休憩を繰り返す最強の集中法' },
    { name: '分散学習のすすめ',       url: 'https://studyhacker.net/distributed-practice', icon: '🧠', desc: '毎日少しずつ繰り返すことで記憶定着率が大幅アップ' },
    { name: '睡眠と記憶の科学',       url: 'https://www.sleepfoundation.org/how-sleep-works/memory', icon: '😴', desc: '睡眠中に記憶が定着。7〜8時間の睡眠が学習効率を高める' },
  ],
};

// RSS feeds tried in order — first success wins
const NEWS_FEEDS = [
  { url: 'https://api.allorigins.win/get?url=' + encodeURIComponent('https://www3.nhk.or.jp/rss/news/cat6.xml'),              tag: 'NHK教育',  tagClass: 'tag-nyushi',  keywords: ['入試','受験','高校','大学','試験'] },
  { url: 'https://api.allorigins.win/get?url=' + encodeURIComponent('https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml'),      tag: '教育ニュース', tagClass: 'tag-study', keywords: [] },
  { url: 'https://api.allorigins.win/get?url=' + encodeURIComponent('https://www.asahi.com/rss/asahi/newsheadlines.rdf'),       tag: '朝日新聞',  tagClass: 'tag-nyushi',  keywords: ['入試','受験','高校','大学'] },
];

// Static fallback news items shown when all RSS fail
const FALLBACK_NEWS = [
  { title: '2027年度 大学入学共通テスト 出願受付スケジュール発表',   link: 'https://www.dnc.ac.jp/', pub: '2026-10-01', tag: '共通テスト', tagClass: 'tag-daigaku' },
  { title: '都立高校入試 英語スピーキングテスト 実施要項発表',       link: 'https://www.metro.ed.jp/', pub: '2026-09-20', tag: '高校入試', tagClass: 'tag-koukou' },
  { title: '私立高校 推薦・単願入試 出願期間まとめ 2027年度版',    link: 'https://www.obunsha.co.jp/', pub: '2026-09-15', tag: '高校入試', tagClass: 'tag-koukou' },
  { title: '国公立大学 2次試験 日程・倍率速報',                     link: 'https://www.keinet.ne.jp/', pub: '2026-09-10', tag: '大学入試', tagClass: 'tag-daigaku' },
  { title: '大学入学共通テスト 数学・理科の出題傾向分析 最新版',     link: 'https://www.dnc.ac.jp/', pub: '2026-09-05', tag: '共通テスト', tagClass: 'tag-daigaku' },
  { title: '高校受験 英検・数検の活用校が増加 最新動向',            link: 'https://www.obunsha.co.jp/', pub: '2026-08-28', tag: '高校入試', tagClass: 'tag-koukou' },
];

const FALLBACK_MOSHI = [
  { title: '進研模試 高1・高2 2026年11月実施 申込受付中',          link: 'https://www.benesse.co.jp/zemi/examination/', pub: '2026-10-01', tag: '進研模試',  tagClass: 'tag-moshi', source: 'Benesse' },
  { title: '河合塾 全統共通テスト模試 11月 申込締切10/15',         link: 'https://www.kawai-juku.ac.jp/moshi/',           pub: '2026-09-25', tag: '河合塾',    tagClass: 'tag-moshi', source: '河合塾' },
  { title: '駿台模試 高3・高卒生 第3回 11月実施',                  link: 'https://www.sundai.ac.jp/exam/',                pub: '2026-09-20', tag: '駿台',      tagClass: 'tag-moshi', source: '駿台' },
  { title: '東京都 中学生 都立高校進学相談模試 実施要項',           link: 'https://www.metro.ed.jp/',                      pub: '2026-09-15', tag: '都立入試',  tagClass: 'tag-moshi', source: '東京都' },
  { title: '旺文社 全国統一中学生テスト 11月3日 無料実施',         link: 'https://www.obunsha.co.jp/service/zentoko/',    pub: '2026-09-10', tag: '無料模試',  tagClass: 'tag-moshi', source: '旺文社' },
  { title: 'Z会 高校受験コース 模擬試験 2026年秋期 受付開始',      link: 'https://www.zkai.co.jp/',                       pub: '2026-09-05', tag: 'Z会',       tagClass: 'tag-moshi', source: 'Z会' },
];

const FALLBACK_OPEN = [
  { title: '開成高校 第1回 学校説明会 10月19日(日) 要予約',       link: 'https://www.kaiseigakuen.jp/',   pub: '2026-10-01', tag: '私立高校', tagClass: 'tag-open', source: '開成' },
  { title: '都立日比谷高校 オープンスクール 11月2日 申込開始',     link: 'https://www.metro.ed.jp/',      pub: '2026-09-28', tag: '都立高校', tagClass: 'tag-open', source: '都立日比谷' },
  { title: '慶應義塾高校 学校見学会 10月25日 受付中',             link: 'https://www.khs.keio.ac.jp/',   pub: '2026-09-20', tag: '私立高校', tagClass: 'tag-open', source: '慶應' },
  { title: '早稲田実業 文化祭・学校説明会 11月8日',               link: 'https://www.wasedajg.ed.jp/',   pub: '2026-09-18', tag: '私立高校', tagClass: 'tag-open', source: '早実' },
  { title: '筑波大学附属駒場 学校説明会 11月15日',                link: 'https://www.komaba-s.tsukuba.ac.jp/', pub: '2026-09-15', tag: '国立高校', tagClass: 'tag-open', source: '筑駒' },
  { title: '都立西高校 オープンスクール 10月12日 申込締切10/5',   link: 'https://www.metro.ed.jp/',      pub: '2026-09-10', tag: '都立高校', tagClass: 'tag-open', source: '都立西' },
];

function setupInfoHub() {
  // Tab switching
  document.querySelectorAll('.info-hub-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.info-hub-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.infotab;
      ['news','study','moshi','open'].forEach(t => {
        document.getElementById('infoTab' + t.charAt(0).toUpperCase() + t.slice(1))
          ?.classList.toggle('hidden', t !== tab);
      });
    });
  });

  // Refresh button
  document.getElementById('infoHubRefresh')?.addEventListener('click', () => {
    refreshAllInfoTabs(true);
  });

  // Initial load
  refreshAllInfoTabs(false);

  // Auto-refresh every 30 minutes
  if (infoHubRefreshTimer) clearInterval(infoHubRefreshTimer);
  infoHubRefreshTimer = setInterval(() => refreshAllInfoTabs(false), INFO_HUB_REFRESH_INTERVAL);
}

async function refreshAllInfoTabs(showSpin) {
  const refreshBtn = document.getElementById('infoHubRefresh');
  if (showSpin && refreshBtn) refreshBtn.classList.add('spinning');

  await Promise.allSettled([
    loadExamNews(),
    loadMoshi(),
    loadOpenSchool(),
  ]);
  renderStudyResources();

  const now = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  const updEl = document.getElementById('infoHubUpdated');
  if (updEl) updEl.textContent = `最終更新 ${now}`;

  if (showSpin && refreshBtn) {
    setTimeout(() => refreshBtn.classList.remove('spinning'), 600);
  }
}

// ── Fetch RSS and render to a list element ──
async function fetchRSSItems(feedConfigs, limit = 8) {
  let items = [];
  for (const feed of feedConfigs) {
    if (items.length >= limit) break;
    try {
      const res  = await fetch(feed.url, { signal: AbortSignal.timeout(7000) });
      if (!res.ok) continue;
      const json = await res.json();
      if (!json?.contents) continue;
      const xml  = new DOMParser().parseFromString(json.contents, 'text/xml');
      if (xml.querySelector('parsererror')) continue;

      [...xml.querySelectorAll('item')].slice(0, limit).forEach(el => {
        const title = el.querySelector('title')?.textContent?.trim() || '';
        const link  = el.querySelector('link')?.textContent?.trim()  || '#';
        const pub   = el.querySelector('pubDate')?.textContent?.trim() || '';
        if (!title) return;
        // keyword filter if specified
        if (feed.keywords?.length) {
          const lower = title + ' ' + (el.querySelector('description')?.textContent || '');
          if (!feed.keywords.some(kw => lower.includes(kw))) return;
        }
        items.push({ title, link, pub, tag: feed.tag, tagClass: feed.tagClass, source: feed.source || '' });
      });
    } catch { /* timeout or parse error – try next feed */ }
  }
  return items;
}

function renderNewsList(listId, items, fallback) {
  const list = document.getElementById(listId);
  if (!list) return;
  const data = items.length ? items : fallback;
  list.innerHTML = '';
  if (!data.length) { list.innerHTML = '<div class="news-loading">情報がありません</div>'; return; }

  data.forEach(item => {
    const a = document.createElement('a');
    a.className = 'news-item';
    a.href = item.link || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.innerHTML = `
      <div class="news-dot"></div>
      <div class="news-item-content">
        <div class="news-item-title">${escHtml(item.title)}</div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:2px;flex-wrap:wrap">
          ${item.pub  ? `<span class="news-item-meta">${escHtml(fmtPubDate(item.pub))}</span>` : ''}
          ${item.source ? `<span class="news-item-source">${escHtml(item.source)}</span>` : ''}
        </div>
      </div>
      <span class="news-item-tag ${item.tagClass || 'tag-nyushi'}">${escHtml(item.tag)}</span>
    `;
    list.appendChild(a);
  });
}

async function loadExamNews() {
  const list = document.getElementById('examNewsList');
  if (!list) return;
  list.innerHTML = '<div class="news-loading">読み込み中...</div>';

  const examFeeds = NEWS_FEEDS.map(f => ({
    ...f,
    keywords: ['入試','受験','高校','大学','試験','学力','共通テスト','センター'],
  }));

  const items = await fetchRSSItems(examFeeds, 10);
  renderNewsList('examNewsList', items, FALLBACK_NEWS);
}

async function loadMoshi() {
  const list = document.getElementById('moshiList');
  if (!list) return;
  list.innerHTML = '<div class="news-loading">読み込み中...</div>';

  const moshiFeeds = NEWS_FEEDS.map(f => ({
    ...f,
    keywords: ['模試','模擬','テスト','試験','申込','受付','全統'],
  }));

  const items = await fetchRSSItems(moshiFeeds, 8);
  renderNewsList('moshiList', items, FALLBACK_MOSHI);
}

async function loadOpenSchool() {
  const list = document.getElementById('openList');
  if (!list) return;
  list.innerHTML = '<div class="news-loading">読み込み中...</div>';

  const openFeeds = NEWS_FEEDS.map(f => ({
    ...f,
    keywords: ['オープン','学校見学','説明会','文化祭','体験','見学'],
  }));

  const items = await fetchRSSItems(openFeeds, 8);
  renderNewsList('openList', items, FALLBACK_OPEN);
}

function renderStudyResources() {
  const wrap = document.getElementById('studySections');
  if (!wrap) return;
  wrap.innerHTML = '';

  const sections = [
    { title: '📖 無料学習サイト・アプリ', items: STUDY_RESOURCES.free },
    { title: '🏛️ 入試・受験公式情報',     items: STUDY_RESOURCES.exam },
    { title: '💡 勉強法ヒント',           items: STUDY_RESOURCES.tips },
  ];

  sections.forEach(sec => {
    const secEl = document.createElement('div');
    const titleEl = document.createElement('div');
    titleEl.className = 'study-section-title';
    titleEl.textContent = sec.title;
    secEl.appendChild(titleEl);

    sec.items.forEach(item => {
      const a = document.createElement('a');
      a.className = 'study-link-item';
      a.href = item.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.innerHTML = `
        <span class="study-link-icon">${item.icon}</span>
        <div class="study-link-info">
          <div class="study-link-name">${escHtml(item.name)}</div>
          <div class="study-link-desc">${escHtml(item.desc)}</div>
        </div>
        <span class="study-link-badge">開く →</span>
      `;
      secEl.appendChild(a);
    });
    wrap.appendChild(secEl);
  });
}

function fmtPubDate(str) {
  try {
    const d = new Date(str);
    return d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

// ============================================================
//  ANNOUNCEMENTS
// ============================================================
async function loadAnnouncements() {
  const { data, error } = await sb
    .from('announcements')
    .select('*, profiles(name, handle, color, role)')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) { showToast('お知らせ読み込み失敗'); return; }
  renderAnnFeed(data || []);
}

function renderAnnFeed(data) {
  const feed = document.getElementById('annFeed');
  if (!feed) return;

  // データが渡されなければ再取得
  if (!data) { loadAnnouncements(); return; }

  const filtered = feedFilter === 'all'      ? data
    : feedFilter === 'exam'     ? data.filter(a => a.category === 'exam')
    : feedFilter === 'test'     ? data.filter(a => a.category === 'test')
    : feedFilter === 'announce' ? data.filter(a => a.category === 'info')
    : data;

  feed.innerHTML = '';
  if (filtered.length === 0) {
    feed.innerHTML = '<p class="ann-loading">まだ投稿がありません</p>';
    return;
  }

  filtered.forEach(ann => feed.appendChild(buildAnnCard(ann)));
}

function buildAnnCard(ann) {
  const author = ann.profiles || getProfile(ann.author_id) || {};
  const card   = document.createElement('div');
  card.className = 'ann-card';

  const catLabels = { info: 'お知らせ', test: 'テスト情報', exam: '入試情報', news: 'ニュース' };
  const catLabel  = catLabels[ann.category] || ann.category;

  card.innerHTML = `
    <div class="ann-card-header">
      <div class="avatar sm" style="background:${escHtml(author.color || '#1d9bf0')}">
        ${escHtml((author.name || '?')[0].toUpperCase())}
      </div>
      <div class="ann-card-meta">
        <div class="ann-card-author">${escHtml(author.name || '先生')}</div>
        <div class="ann-card-time">${timeAgo(new Date(ann.created_at).getTime())}</div>
      </div>
      <span class="cat-tag ${ann.category}">${escHtml(catLabel)}</span>
    </div>
    ${ann.title ? `<div class="ann-card-title">${escHtml(ann.title)}</div>` : ''}
    ${ann.body  ? `<div class="ann-card-body">${escHtml(ann.body)}</div>` : ''}
  `;

  const attachments = ann.attachments || [];
  if (attachments.length > 0) {
    const wrap = document.createElement('div');
    wrap.className = 'ann-card-attachments';
    attachments.forEach(att => {
      if (att.type === 'image' || att.type === 'gif') {
        const img = document.createElement('img');
        img.className = 'ann-attach-img';
        img.src = att.url; img.alt = att.name || '画像'; img.loading = 'lazy';
        img.addEventListener('click', () => openLightbox(att.url, 'image'));
        wrap.appendChild(img);
      } else if (att.type === 'video') {
        const vid = document.createElement('video');
        vid.className = 'ann-attach-video';
        vid.src = att.url; vid.controls = true; vid.preload = 'metadata';
        wrap.appendChild(vid);
      } else if (att.type === 'pdf') {
        const a = document.createElement('a');
        a.className = 'ann-attach-pdf';
        a.href = att.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.innerHTML = `<span>📄</span><span>${escHtml(att.name || 'PDF')}</span>`;
        wrap.appendChild(a);
      }
    });
    card.appendChild(wrap);
  }

  return card;
}

// ============================================================
//  先生: お知らせ投稿モーダル
// ============================================================
function setupAnnModal() {
  if (currentProfile.role !== 'sensei') return;

  document.getElementById('openAnnModal')?.addEventListener('click', () => {
    document.getElementById('annModal').classList.remove('hidden');
  });
  document.getElementById('closeAnnModal')?.addEventListener('click', closeAnnModal);
  document.getElementById('annModal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeAnnModal();
  });

  // カテゴリ選択
  document.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // 添付ファイル
  document.getElementById('annFileInput')?.addEventListener('change', e => {
    Array.from(e.target.files).forEach(f => annFiles.push(f));
    e.target.value = '';
    renderAnnPreview();
  });

  // 投稿
  document.getElementById('annSubmitBtn')?.addEventListener('click', submitAnnouncement);
}

function closeAnnModal() {
  document.getElementById('annModal').classList.add('hidden');
  document.getElementById('annTitle').value = '';
  document.getElementById('annBody').value  = '';
  document.getElementById('annError').textContent = '';
  annFiles = [];
  renderAnnPreview();
}

function renderAnnPreview() {
  const preview = document.getElementById('annPreview');
  if (!preview) return;
  preview.innerHTML = '';
  annFiles.forEach((file, idx) => {
    const chip = buildPreviewChip(file, idx, annFiles, renderAnnPreview);
    preview.appendChild(chip);
  });
}

async function submitAnnouncement() {
  const title = document.getElementById('annTitle').value.trim();
  const body  = document.getElementById('annBody').value.trim();
  const cat   = document.querySelector('.cat-btn.active')?.dataset.cat || 'info';
  const err   = document.getElementById('annError');
  err.textContent = '';

  if (!title && !body && annFiles.length === 0) {
    err.textContent = 'タイトルか本文を入力してください'; return;
  }

  const btn = document.getElementById('annSubmitBtn');
  btn.disabled = true; btn.textContent = '投稿中...';

  const attachments = (await Promise.all(annFiles.map(uploadChatFile))).filter(Boolean);

  const { error } = await sb.from('announcements').insert({
    author_id:   currentProfile.id,
    title, body,
    category:    cat,
    attachments,
  });

  btn.disabled = false; btn.textContent = '投稿する';

  if (error) { err.textContent = '投稿失敗: ' + error.message; return; }

  showToast('投稿しました ✅');
  closeAnnModal();
  await loadAnnouncements();
}

// ============================================================
//  生徒: リクエストモーダル
// ============================================================
function setupRequestModal() {
  if (currentProfile.role !== 'seito') return;

  document.getElementById('openRequestModal')?.addEventListener('click', openRequestModal);
  document.getElementById('closeRequestModal')?.addEventListener('click', closeRequestModal);
  document.getElementById('requestModal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeRequestModal();
  });
  document.getElementById('reqSubmitBtn')?.addEventListener('click', submitRequest);
}

function openRequestModal() {
  const sel = document.getElementById('reqTeacherSel');
  if (!sel) return;
  sel.innerHTML = '';
  const sensei = allProfiles.filter(p => p.role === 'sensei');
  if (sensei.length === 0) {
    sel.innerHTML = '<option disabled>先生がいません</option>';
  } else {
    sensei.forEach(s => sel.appendChild(new Option(`${s.name} (@${s.handle})`, s.id)));
  }
  document.getElementById('reqBody').value = '';
  document.getElementById('reqError').textContent = '';
  document.getElementById('requestModal').classList.remove('hidden');
  document.getElementById('reqBody').focus();
}

function closeRequestModal() {
  document.getElementById('requestModal').classList.add('hidden');
}

async function submitRequest() {
  const senseiId = document.getElementById('reqTeacherSel').value;
  const body     = document.getElementById('reqBody').value.trim();
  const err      = document.getElementById('reqError');
  err.textContent = '';

  if (!body) { err.textContent = 'リクエスト内容を入力してください'; return; }
  if (!senseiId) { err.textContent = '先生を選択してください'; return; }

  const btn = document.getElementById('reqSubmitBtn');
  btn.disabled = true; btn.textContent = '送信中...';

  const { error } = await sb.from('requests').insert({
    seito_id:  currentProfile.id,
    sensei_id: senseiId,
    body,
  });

  btn.disabled = false; btn.textContent = '送る';

  if (error) { err.textContent = '送信失敗: ' + error.message; return; }
  showToast('リクエストを送りました ✉️');
  closeRequestModal();
}

// ============================================================
//  先生: リクエスト受信ポップアップ
// ============================================================
function setupReqPopup() {
  document.getElementById('reqPopupClose')?.addEventListener('click', dismissReqPopup);
  document.getElementById('reqPopupAccept')?.addEventListener('click', () => respondRequest('accepted'));
  document.getElementById('reqPopupDecline')?.addEventListener('click', () => respondRequest('declined'));
}

function showReqPopup(req) {
  pendingReqId = req.id;
  const seito = getProfile(req.seito_id);
  setText('reqPopupFrom', `${seito ? seito.name + ' (@' + seito.handle + ')' : '生徒'} からのリクエスト`);
  setText('reqPopupBody', req.body);
  document.getElementById('reqPopup').classList.remove('hidden');
}

function dismissReqPopup() {
  document.getElementById('reqPopup').classList.add('hidden');
  pendingReqId = null;
}

async function respondRequest(status) {
  if (!pendingReqId) return;
  await sb.from('requests').update({ status }).eq('id', pendingReqId);
  dismissReqPopup();
  showToast(status === 'accepted' ? 'リクエストを承認しました ✅' : 'リクエストを断りました');
}

// ============================================================
//  CHAT
// ============================================================
async function loadConversations() {
  const uid = currentProfile.id;
  const { data } = await sb
    .from('conversations')
    .select('*')
    .or(`participant_a_id.eq.${uid},participant_b_id.eq.${uid}`)
    .order('last_message_at', { ascending: false });
  if (data) conversations = data;
}

function renderConvList() {
  const list = document.getElementById('convList');
  if (!list) return;
  list.innerHTML = '';
  if (conversations.length === 0) {
    list.innerHTML = '<p class="empty-hint">チャットがありません<br>「＋」から始めましょう</p>';
    return;
  }
  conversations.forEach(conv => {
    const pid     = conv.participant_a_id === currentProfile.id ? conv.participant_b_id : conv.participant_a_id;
    const partner = getProfile(pid);
    if (!partner) return;
    const item = document.createElement('div');
    item.className = 'conv-item' + (conv.id === activeConvId ? ' active' : '');
    item.dataset.convId = conv.id;
    const av = makeAvatarEl(partner, 'sm');
    const info = document.createElement('div');
    info.className = 'conv-item-info';
    info.innerHTML = `
      <div class="conv-item-name">${escHtml(partner.name)}
        <span class="role-badge ${partner.role}" style="margin-left:4px">${partner.role === 'sensei' ? '先生' : '生徒'}</span>
      </div>
      <div class="conv-item-preview">@${escHtml(partner.handle)}</div>`;
    const time = document.createElement('span');
    time.className = 'conv-item-time';
    time.textContent = timeAgo(new Date(conv.last_message_at).getTime());
    item.append(av, info, time);
    item.addEventListener('click', () => {
      // チャットタブへ自動切り替え
      document.querySelector('[data-view="chat"]')?.click();
      openConversation(conv.id, partner);
    });
    list.appendChild(item);
  });
}

function renderUsersList() {
  const list = document.getElementById('usersList');
  if (!list) return;
  list.innerHTML = '';
  allProfiles.forEach(u => {
    const item = document.createElement('div');
    item.className = 'user-list-item';
    const av = makeAvatarEl(u, 'sm');
    const info = document.createElement('div');
    info.className = 'user-list-item-info';
    info.innerHTML = `
      <div class="user-list-item-name">${escHtml(u.name)}${u.id === currentProfile.id ? ' <span style="color:var(--text3);font-weight:400">(あなた)</span>' : ''}</div>
      <div class="user-list-item-handle">@${escHtml(u.handle)}</div>`;
    const badge = document.createElement('span');
    badge.className = 'role-badge ' + u.role;
    badge.textContent = u.role === 'sensei' ? '先生' : '生徒';
    item.append(av, info, badge);
    list.appendChild(item);
  });
}

// ==================== 許可管理パネル ====================
async function renderPermissionsPanel() {
  const panel = document.getElementById('permissionsPanel');
  if (!panel) return;
  panel.innerHTML = '<p class="empty-hint">読み込み中...</p>';
  const { data: perms } = await sb.from('chat_permissions').select('*').eq('sensei_id', currentProfile.id);
  const seitoList = allProfiles.filter(p => p.role === 'seito');
  panel.innerHTML = '';

  const sec = document.createElement('div');
  sec.className = 'perm-section';
  sec.innerHTML = `<h4>🔓 生徒同士のチャットを許可</h4>`;

  if (seitoList.length < 2) {
    sec.innerHTML += '<p style="font-size:.78rem;color:var(--text2)">生徒が2人以上いると許可できます</p>';
  } else {
    const form = document.createElement('div');
    form.className = 'perm-grant-form';
    const selA = document.createElement('select'); selA.className = 'perm-select';
    const selB = document.createElement('select'); selB.className = 'perm-select';
    seitoList.forEach(s => {
      selA.appendChild(new Option(`${s.name} (@${s.handle})`, s.id));
      selB.appendChild(new Option(`${s.name} (@${s.handle})`, s.id));
    });
    const gBtn = document.createElement('button');
    gBtn.className = 'perm-grant-btn'; gBtn.textContent = '許可する';
    gBtn.addEventListener('click', async () => {
      const a = selA.value, b = selB.value;
      if (a === b) { showToast('異なる生徒を選んでください'); return; }
      const [pA, pB] = a < b ? [a, b] : [b, a];
      const { error } = await sb.from('chat_permissions').insert({ sensei_id: currentProfile.id, seito_a_id: pA, seito_b_id: pB });
      if (error) { showToast(error.code === '23505' ? '既に許可済みです' : error.message); return; }
      showToast('チャットを許可しました ✅');
      await renderPermissionsPanel();
    });
    form.append(selA, selB, gBtn);
    sec.appendChild(form);

    const pairPerms = (perms || []).filter(p => p.seito_b_id);
    if (pairPerms.length > 0) {
      const listEl = document.createElement('div'); listEl.className = 'perm-list';
      pairPerms.forEach(p => {
        const pA = getProfile(p.seito_a_id), pB = getProfile(p.seito_b_id);
        const item = document.createElement('div'); item.className = 'perm-item';
        item.innerHTML = `<div class="perm-item-info">${escHtml(pA?.name||'?')} ↔ ${escHtml(pB?.name||'?')}</div>`;
        const rBtn = document.createElement('button'); rBtn.className = 'perm-revoke-btn'; rBtn.textContent = '取り消す';
        rBtn.addEventListener('click', async () => {
          await sb.from('chat_permissions').delete().eq('id', p.id);
          showToast('許可を取り消しました');
          await renderPermissionsPanel();
        });
        item.appendChild(rBtn);
        listEl.appendChild(item);
      });
      sec.appendChild(listEl);
    }
  }
  panel.appendChild(sec);
}

// ==================== チャット権限チェック ====================
async function canChat(withUserId) {
  const me = currentProfile, other = getProfile(withUserId);
  if (!other || me.id === withUserId) return false;
  if (me.role === 'sensei' || other.role === 'sensei') return true;
  const [pA, pB] = me.id < withUserId ? [me.id, withUserId] : [withUserId, me.id];
  const { data } = await sb.from('chat_permissions').select('id').eq('seito_a_id', pA).eq('seito_b_id', pB).maybeSingle();
  return !!data;
}

// ==================== 新規チャットモーダル ====================
function setupNewChatModal() {
  document.getElementById('newChatBtn')?.addEventListener('click', openNewChatModal);
  document.getElementById('closeNewChatModal')?.addEventListener('click', closeNewChatModal);
  document.getElementById('newChatModal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeNewChatModal();
  });
}

async function openNewChatModal() {
  const modal = document.getElementById('newChatModal');
  const list  = document.getElementById('userPickList');
  const hint  = document.getElementById('newChatHint');
  list.innerHTML = '<p class="empty-hint">読み込み中...</p>';
  hint.textContent = currentProfile.role === 'sensei' ? '全ユーザーとチャットできます' : '先生または許可された生徒を選んでください';
  modal.classList.remove('hidden');

  const allowed = [];
  for (const p of allProfiles.filter(p => p.id !== currentProfile.id)) {
    if (await canChat(p.id)) allowed.push(p);
  }
  list.innerHTML = '';
  if (!allowed.length) { list.innerHTML = '<p class="empty-hint">チャットできる相手がいません</p>'; return; }
  allowed.forEach(u => {
    const item = document.createElement('div');
    item.className = 'user-list-item';
    const av = makeAvatarEl(u, 'sm');
    const info = document.createElement('div');
    info.className = 'user-list-item-info';
    info.innerHTML = `<div class="user-list-item-name">${escHtml(u.name)}</div><div class="user-list-item-handle">@${escHtml(u.handle)}</div>`;
    const badge = document.createElement('span');
    badge.className = 'role-badge ' + u.role;
    badge.textContent = u.role === 'sensei' ? '先生' : '生徒';
    item.append(av, info, badge);
    item.addEventListener('click', async () => { closeNewChatModal(); await startOrOpenConversation(u); });
    list.appendChild(item);
  });
}
function closeNewChatModal() { document.getElementById('newChatModal').classList.add('hidden'); }

async function startOrOpenConversation(partner) {
  const existing = conversations.find(c =>
    (c.participant_a_id === currentProfile.id && c.participant_b_id === partner.id) ||
    (c.participant_b_id === currentProfile.id && c.participant_a_id === partner.id));
  if (existing) { openConversation(existing.id, partner); return; }

  const [pA, pB] = currentProfile.id < partner.id ? [currentProfile.id, partner.id] : [partner.id, currentProfile.id];
  const { data, error } = await sb.from('conversations').insert({ participant_a_id: pA, participant_b_id: pB }).select().single();
  if (error) {
    const { data: ex } = await sb.from('conversations').select('*').eq('participant_a_id', pA).eq('participant_b_id', pB).single();
    if (ex) { if (!conversations.find(c => c.id === ex.id)) conversations.unshift(ex); openConversation(ex.id, partner); }
    else showToast('会話の作成に失敗しました');
    return;
  }
  conversations.unshift(data);
  renderConvList();
  openConversation(data.id, partner);
}

async function openConversation(convId, partner) {
  activeConvId = convId; activePartner = partner;
  renderConvList();
  document.getElementById('noChatSelected').classList.add('hidden');
  document.getElementById('chatPanel').classList.remove('hidden');
  const av = document.getElementById('chatPartnerAvatar');
  av.style.background = partner.color; av.textContent = partner.name[0].toUpperCase();
  setText('chatPartnerName',   partner.name);
  setText('chatPartnerHandle', '@' + partner.handle);
  await loadMessages(convId);
  subscribeToMessages(convId);
}

async function loadMessages(convId) {
  const area = document.getElementById('messagesArea');
  area.innerHTML = '<div class="messages-loading">読み込み中...</div>';
  const { data, error } = await sb.from('messages').select('*').eq('conversation_id', convId).order('created_at', { ascending: true });
  area.innerHTML = '';
  if (error) { area.innerHTML = '<p class="empty-hint" style="color:var(--danger)">読み込み失敗</p>'; return; }
  if (!data?.length) { area.innerHTML = '<p class="empty-hint">まだメッセージがありません</p>'; return; }
  let lastDate = '';
  data.forEach(msg => {
    const d = new Date(msg.created_at).toLocaleDateString('ja-JP');
    if (d !== lastDate) { lastDate = d; area.appendChild(dateDivider(d)); }
    area.appendChild(buildMsgRow(msg));
  });
  scrollToBottom();
}

function buildMsgRow(msg) {
  const isMine = msg.sender_id === currentProfile.id;
  const sender = getProfile(msg.sender_id);
  const row = document.createElement('div');
  row.className = 'msg-row ' + (isMine ? 'mine' : 'theirs');
  if (!isMine && sender) row.appendChild(makeAvatarEl(sender, 'xs'));
  const inner  = document.createElement('div');
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  if (msg.body?.trim()) {
    const p = document.createElement('p');
    p.innerHTML = escHtml(msg.body).replace(/\n/g,'<br>');
    bubble.appendChild(p);
  }
  const atts = msg.attachments || [];
  if (atts.length) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-attachments';
    atts.forEach(att => wrap.appendChild(buildAttachEl(att)));
    bubble.appendChild(wrap);
  }
  inner.appendChild(bubble);
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = new Date(msg.created_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  inner.appendChild(meta);
  row.appendChild(inner);
  return row;
}

function buildAttachEl(att) {
  if (att.type === 'image' || att.type === 'gif') {
    const img = document.createElement('img');
    img.className = 'attach-img'; img.src = att.url; img.alt = att.name || '画像'; img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(att.url, 'image'));
    return img;
  }
  if (att.type === 'video') {
    const v = document.createElement('video');
    v.className = 'attach-video'; v.src = att.url; v.controls = true; v.preload = 'metadata';
    return v;
  }
  if (att.type === 'pdf') {
    const a = document.createElement('a');
    a.className = 'attach-pdf'; a.href = att.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.innerHTML = `<span class="attach-pdf-icon">📄</span><span>${escHtml(att.name||'PDF')}</span>`;
    return a;
  }
  const a = document.createElement('a');
  a.href = att.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.textContent = att.name || 'ファイル';
  return a;
}

function dateDivider(text) {
  const d = document.createElement('div');
  d.className = 'date-divider'; d.textContent = text;
  return d;
}

function setupChatInput() {
  const fi  = document.getElementById('chatFileInput');
  const ta  = document.getElementById('chatInput');
  const btn = document.getElementById('sendBtn');
  fi?.addEventListener('change', () => {
    Array.from(fi.files).forEach(f => pendingFiles.push(f));
    fi.value = '';
    renderChatPreview();
    updateSendBtn();
  });
  ta?.addEventListener('input', () => { autoResize(ta); updateSendBtn(); });
  ta?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!btn.disabled) sendMessage(); } });
  btn?.addEventListener('click', () => { if (!btn.disabled) sendMessage(); });
}

function updateSendBtn() {
  const ta  = document.getElementById('chatInput');
  const btn = document.getElementById('sendBtn');
  if (!btn) return;
  btn.disabled = !activeConvId || (!ta?.value.trim() && !pendingFiles.length);
}

function renderChatPreview() {
  const p = document.getElementById('attachPreview');
  if (!p) return;
  p.innerHTML = '';
  pendingFiles.forEach((f, i) => p.appendChild(buildPreviewChip(f, i, pendingFiles, renderChatPreview)));
}

function buildPreviewChip(file, idx, arr, rerender) {
  const chip = document.createElement('div');
  chip.className = 'preview-chip';
  const ext = file.name.split('.').pop().toLowerCase();
  const isImg = file.type.startsWith('image/');
  const isVid = file.type.startsWith('video/');
  const isPdf = file.type === 'application/pdf' || ext === 'pdf';
  if (isImg) {
    const img = document.createElement('img');
    img.className = 'preview-chip-img';
    const reader = new FileReader();
    reader.onload = e => { img.src = e.target.result; };
    reader.readAsDataURL(file);
    chip.appendChild(img);
  } else {
    const ic = document.createElement('span');
    ic.className = 'preview-chip-icon';
    ic.textContent = isPdf ? '📄' : isVid ? '🎬' : '📎';
    chip.appendChild(ic);
  }
  const nm = document.createElement('span');
  nm.className = 'preview-chip-name'; nm.textContent = file.name;
  chip.appendChild(nm);
  const rm = document.createElement('button');
  rm.className = 'preview-chip-remove'; rm.textContent = '✕';
  rm.setAttribute('aria-label', '削除');
  rm.addEventListener('click', () => { arr.splice(idx, 1); rerender(); updateSendBtn(); });
  chip.appendChild(rm);
  return chip;
}

async function sendMessage() {
  if (!activeConvId) return;
  const ta  = document.getElementById('chatInput');
  const btn = document.getElementById('sendBtn');
  const body = ta.value.trim();
  const files = [...pendingFiles];
  if (!body && !files.length) return;
  btn.disabled = true;
  const attachments = (await Promise.all(files.map(uploadChatFile))).filter(Boolean);
  const { data, error } = await sb.from('messages').insert({
    conversation_id: activeConvId, sender_id: currentProfile.id, body, attachments,
  }).select().single();
  if (error) { showToast('送信失敗: ' + error.message); btn.disabled = false; return; }
  await sb.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', activeConvId);
  ta.value = ''; ta.style.height = 'auto';
  pendingFiles = []; renderChatPreview(); updateSendBtn();
  appendMessage(data);
}

async function uploadChatFile(file) {
  const ext  = file.name.split('.').pop().toLowerCase();
  const path = `${currentUser.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const { error } = await sb.storage.from('chat-files').upload(path, file, { upsert: false });
  if (error) { showToast('アップロード失敗: ' + file.name); return null; }
  const { data } = sb.storage.from('chat-files').getPublicUrl(path);
  let type = 'file';
  if (file.type.startsWith('image/')) type = file.name.toLowerCase().endsWith('.gif') ? 'gif' : 'image';
  else if (file.type.startsWith('video/')) type = 'video';
  else if (file.type === 'application/pdf' || ext === 'pdf') type = 'pdf';
  return { type, url: data.publicUrl, name: file.name };
}

function appendMessage(msg) {
  const area = document.getElementById('messagesArea');
  area.querySelector('.empty-hint')?.remove();
  const d = new Date(msg.created_at).toLocaleDateString('ja-JP');
  const last = area.querySelector('.date-divider:last-of-type');
  if (!last || last.textContent !== d) area.appendChild(dateDivider(d));
  area.appendChild(buildMsgRow(msg));
  scrollToBottom();
}

// ============================================================
//  NOTICE BOARD
// ============================================================
let nbPosts   = [];
let nbFilter  = 'all';
let nbEditId  = null;
let nbFiles   = [];
let nbChannel = null;

async function initNoticeBoard() {
  await loadNBPosts();
  renderNBIndex();
  renderNBCards();
  setupNBModal();
  setupNBFilters();
  if (nbChannel) sb.removeChannel(nbChannel);
  nbChannel = sb.channel('nb-rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notice_board' }, async () => {
      await loadNBPosts();
      renderNBIndex();
      renderNBCards();
    })
    .subscribe();
}

async function loadNBPosts() {
  const { data } = await sb
    .from('notice_board')
    .select('*, profiles(name, handle, color)')
    .order('pinned', { ascending: false })
    .order('updated_at', { ascending: false });
  if (data) nbPosts = data;
}

function renderNBIndex() {
  const list = document.getElementById('nbIndexList');
  if (!list) return;
  list.innerHTML = '';
  const posts = nbFilter === 'mine' ? nbPosts.filter(p => p.author_id === currentProfile.id) : nbPosts;
  if (!posts.length) { list.innerHTML = '<p class="empty-hint">まだ投稿がありません</p>'; return; }
  posts.forEach(p => {
    const item = document.createElement('div');
    item.className = 'nb-index-item';
    item.dataset.nbId = p.id;
    item.innerHTML = `
      <div class="nb-index-dot" style="background:${escHtml(p.color)}"></div>
      <div class="nb-index-info">
        <div class="nb-index-title">${escHtml(p.title)}</div>
        <div class="nb-index-meta">${timeAgo(new Date(p.updated_at).getTime())}</div>
      </div>
      ${p.pinned ? '<span class="nb-pin-icon">📌</span>' : ''}
    `;
    item.addEventListener('click', () => scrollToNBCard(p.id));
    list.appendChild(item);
  });
}

function renderNBCards() {
  const wrap = document.getElementById('nbCardsWrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!nbPosts.length) { wrap.innerHTML = '<p class="ann-loading">まだ掲示板の投稿がありません</p>'; return; }
  nbPosts.forEach(p => wrap.appendChild(buildNBCard(p)));
}

function buildNBCard(p) {
  const author = p.profiles || getProfile(p.author_id) || {};
  const card   = document.createElement('div');
  card.className = 'nb-card'; card.dataset.nbId = p.id;

  const stripe = document.createElement('div');
  stripe.className = 'nb-card-stripe'; stripe.style.background = p.color;
  card.appendChild(stripe);

  const body = document.createElement('div');
  body.className = 'nb-card-body';

  const top = document.createElement('div');
  top.className = 'nb-card-top';
  top.innerHTML = `
    <div class="nb-card-title">${escHtml(p.title)}</div>
    ${p.pinned ? '<span class="nb-pin-badge">📌 固定</span>' : ''}
  `;
  body.appendChild(top);

  if (p.body?.trim()) {
    const txt = document.createElement('div');
    txt.className = 'nb-card-text';
    txt.textContent = p.body;
    body.appendChild(txt);
    if (p.body.length > 200) {
      const rm = document.createElement('button');
      rm.className = 'nb-read-more'; rm.textContent = 'もっと見る';
      rm.addEventListener('click', () => {
        txt.classList.toggle('expanded');
        rm.textContent = txt.classList.contains('expanded') ? '閉じる' : 'もっと見る';
      });
      body.appendChild(rm);
    }
  }

  const atts = p.attachments || [];
  if (atts.length) {
    const aw = document.createElement('div'); aw.className = 'nb-card-attachments';
    atts.forEach(att => {
      if (att.type === 'image' || att.type === 'gif') {
        const img = document.createElement('img'); img.className = 'nb-attach-img';
        img.src = att.url; img.alt = att.name || '画像'; img.loading = 'lazy';
        img.addEventListener('click', () => openLightbox(att.url, 'image'));
        aw.appendChild(img);
      } else if (att.type === 'video') {
        const v = document.createElement('video'); v.className = 'nb-attach-video';
        v.src = att.url; v.controls = true; v.preload = 'metadata'; aw.appendChild(v);
      } else if (att.type === 'pdf') {
        const a = document.createElement('a'); a.className = 'nb-attach-pdf';
        a.href = att.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.innerHTML = `<span>📄</span><span>${escHtml(att.name || 'PDF')}</span>`; aw.appendChild(a);
      }
    });
    body.appendChild(aw);
  }
  card.appendChild(body);

  const footer = document.createElement('div'); footer.className = 'nb-card-footer';
  footer.innerHTML = `
    <span class="nb-card-author">👨‍🏫 ${escHtml(author.name || '先生')}</span>
    <span class="nb-card-time">${timeAgo(new Date(p.updated_at).getTime())}</span>
  `;
  if (currentProfile.role === 'sensei' && p.author_id === currentProfile.id) {
    const acts = document.createElement('div'); acts.className = 'nb-card-actions';
    const eBtn = document.createElement('button'); eBtn.className = 'nb-edit-btn'; eBtn.textContent = '編集';
    eBtn.addEventListener('click', () => openNBModalEdit(p));
    const dBtn = document.createElement('button'); dBtn.className = 'nb-delete-btn'; dBtn.textContent = '削除';
    dBtn.addEventListener('click', async () => {
      if (!confirm(`「${p.title}」を削除しますか？`)) return;
      await sb.from('notice_board').delete().eq('id', p.id);
      showToast('削除しました');
    });
    acts.append(eBtn, dBtn); footer.appendChild(acts);
  }
  card.appendChild(footer);
  return card;
}

function scrollToNBCard(id) {
  const card = document.querySelector(`.nb-card[data-nb-id="${id}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.style.outline = '2px solid var(--accent)';
  setTimeout(() => { card.style.outline = ''; }, 1400);
}

function setupNBFilters() {
  document.querySelectorAll('.nb-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nb-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active'); nbFilter = btn.dataset.author; renderNBIndex();
    });
  });
}

function setupNBModal() {
  document.getElementById('openNBModal')?.addEventListener('click', openNBModalNew);
  document.getElementById('closeNBModal')?.addEventListener('click', closeNBModal);
  document.getElementById('nbModal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeNBModal(); });
  document.querySelectorAll('.nb-color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nb-color-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  document.getElementById('nbFileInput')?.addEventListener('change', e => {
    Array.from(e.target.files).forEach(f => nbFiles.push(f)); e.target.value = ''; renderNBPreview();
  });
  document.getElementById('nbSubmitBtn')?.addEventListener('click', submitNBPost);
}

function openNBModalNew() {
  nbEditId = null; nbFiles = [];
  setText('nbModalTitle', '掲示板に投稿');
  document.getElementById('nbTitle').value = '';
  document.getElementById('nbBody').value  = '';
  document.getElementById('nbPinned').checked = false;
  document.getElementById('nbError').textContent = '';
  document.querySelectorAll('.nb-color-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.nb-color-btn[data-color="#1d9bf0"]')?.classList.add('active');
  document.getElementById('nbSubmitBtn').textContent = '投稿する';
  renderNBPreview();
  document.getElementById('nbModal').classList.remove('hidden');
  document.getElementById('nbTitle').focus();
}

function openNBModalEdit(p) {
  nbEditId = p.id; nbFiles = [];
  setText('nbModalTitle', '投稿を編集');
  document.getElementById('nbTitle').value    = p.title;
  document.getElementById('nbBody').value     = p.body || '';
  document.getElementById('nbPinned').checked = p.pinned;
  document.getElementById('nbError').textContent = '';
  document.querySelectorAll('.nb-color-btn').forEach(b => b.classList.toggle('active', b.dataset.color === p.color));
  document.getElementById('nbSubmitBtn').textContent = '保存';
  renderNBPreview();
  document.getElementById('nbModal').classList.remove('hidden');
  document.getElementById('nbTitle').focus();
}

function closeNBModal() {
  document.getElementById('nbModal').classList.add('hidden');
  nbEditId = null; nbFiles = [];
}

function renderNBPreview() {
  const p = document.getElementById('nbPreview');
  if (!p) return; p.innerHTML = '';
  nbFiles.forEach((f, i) => p.appendChild(buildPreviewChip(f, i, nbFiles, renderNBPreview)));
}

async function submitNBPost() {
  const title  = document.getElementById('nbTitle').value.trim();
  const body   = document.getElementById('nbBody').value.trim();
  const pinned = document.getElementById('nbPinned').checked;
  const color  = document.querySelector('.nb-color-btn.active')?.dataset.color || '#1d9bf0';
  const err    = document.getElementById('nbError');
  err.textContent = '';
  if (!title) { err.textContent = 'タイトルを入力してください'; return; }

  const btn = document.getElementById('nbSubmitBtn');
  btn.disabled = true; btn.textContent = '保存中...';
  const newAtts = (await Promise.all(nbFiles.map(uploadChatFile))).filter(Boolean);

  if (nbEditId) {
    const existing = nbPosts.find(p => p.id === nbEditId);
    const keepAtts = existing?.attachments || [];
    const { error } = await sb.from('notice_board').update({
      title, body, pinned, color,
      attachments: [...keepAtts, ...newAtts],
      updated_at: new Date().toISOString(),
    }).eq('id', nbEditId);
    btn.disabled = false; btn.textContent = '保存';
    if (error) { err.textContent = '更新失敗: ' + error.message; return; }
    showToast('更新しました ✅');
  } else {
    const { error } = await sb.from('notice_board').insert({
      author_id: currentProfile.id, title, body, pinned, color, attachments: newAtts,
    });
    btn.disabled = false; btn.textContent = '投稿する';
    if (error) { err.textContent = '投稿失敗: ' + error.message; return; }
    showToast('掲示板に投稿しました ✅');
  }
  closeNBModal();
}

// ============================================================
//  GOALS + COUNTDOWN
// ============================================================
let myGoal       = null;    // current user's goal row
let goalsChannel = null;
let cdInterval   = null;

// ── Exam dates (updated every year; 2026/2027 schedule) ──
const EXAM_DATES = {
  highschool: {
    name: '公立高校入試（首都圏）',
    date: new Date('2027-02-24T09:00:00+09:00'),
  },
  university: {
    name: '大学入学共通テスト',
    date: new Date('2027-01-16T09:30:00+09:00'),
  },
};

async function initGoals() {
  // load my goal row
  const { data } = await sb.from('goals').select('*').eq('user_id', currentProfile.id).maybeSingle();
  myGoal = data || null;

  renderMyGoalUI();
  setupGoalActions();
  setupGoalsTabBar();
  startCountdown();

  // sidebar summary
  updateGoalsSidebarSummary();

  // realtime: refresh shared goals if someone updates theirs
  if (goalsChannel) sb.removeChannel(goalsChannel);
  goalsChannel = sb.channel('goals-rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'goals' }, async () => {
      const tab = document.querySelector('.goals-tab.active');
      if (tab?.dataset.gtab === 'shared') await loadSharedGoals();
      updateGoalsSidebarSummary();
    })
    .subscribe();
}

// ── Countdown ──
function startCountdown() {
  if (cdInterval) clearInterval(cdInterval);
  renderCountdown();
  cdInterval = setInterval(renderCountdown, 30000); // update every 30s
}

function renderCountdown() {
  renderCDCard('hs', EXAM_DATES.highschool);
  renderCDCard('uni', EXAM_DATES.university);
}

function renderCDCard(type, exam) {
  const prefix = type === 'hs' ? 'cdHS' : 'cdUni';
  const nameEl  = document.getElementById(prefix + 'Name');
  const daysEl  = document.getElementById(prefix + 'Days');
  const hoursEl = document.getElementById(prefix + 'Hours');
  const minsEl  = document.getElementById(prefix + 'Mins');
  const dateEl  = document.getElementById(prefix + 'Date');
  if (!daysEl) return;

  if (nameEl) nameEl.textContent = exam.name;

  const now  = Date.now();
  const diff = exam.date.getTime() - now;

  if (diff <= 0) {
    daysEl.textContent = hoursEl.textContent = minsEl.textContent = '0';
    if (dateEl) dateEl.textContent = '試験日は過ぎました';
    return;
  }

  const totalMins  = Math.floor(diff / 60000);
  const days       = Math.floor(totalMins / 1440);
  const hours      = Math.floor((totalMins % 1440) / 60);
  const mins       = totalMins % 60;

  daysEl.textContent  = String(days);
  hoursEl.textContent = String(hours).padStart(2, '0');
  minsEl.textContent  = String(mins).padStart(2, '0');
  if (dateEl) {
    dateEl.textContent = exam.date.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  }
}

// ── My goal UI ──
function renderMyGoalUI() {
  const ta        = document.getElementById('myGoalText');
  const pubCheck  = document.getElementById('myGoalPublic');
  const checkBtn  = document.getElementById('goalCheckBtn');
  const streakEl  = document.getElementById('myGoalStreak');
  if (!ta) return;

  if (myGoal) {
    ta.value = myGoal.goal_text || '';
    if (pubCheck) pubCheck.checked = myGoal.is_public;

    // check if already checked today
    const todayStr = new Date().toISOString().slice(0, 10);
    const alreadyChecked = myGoal.checked_at === todayStr;
    if (checkBtn) {
      checkBtn.classList.toggle('checked', alreadyChecked);
      checkBtn.innerHTML = alreadyChecked
        ? `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><polyline points="20 6 9 17 4 12" stroke="white" stroke-width="3" fill="none"/></svg> 達成済み ✓`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="16" height="16"><polyline points="20 6 9 17 4 12"/></svg> 今日達成！`;
    }
    if (streakEl) {
      streakEl.textContent = `🔥 ${myGoal.streak || 0}日連続`;
    }
  }
  updateGoalsSidebarSummary();
}

function setupGoalActions() {
  const saveBtn  = document.getElementById('goalSaveBtn');
  const checkBtn = document.getElementById('goalCheckBtn');
  if (!saveBtn || !checkBtn) return;

  saveBtn.addEventListener('click', async () => {
    const text     = document.getElementById('myGoalText').value.trim();
    const isPublic = document.getElementById('myGoalPublic').checked;
    if (!text) { showToast('目標を入力してください'); return; }

    saveBtn.disabled = true; saveBtn.textContent = '保存中...';

    if (myGoal) {
      const { data, error } = await sb.from('goals').update({
        goal_text: text, is_public: isPublic, updated_at: new Date().toISOString(),
      }).eq('user_id', currentProfile.id).select().single();
      if (!error && data) myGoal = data;
    } else {
      const { data, error } = await sb.from('goals').insert({
        user_id: currentProfile.id, goal_text: text, is_public: isPublic,
      }).select().single();
      if (!error && data) myGoal = data;
    }

    saveBtn.disabled = false; saveBtn.textContent = '保存';
    showToast('目標を保存しました ✅');
    renderMyGoalUI();
  });

  checkBtn.addEventListener('click', async () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    if (myGoal?.checked_at === todayStr) { showToast('今日はすでに達成済みです！'); return; }

    const text     = document.getElementById('myGoalText').value.trim();
    const isPublic = document.getElementById('myGoalPublic').checked;
    if (!text) { showToast('先に目標を入力・保存してください'); return; }

    // Calculate streak
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().slice(0, 10);
    const newStreak = (myGoal?.checked_at === yStr ? (myGoal?.streak || 0) : 0) + 1;

    const payload = {
      user_id:    currentProfile.id,
      goal_text:  text,
      is_public:  isPublic,
      checked:    true,
      checked_at: todayStr,
      streak:     newStreak,
      updated_at: new Date().toISOString(),
    };

    if (myGoal) {
      const { data } = await sb.from('goals').update(payload).eq('user_id', currentProfile.id).select().single();
      if (data) myGoal = data;
    } else {
      const { data } = await sb.from('goals').insert(payload).select().single();
      if (data) myGoal = data;
    }

    renderMyGoalUI();
    showToast(`🎉 達成！ ${newStreak}日連続達成中！`);
  });
}

function setupGoalsTabBar() {
  document.querySelectorAll('.goals-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.goals-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.gtab;
      document.getElementById('goalsMinePanel')?.classList.toggle('hidden',   tab !== 'mine');
      document.getElementById('goalsSharedPanel')?.classList.toggle('hidden', tab !== 'shared');
      if (tab === 'shared') await loadSharedGoals();
    });
  });

  // side tab mirrors
  document.querySelectorAll('.goals-side-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.goals-side-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // mirror to main tab
      const tab = btn.dataset.gtab;
      document.querySelectorAll('.goals-tab').forEach(b => b.classList.toggle('active', b.dataset.gtab === tab));
      document.getElementById('goalsMinePanel')?.classList.toggle('hidden',   tab !== 'mine');
      document.getElementById('goalsSharedPanel')?.classList.toggle('hidden', tab !== 'shared');
      if (tab === 'shared') await loadSharedGoals();
    });
  });
}

async function loadSharedGoals() {
  const list = document.getElementById('sharedGoalsList');
  if (!list) return;
  list.innerHTML = '<div class="ann-loading">読み込み中...</div>';

  const { data, error } = await sb
    .from('goals')
    .select('*, profiles(name, handle, color, role)')
    .eq('is_public', true)
    .order('streak', { ascending: false })
    .order('updated_at', { ascending: false });

  list.innerHTML = '';
  if (error || !data?.length) {
    list.innerHTML = '<p class="ann-loading">公開されている目標がありません</p>';
    return;
  }

  const todayStr = new Date().toISOString().slice(0, 10);

  data.forEach(g => {
    if (!g.goal_text?.trim()) return;
    const author = g.profiles || getProfile(g.user_id) || {};
    const isCheckedToday = g.checked_at === todayStr;

    const card = document.createElement('div');
    card.className = 'shared-goal-card';

    const av = makeAvatarEl(author, 'sm');
    const info = document.createElement('div');
    info.className = 'shared-goal-info';
    info.innerHTML = `
      <div class="shared-goal-author">${escHtml(author.name || '?')}
        <span class="role-badge ${author.role || 'seito'}" style="margin-left:5px">${author.role === 'sensei' ? '先生' : '生徒'}</span>
      </div>
      <div class="shared-goal-text">${escHtml(g.goal_text)}</div>
      <div class="shared-goal-meta">
        ${g.streak > 0 ? `<span class="shared-goal-streak">🔥 ${g.streak}日連続</span>` : ''}
        <span class="shared-goal-time">${timeAgo(new Date(g.updated_at).getTime())}</span>
      </div>
    `;

    const checkMark = document.createElement('span');
    checkMark.className = 'shared-goal-check';
    checkMark.title = isCheckedToday ? '今日達成済み' : 'まだ未達成';
    checkMark.textContent = isCheckedToday ? '✅' : '⭕';

    card.append(av, info, checkMark);
    list.appendChild(card);
  });
}

function updateGoalsSidebarSummary() {
  const streakEl  = document.getElementById('goalsStreak');
  const checkedEl = document.getElementById('goalsCheckedToday');
  if (!streakEl) return;

  const streak   = myGoal?.streak || 0;
  const todayStr = new Date().toISOString().slice(0, 10);
  const checked  = myGoal?.checked_at === todayStr;

  streakEl.textContent  = `🔥 ${streak}日連続`;
  if (checkedEl) checkedEl.textContent = checked ? '✅ 今日達成済み' : myGoal?.goal_text ? '⭕ まだ未達成' : '目標を設定しよう';
}

// ============================================================
//  SUBJECTS (教科リソース)
// ============================================================
const SUBJECTS = {
  math:     { label: '数学', icon: '📐', color: '#1d9bf0' },
  japanese: { label: '国語', icon: '📖', color: '#f97316' },
  english:  { label: '英語', icon: '🌐', color: '#10b981' },
  science:  { label: '理科', icon: '🔬', color: '#a855f7' },
  social:   { label: '社会', icon: '🗾', color: '#f59e0b' },
};

let srResources  = [];
let srSubject    = 'math';
let srLevel      = 'jhs';
let srTypeFilter = 'all';
let srEditId     = null;
let srChannel    = null;

async function initSubjects() {
  await loadSRResources();
  setupSRSidebarButtons();
  setupSRTypeButtons();
  setupSRModal();
  renderSRGrid();

  if (srChannel) sb.removeChannel(srChannel);
  srChannel = sb.channel('sr-rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'subject_resources' }, async () => {
      await loadSRResources();
      renderSRGrid();
    })
    .subscribe();
}

async function loadSRResources() {
  const { data } = await sb
    .from('subject_resources')
    .select('*, profiles(name)')
    .order('created_at', { ascending: true });
  if (data) srResources = data;
}

function setupSRSidebarButtons() {
  document.querySelectorAll('.subj-level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.subj-level-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      srLevel = btn.dataset.level;
      updateSRHeader();
      renderSRGrid();
    });
  });
  document.querySelectorAll('.subj-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.subj-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      srSubject = btn.dataset.subj;
      srTypeFilter = 'all';
      document.querySelectorAll('.subj-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'all'));
      updateSRHeader();
      renderSRGrid();
    });
  });
}

function setupSRTypeButtons() {
  document.querySelectorAll('.subj-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.subj-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      srTypeFilter = btn.dataset.type;
      renderSRGrid();
    });
  });
}

function updateSRHeader() {
  const subj = SUBJECTS[srSubject];
  const levelLabel = srLevel === 'jhs' ? '中学校' : '高校';
  const iconEl  = document.getElementById('subjCurrentIcon');
  const nameEl  = document.getElementById('subjCurrentName');
  const levelEl = document.getElementById('subjCurrentLevel');
  if (iconEl)  iconEl.textContent  = subj?.icon  || '';
  if (nameEl)  nameEl.textContent  = subj?.label || '';
  if (levelEl) levelEl.textContent = levelLabel;
}

function renderSRGrid() {
  const grid = document.getElementById('srGrid');
  if (!grid) return;
  grid.innerHTML = '';

  const filtered = srResources.filter(r => {
    const matchSubj  = r.subject === srSubject;
    const matchLevel = r.level === srLevel || r.level === 'both';
    const matchType  = srTypeFilter === 'all' || r.resource_type === srTypeFilter;
    return matchSubj && matchLevel && matchType;
  });

  if (filtered.length === 0) {
    const types = srTypeFilter === 'all' ? ['link', 'tip'] : [srTypeFilter];
    types.forEach(t => grid.appendChild(buildSREmptyCard(t)));
    return;
  }
  filtered.forEach(r => grid.appendChild(buildSRCard(r)));
}

function buildSRCard(r) {
  const card = document.createElement('div');
  card.className = 'sr-card'; card.dataset.subj = r.subject;
  card.appendChild(Object.assign(document.createElement('div'), { className: 'sr-card-stripe' }));

  const body = document.createElement('div'); body.className = 'sr-card-body';
  const top  = document.createElement('div'); top.className  = 'sr-card-top';
  const badge = document.createElement('span');
  badge.className = `sr-type-badge ${r.resource_type}`;
  badge.textContent = r.resource_type === 'link' ? '🔗 サイト' : '💡 ヒント';
  const title = document.createElement('div'); title.className = 'sr-card-title'; title.textContent = r.title;
  top.append(badge, title); body.appendChild(top);

  if (r.description?.trim()) {
    const desc = document.createElement('div'); desc.className = 'sr-card-desc'; desc.textContent = r.description;
    body.appendChild(desc);
  }
  if (r.resource_type === 'tip' && r.tip?.trim()) {
    const tipEl = document.createElement('div'); tipEl.className = 'sr-card-tip'; tipEl.textContent = r.tip;
    body.appendChild(tipEl);
  }
  card.appendChild(body);

  const footer = document.createElement('div'); footer.className = 'sr-card-footer';
  const left   = document.createElement('div');
  left.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';

  if (r.resource_type === 'link' && r.url) {
    const a = document.createElement('a'); a.className = 'sr-card-link';
    a.href = r.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg> 開く`;
    left.appendChild(a);
  }
  const by = document.createElement('span'); by.className = 'sr-card-by';
  by.textContent = r.profiles?.name ? `by ${r.profiles.name}` : ''; left.appendChild(by);
  footer.appendChild(left);

  if (currentProfile.role === 'sensei' && r.author_id === currentProfile.id) {
    const acts = document.createElement('div'); acts.className = 'sr-card-actions';
    const eBtn = document.createElement('button'); eBtn.className = 'sr-edit-btn'; eBtn.textContent = '編集';
    eBtn.addEventListener('click', () => openSRModalEdit(r));
    const dBtn = document.createElement('button'); dBtn.className = 'sr-del-btn'; dBtn.textContent = '削除';
    dBtn.addEventListener('click', async () => {
      if (!confirm(`「${r.title}」を削除しますか？`)) return;
      await sb.from('subject_resources').delete().eq('id', r.id);
      showToast('削除しました');
    });
    acts.append(eBtn, dBtn); footer.appendChild(acts);
  }
  card.appendChild(footer);
  return card;
}

function buildSREmptyCard(type) {
  const card = document.createElement('div'); card.className = 'sr-empty-card';
  const subj = SUBJECTS[srSubject];
  const isLink = type === 'link';
  card.innerHTML = `
    <div class="sr-empty-icon">${isLink ? '🔗' : '💡'}</div>
    <div class="sr-empty-text">${subj?.label || ''}の${isLink ? 'おすすめサイト' : '勉強ヒント'}はまだありません</div>
  `;
  if (currentProfile.role === 'sensei') {
    const addBtn = document.createElement('button'); addBtn.className = 'sr-empty-add';
    addBtn.textContent = `+ ${isLink ? 'サイトを追加' : 'ヒントを追加'}`;
    addBtn.addEventListener('click', () => {
      document.querySelectorAll('.cat-btn[data-srtype]').forEach(b => b.classList.toggle('active', b.dataset.srtype === type));
      document.getElementById('srUrlField')?.classList.toggle('hidden', type !== 'link');
      document.getElementById('srTipField')?.classList.toggle('hidden', type === 'link');
      document.getElementById('srSubject').value = srSubject;
      openSRModalNew();
    });
    card.appendChild(addBtn);
  }
  return card;
}

function setupSRModal() {
  document.getElementById('openSRModal')?.addEventListener('click', openSRModalNew);
  document.getElementById('closeSRModal')?.addEventListener('click', closeSRModal);
  document.getElementById('srModal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeSRModal(); });
  document.querySelectorAll('.cat-btn[data-srtype]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cat-btn[data-srtype]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const isLink = btn.dataset.srtype === 'link';
      document.getElementById('srUrlField')?.classList.toggle('hidden', !isLink);
      document.getElementById('srTipField')?.classList.toggle('hidden', isLink);
    });
  });
  document.getElementById('srSubmitBtn')?.addEventListener('click', submitSRResource);
}

function openSRModalNew() {
  srEditId = null;
  setText('srModalTitle', 'リソースを追加');
  ['srTitle','srUrl','srTip','srDesc'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('srSubject').value = srSubject;
  document.getElementById('srLevel').value   = srLevel;
  document.getElementById('srError').textContent = '';
  document.querySelectorAll('.cat-btn[data-srtype]').forEach(b => b.classList.toggle('active', b.dataset.srtype === 'link'));
  document.getElementById('srUrlField')?.classList.remove('hidden');
  document.getElementById('srTipField')?.classList.add('hidden');
  document.getElementById('srSubmitBtn').textContent = '追加する';
  document.getElementById('srModal').classList.remove('hidden');
  document.getElementById('srTitle').focus();
}

function openSRModalEdit(r) {
  srEditId = r.id;
  setText('srModalTitle', 'リソースを編集');
  document.getElementById('srTitle').value   = r.title;
  document.getElementById('srUrl').value     = r.url || '';
  document.getElementById('srTip').value     = r.tip || '';
  document.getElementById('srDesc').value    = r.description || '';
  document.getElementById('srSubject').value = r.subject;
  document.getElementById('srLevel').value   = r.level;
  document.getElementById('srError').textContent = '';
  const isLink = r.resource_type === 'link';
  document.querySelectorAll('.cat-btn[data-srtype]').forEach(b => b.classList.toggle('active', b.dataset.srtype === r.resource_type));
  document.getElementById('srUrlField')?.classList.toggle('hidden', !isLink);
  document.getElementById('srTipField')?.classList.toggle('hidden', isLink);
  document.getElementById('srSubmitBtn').textContent = '保存する';
  document.getElementById('srModal').classList.remove('hidden');
  document.getElementById('srTitle').focus();
}

function closeSRModal() { document.getElementById('srModal').classList.add('hidden'); srEditId = null; }

async function submitSRResource() {
  const title   = document.getElementById('srTitle').value.trim();
  const url     = document.getElementById('srUrl').value.trim();
  const tip     = document.getElementById('srTip').value.trim();
  const desc    = document.getElementById('srDesc').value.trim();
  const subject = document.getElementById('srSubject').value;
  const level   = document.getElementById('srLevel').value;
  const type    = document.querySelector('.cat-btn[data-srtype].active')?.dataset.srtype || 'link';
  const err     = document.getElementById('srError');
  err.textContent = '';
  if (!title) { err.textContent = 'タイトルを入力してください'; return; }
  if (type === 'link' && !url) { err.textContent = 'URLを入力してください'; return; }
  if (type === 'tip'  && !tip) { err.textContent = 'ヒント内容を入力してください'; return; }

  const btn = document.getElementById('srSubmitBtn');
  btn.disabled = true; btn.textContent = '保存中...';

  const payload = {
    author_id: currentProfile.id, subject, level, title,
    description: desc, url: type === 'link' ? url : '',
    tip: type === 'tip' ? tip : '', resource_type: type,
    updated_at: new Date().toISOString(),
  };

  const { error } = srEditId
    ? await sb.from('subject_resources').update(payload).eq('id', srEditId)
    : await sb.from('subject_resources').insert(payload);

  btn.disabled = false; btn.textContent = srEditId ? '保存する' : '追加する';
  if (error) { err.textContent = 'エラー: ' + error.message; return; }
  showToast(srEditId ? '更新しました ✅' : 'リソースを追加しました ✅');
  closeSRModal();
}

// ============================================================
//  PROFILE MODAL + AVATAR
// ============================================================
const AVATAR_EMOJIS = [
  '😀','😁','😂','🥰','😎','🤔','🥳','😴','🤯','😇',
  '🐱','🐶','🦊','🐸','🦁','🐼','🦄','🐙','🦋','🐨',
  '🐯','🦅','🦉','🐧','🦜','🐬','🦈','🐉','🌸','🌊',
  '⚡','🔥','💧','🌙','⭐','🌈','☀️','❄️','🎮','🎨',
  '🎵','📸','💻','🚀','🎯','🏆','💎','🎲','🍎','🍕',
  '🍜','🍣','☕','🎂','🍓','🌮','🏀','⚽','🎾','🏊',
  '🤸','🌺','🌻','🌹','🍀','🌵','🌴','🌿','🍁','🌾',
  '🦸','🧙','👨‍🏫','🎓','👩‍💻','👨‍🔬','👩‍🎨','🧑‍🚀','💪','👀',
];
const AVATAR_COLORS = [
  '#1d9bf0','#7c3aed','#10b981','#f59e0b','#ef4444',
  '#ec4899','#06b6d4','#8b5cf6','#f97316','#14b8a6',
  '#6366f1','#84cc16','#d946ef','#0ea5e9','#a78bfa',
  '#fb923c','#34d399','#fbbf24','#f43f5e','#38bdf8',
];
let avatarNewFile=null,avatarNewEmoji=null,avatarNewColor=null,avatarNewPhotoURL=null,avatarMode='color';

function setupProfileModal(){
  document.getElementById('sidebarUser')?.addEventListener('click',openProfileModal);
  document.getElementById('closeProfileModal')?.addEventListener('click',closeProfileModal);
  document.getElementById('profileModal')?.addEventListener('click',e=>{if(e.target===e.currentTarget)closeProfileModal();});
  document.querySelectorAll('.avatar-tab').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.avatar-tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      avatarMode=btn.dataset.atab;
      document.getElementById('avatarTabPhoto')?.classList.toggle('hidden',avatarMode!=='photo');
      document.getElementById('avatarTabEmoji')?.classList.toggle('hidden',avatarMode!=='emoji');
      document.getElementById('avatarTabColor')?.classList.toggle('hidden',avatarMode!=='color');
    });
  });
  document.getElementById('avatarFileInput')?.addEventListener('change',e=>{
    const file=e.target.files[0]; if(!file)return;
    if(file.size>5*1024*1024){showToast('ファイルは5MB以下にしてください');return;}
    avatarNewFile=file; avatarNewPhotoURL=URL.createObjectURL(file);
    document.getElementById('avatarPhotoPreviewWrap').classList.remove('hidden');
    document.getElementById('avatarUploadDrop').classList.add('hidden');
    document.getElementById('avatarPhotoPreview').src=avatarNewPhotoURL;
    updateProfilePreview();
  });
  document.getElementById('avatarRemovePhoto')?.addEventListener('click',()=>{
    avatarNewFile=null; avatarNewPhotoURL=null;
    document.getElementById('avatarPhotoPreviewWrap').classList.add('hidden');
    document.getElementById('avatarUploadDrop').classList.remove('hidden');
    document.getElementById('avatarFileInput').value='';
    updateProfilePreview();
  });
  buildEmojiGrid();
  document.getElementById('avatarEmojiSearch')?.addEventListener('input',e=>buildEmojiGrid(e.target.value.trim()));
  buildColorSwatches();
  document.getElementById('avatarColorCustom')?.addEventListener('input',e=>{
    avatarNewColor=e.target.value;
    document.querySelectorAll('.avatar-color-swatch').forEach(s=>s.classList.remove('selected'));
    updateProfilePreview();
  });
  document.getElementById('saveProfileBtn')?.addEventListener('click',saveProfile);
}

function buildEmojiGrid(filter=''){
  const grid=document.getElementById('avatarEmojiGrid'); if(!grid)return;
  grid.innerHTML='';
  const list=filter?AVATAR_EMOJIS.filter(e=>e.includes(filter)):AVATAR_EMOJIS;
  if(!list.length){grid.innerHTML='<p style="color:var(--text2);font-size:.78rem;padding:8px;grid-column:1/-1">見つかりません</p>';return;}
  list.forEach(emoji=>{
    const btn=document.createElement('button'); btn.className='avatar-emoji-btn'; btn.textContent=emoji;
    if(emoji===(avatarNewEmoji||currentProfile?.avatar_icon))btn.classList.add('selected');
    btn.addEventListener('click',()=>{
      avatarNewEmoji=emoji; avatarMode='emoji';
      document.querySelectorAll('.avatar-emoji-btn').forEach(b=>b.classList.remove('selected'));
      btn.classList.add('selected'); updateProfilePreview();
    });
    grid.appendChild(btn);
  });
}

function buildColorSwatches(){
  const wrap=document.getElementById('avatarColorSwatches'); if(!wrap)return;
  wrap.innerHTML='';
  AVATAR_COLORS.forEach(color=>{
    const sw=document.createElement('button'); sw.className='avatar-color-swatch';
    sw.style.background=color; sw.dataset.color=color;
    if(color===(avatarNewColor||currentProfile?.color))sw.classList.add('selected');
    sw.addEventListener('click',()=>{
      avatarNewColor=color; avatarMode='color';
      document.querySelectorAll('.avatar-color-swatch').forEach(s=>s.classList.remove('selected'));
      sw.classList.add('selected');
      document.getElementById('avatarColorCustom').value=color;
      updateProfilePreview();
    });
    wrap.appendChild(sw);
  });
}

function updateProfilePreview(){
  const prev=document.getElementById('profileAvatarPreview'); if(!prev)return;
  prev.innerHTML=''; prev.style.background='';
  if(avatarMode==='photo'&&avatarNewPhotoURL){
    const img=document.createElement('img'); img.src=avatarNewPhotoURL; img.alt='preview'; prev.appendChild(img);
  } else if(avatarMode==='emoji'&&avatarNewEmoji){
    prev.textContent=avatarNewEmoji; prev.style.background='var(--bg3)';
  } else {
    const color=avatarNewColor||currentProfile?.color||'#1d9bf0';
    prev.style.background=color; prev.textContent=(currentProfile?.name||'?')[0].toUpperCase();
  }
}

function openProfileModal(){
  avatarNewFile=null; avatarNewEmoji=currentProfile.avatar_icon||null;
  avatarNewColor=currentProfile.color||'#1d9bf0'; avatarNewPhotoURL=null;
  avatarMode=currentProfile.avatar_url?'photo':currentProfile.avatar_icon?'emoji':'color';
  document.getElementById('profileNameInput').value=currentProfile.name||'';
  document.getElementById('profileBioInput').value=currentProfile.bio||'';
  document.getElementById('profileError').textContent='';
  document.querySelectorAll('.avatar-tab').forEach(b=>b.classList.toggle('active',b.dataset.atab===avatarMode));
  document.getElementById('avatarTabPhoto')?.classList.toggle('hidden',avatarMode!=='photo');
  document.getElementById('avatarTabEmoji')?.classList.toggle('hidden',avatarMode!=='emoji');
  document.getElementById('avatarTabColor')?.classList.toggle('hidden',avatarMode!=='color');
  if(currentProfile.avatar_url){
    avatarNewPhotoURL=currentProfile.avatar_url;
    document.getElementById('avatarPhotoPreview').src=currentProfile.avatar_url;
    document.getElementById('avatarPhotoPreviewWrap').classList.remove('hidden');
    document.getElementById('avatarUploadDrop').classList.add('hidden');
  } else {
    document.getElementById('avatarPhotoPreviewWrap').classList.add('hidden');
    document.getElementById('avatarUploadDrop').classList.remove('hidden');
  }
  document.getElementById('avatarEmojiSearch').value='';
  buildEmojiGrid(); buildColorSwatches();
  document.getElementById('avatarColorCustom').value=avatarNewColor;
  updateProfilePreview();
  document.getElementById('profileModal').classList.remove('hidden');
}

function closeProfileModal(){
  document.getElementById('profileModal').classList.add('hidden');
  if(avatarNewPhotoURL&&avatarNewPhotoURL!==currentProfile.avatar_url)URL.revokeObjectURL(avatarNewPhotoURL);
  avatarNewFile=null; avatarNewPhotoURL=null;
}

async function saveProfile(){
  const name=document.getElementById('profileNameInput').value.trim();
  const bio =document.getElementById('profileBioInput').value.trim();
  const err =document.getElementById('profileError'); err.textContent='';
  if(!name){err.textContent='表示名を入力してください';return;}
  const btn=document.getElementById('saveProfileBtn');
  btn.disabled=true; btn.textContent='保存中...';

  let avatar_url=currentProfile.avatar_url||'';
  let avatar_icon=currentProfile.avatar_icon||'';
  let color=currentProfile.color||'#1d9bf0';

  if(avatarMode==='photo'&&avatarNewFile){
    const ext=avatarNewFile.name.split('.').pop().toLowerCase();
    const path=`${currentUser.id}/avatar.${ext}`;
    const {error:upErr}=await sb.storage.from('avatars').upload(path,avatarNewFile,{upsert:true});
    if(upErr){err.textContent='アップロード失敗: '+upErr.message;btn.disabled=false;btn.textContent='保存する';return;}
    const {data:ud}=sb.storage.from('avatars').getPublicUrl(path);
    avatar_url=ud.publicUrl+'?t='+Date.now(); avatar_icon='';
  } else if(avatarMode==='photo'&&!avatarNewFile&&!avatarNewPhotoURL){
    avatar_url='';
  } else if(avatarMode==='emoji'&&avatarNewEmoji){
    avatar_icon=avatarNewEmoji; avatar_url='';
  } else if(avatarMode==='color'){
    color=avatarNewColor||color; avatar_url=''; avatar_icon='';
  }

  const {error}=await sb.from('profiles').update({name,bio,color,avatar_url,avatar_icon}).eq('id',currentUser.id);
  btn.disabled=false; btn.textContent='保存する';
  if(error){err.textContent='保存失敗: '+error.message;return;}

  currentProfile={...currentProfile,name,bio,color,avatar_url,avatar_icon};
  const idx=allProfiles.findIndex(p=>p.id===currentProfile.id);
  if(idx!==-1)allProfiles[idx]={...allProfiles[idx],name,bio,color,avatar_url,avatar_icon};

  renderSidebarProfile();
  showToast('プロフィールを保存しました ✅');
  closeProfileModal();
}

// ============================================================
function setupRealtime() {
  cleanupRealtime();

  // 会話リスト更新
  convChannel = sb.channel('conv-rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, async payload => {
      const uid = currentProfile.id;
      const row = payload.new || payload.old;
      if (!row) return;
      if (row.participant_a_id !== uid && row.participant_b_id !== uid) return;
      await loadConversations();
      renderConvList();
    })
    .subscribe();

  // お知らせリアルタイム
  annChannel = sb.channel('ann-rt')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'announcements' }, async () => {
      await loadAnnouncements();
    })
    .subscribe();

  // リクエスト受信 (先生のみポップアップ)
  if (currentProfile.role === 'sensei') {
    reqChannel = sb.channel('req-rt-' + currentProfile.id)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'requests',
          filter: `sensei_id=eq.${currentProfile.id}` },
        payload => {
          if (payload.new) showReqPopup(payload.new);
        })
      .subscribe();
  }
}

function subscribeToMessages(convId) {
  if (msgChannel) sb.removeChannel(msgChannel);
  msgChannel = sb.channel(`msg-rt-${convId}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${convId}` },
      payload => {
        if (!payload.new) return;
        if (payload.new.sender_id === currentProfile.id) return;
        if (payload.new.conversation_id !== activeConvId) return;
        appendMessage(payload.new);
      })
    .subscribe();
}

function cleanupRealtime() {
  [msgChannel, convChannel, annChannel, reqChannel, nbChannel, goalsChannel, srChannel].forEach(ch => { if (ch) sb.removeChannel(ch); });
  msgChannel = convChannel = annChannel = reqChannel = nbChannel = goalsChannel = srChannel = null;
}

// ============================================================
//  LIGHTBOX
// ============================================================
function setupLightbox() {
  document.getElementById('lightboxClose')?.addEventListener('click', closeLightbox);
  document.getElementById('lightbox')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeLightbox(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('lightbox').classList.contains('hidden')) closeLightbox();
  });
}
function openLightbox(url, type) {
  const c = document.getElementById('lightboxContent');
  c.innerHTML = '';
  if (type === 'image') { const img = document.createElement('img'); img.src = url; img.alt = '拡大'; c.appendChild(img); }
  if (type === 'video') { const v = document.createElement('video'); v.src = url; v.controls = true; v.autoplay = true; c.appendChild(v); }
  document.getElementById('lightbox').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.body.style.overflow = '';
}

// ============================================================
//  UTILS
// ============================================================
// Sets the visual content of an existing .avatar element based on profile
function setAvatarEl(el, profile, size = '') {
  if (!el) return;
  el.className = 'avatar' + (size ? ' ' + size : '');
  el.innerHTML = '';
  el.style.background = '';
  el.textContent = '';

  if (profile.avatar_url) {
    const img = document.createElement('img');
    img.src = profile.avatar_url; img.alt = profile.name || '';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;';
    el.appendChild(img);
  } else if (profile.avatar_icon) {
    el.textContent = profile.avatar_icon;
    el.style.background = 'var(--bg3)';
    el.style.fontSize = size === 'xs' ? '.9rem' : size === 'sm' ? '1rem' : '1.3rem';
  } else {
    el.style.background = profile.color || '#1d9bf0';
    el.textContent = (profile.name || '?')[0].toUpperCase();
  }
}

function makeAvatarEl(profile, size = '') {
  const av = document.createElement('div');
  setAvatarEl(av, profile, size);
  return av;
}
function scrollToBottom() {
  const a = document.getElementById('messagesArea');
  if (a) requestAnimationFrame(() => { a.scrollTop = a.scrollHeight; });
}
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return 'たった今';
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h}時間前`;
  const d = Math.floor(h / 24);
  if (d < 7)    return `${d}日前`;
  return new Date(ts).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
}
let _toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
