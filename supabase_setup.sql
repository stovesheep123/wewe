-- ============================================================
-- wewe (先生/生徒 Chat App) - Supabase セットアップSQL
-- Supabase ダッシュボード > SQL Editor で実行してください
-- ============================================================

-- ========== 既存オブジェクトをクリーンアップ ==========
drop trigger  if exists on_auth_user_created      on auth.users;
drop function if exists public.handle_new_user()  cascade;

-- Drop policies safely (only if their table exists)
do $$ begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename='profiles') then
    drop policy if exists "profiles_select" on public.profiles;
    drop policy if exists "profiles_update" on public.profiles;
    drop policy if exists "profiles_insert" on public.profiles;
  end if;
  if exists (select 1 from pg_tables where schemaname='public' and tablename='posts') then
    drop policy if exists "posts_select" on public.posts;
    drop policy if exists "posts_insert" on public.posts;
    drop policy if exists "posts_update" on public.posts;
    drop policy if exists "posts_delete" on public.posts;
  end if;
  if exists (select 1 from pg_tables where schemaname='public' and tablename='messages') then
    drop policy if exists "messages_select" on public.messages;
    drop policy if exists "messages_insert" on public.messages;
  end if;
  if exists (select 1 from pg_tables where schemaname='public' and tablename='conversations') then
    drop policy if exists "conversations_select"  on public.conversations;
    drop policy if exists "conversations_insert"  on public.conversations;
    drop policy if exists "conversations_update"  on public.conversations;
  end if;
  if exists (select 1 from pg_tables where schemaname='public' and tablename='chat_permissions') then
    drop policy if exists "chat_permissions_select" on public.chat_permissions;
    drop policy if exists "chat_permissions_insert" on public.chat_permissions;
    drop policy if exists "chat_permissions_delete" on public.chat_permissions;
  end if;
end $$;

drop table if exists public.messages          cascade;
drop table if exists public.conversations     cascade;
drop table if exists public.chat_permissions  cascade;
drop table if exists public.posts             cascade;
drop table if exists public.profiles          cascade;


-- ============================================================
-- ① profiles テーブル
--    role: 'sensei'（先生） or 'seito'（生徒）
-- ============================================================
create table public.profiles (
  id         uuid references auth.users on delete cascade primary key,
  handle     text unique not null,
  name       text not null,
  role       text not null default 'seito' check (role in ('sensei','seito')),
  color      text not null default '#1d9bf0',
  bio        text not null default '',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select"
  on public.profiles for select
  using (true);

create policy "profiles_update"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "profiles_insert"
  on public.profiles for insert
  with check (auth.uid() = id);


-- ============================================================
-- ② auth.users 作成時に profiles を自動生成する trigger
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, handle, name, color, role, bio)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'handle', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'name',   'ユーザー'),
    coalesce(new.raw_user_meta_data->>'color',  '#1d9bf0'),
    coalesce(new.raw_user_meta_data->>'role',   'seito'),
    ''
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================
-- ③ chat_permissions テーブル
--    先生が特定の生徒同士のチャットを許可するレコード
--    sensei_id: 許可した先生
--    seito_a_id, seito_b_id: チャットを許可された生徒ペア
--    NULL の場合は sensei_id の先生が seito_a_id と話せる（先生↔生徒）
-- ============================================================
create table public.chat_permissions (
  id          uuid primary key default gen_random_uuid(),
  sensei_id   uuid references public.profiles(id) on delete cascade not null,
  seito_a_id  uuid references public.profiles(id) on delete cascade not null,
  seito_b_id  uuid references public.profiles(id) on delete cascade,  -- NULL = sensei <-> seito_a
  created_at  timestamptz not null default now(),
  unique (sensei_id, seito_a_id, seito_b_id)
);

alter table public.chat_permissions enable row level security;

-- 自分が関係するパーミッションは読める
create policy "chat_permissions_select"
  on public.chat_permissions for select
  using (
    auth.uid() = sensei_id
    or auth.uid() = seito_a_id
    or auth.uid() = seito_b_id
  );

-- 先生のみINSERT（アプリ側でロールを確認、DBでも制限）
create policy "chat_permissions_insert"
  on public.chat_permissions for insert
  with check (
    auth.uid() = sensei_id
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'sensei'
    )
  );

-- 先生のみDELETE（許可取り消し）
create policy "chat_permissions_delete"
  on public.chat_permissions for delete
  using (auth.uid() = sensei_id);


-- ============================================================
-- ④ conversations テーブル
--    2人のユーザー間の会話セッション
--    participant_a_id < participant_b_id（UUID文字列比較で常に小さい方がa）
-- ============================================================
create table public.conversations (
  id               uuid primary key default gen_random_uuid(),
  participant_a_id uuid references public.profiles(id) on delete cascade not null,
  participant_b_id uuid references public.profiles(id) on delete cascade not null,
  last_message_at  timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (participant_a_id, participant_b_id),
  check (participant_a_id < participant_b_id)
);

alter table public.conversations enable row level security;

-- 参加者のみ読める
create policy "conversations_select"
  on public.conversations for select
  using (
    auth.uid() = participant_a_id
    or auth.uid() = participant_b_id
  );

create policy "conversations_insert"
  on public.conversations for insert
  with check (
    auth.uid() = participant_a_id
    or auth.uid() = participant_b_id
  );

create policy "conversations_update"
  on public.conversations for update
  using (
    auth.uid() = participant_a_id
    or auth.uid() = participant_b_id
  );


-- ============================================================
-- ⑤ messages テーブル
--    テキスト、画像URL、PDF URL、動画URLを持てる
-- ============================================================
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade not null,
  sender_id       uuid references public.profiles(id) on delete cascade not null,
  body            text not null default '',
  attachments     jsonb not null default '[]',  -- [{type:'image'|'pdf'|'video'|'gif', url:'...', name:'...'}]
  created_at      timestamptz not null default now()
);

alter table public.messages enable row level security;

-- 会話参加者のみ読める
create policy "messages_select"
  on public.messages for select
  using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and (c.participant_a_id = auth.uid() or c.participant_b_id = auth.uid())
    )
  );

-- 会話参加者のみ送信可
create policy "messages_insert"
  on public.messages for insert
  with check (
    auth.uid() = sender_id
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and (c.participant_a_id = auth.uid() or c.participant_b_id = auth.uid())
    )
  );


-- ============================================================
-- ⑥ Storage バケット
-- ============================================================

-- チャット添付ファイル用バケット（PDF・動画・画像・GIF）
insert into storage.buckets (id, name, public)
  values ('chat-files', 'chat-files', true)
  on conflict (id) do nothing;

do $$
begin
  drop policy if exists "chat_files_select" on storage.objects;
  drop policy if exists "chat_files_insert" on storage.objects;
end $$;

create policy "chat_files_select"
  on storage.objects for select
  using (bucket_id = 'chat-files');

create policy "chat_files_insert"
  on storage.objects for insert
  with check (bucket_id = 'chat-files' and auth.role() = 'authenticated');


-- ============================================================
-- ⑦ Realtime を有効化
-- ============================================================
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when others then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.conversations;
exception when others then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.chat_permissions;
exception when others then null;
end $$;


-- ============================================================
-- 完了
-- ============================================================
select '先生/生徒 チャットアプリ DB セットアップ完了！' as status;


-- ============================================================
-- ⑧ announcements テーブル (先生が投稿するお知らせ・テスト情報)
-- ============================================================
do $$ begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename='announcements') then
    drop policy if exists "ann_select" on public.announcements;
    drop policy if exists "ann_insert" on public.announcements;
    drop policy if exists "ann_update" on public.announcements;
    drop policy if exists "ann_delete" on public.announcements;
  end if;
end $$;
drop table if exists public.announcements cascade;

create table public.announcements (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid references public.profiles(id) on delete cascade not null,
  title       text not null default '',
  body        text not null default '',
  category    text not null default 'info'
              check (category in ('info','test','exam','news')),
  attachments jsonb not null default '[]',
  created_at  timestamptz not null default now()
);
alter table public.announcements enable row level security;
create policy "ann_select" on public.announcements for select using (true);
create policy "ann_insert" on public.announcements for insert
  with check (auth.uid() = author_id and exists (
    select 1 from public.profiles where id = auth.uid() and role = 'sensei'));
create policy "ann_update" on public.announcements for update
  using (auth.uid() = author_id);
create policy "ann_delete" on public.announcements for delete
  using (auth.uid() = author_id);


-- ============================================================
-- ⑨ requests テーブル (生徒→先生へのリクエスト)
-- ============================================================
do $$ begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename='requests') then
    drop policy if exists "req_select" on public.requests;
    drop policy if exists "req_insert" on public.requests;
    drop policy if exists "req_update" on public.requests;
  end if;
end $$;
drop table if exists public.requests cascade;

create table public.requests (
  id          uuid primary key default gen_random_uuid(),
  seito_id    uuid references public.profiles(id) on delete cascade not null,
  sensei_id   uuid references public.profiles(id) on delete cascade not null,
  body        text not null,
  status      text not null default 'pending'
              check (status in ('pending','accepted','declined')),
  created_at  timestamptz not null default now()
);
alter table public.requests enable row level security;
-- 送った生徒・受け取った先生のどちらも読める
create policy "req_select" on public.requests for select
  using (auth.uid() = seito_id or auth.uid() = sensei_id);
-- 生徒のみ送れる
create policy "req_insert" on public.requests for insert
  with check (auth.uid() = seito_id and exists (
    select 1 from public.profiles where id = auth.uid() and role = 'seito'));
-- 先生がステータス更新
create policy "req_update" on public.requests for update
  using (auth.uid() = sensei_id);

-- Realtime on new tables
do $$ begin
  alter publication supabase_realtime add table public.announcements;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.requests;
exception when others then null; end $$;

select '⑧⑨ announcements + requests テーブル追加完了！' as status;

-- ============================================================
-- ⑩ notice_board テーブル (掲示板 - 先生が編集・生徒は読むだけ)
-- ============================================================
do $$ begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename='notice_board') then
    drop policy if exists "nb_select" on public.notice_board;
    drop policy if exists "nb_insert" on public.notice_board;
    drop policy if exists "nb_update" on public.notice_board;
    drop policy if exists "nb_delete" on public.notice_board;
  end if;
end $$;
drop table if exists public.notice_board cascade;

create table public.notice_board (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid references public.profiles(id) on delete cascade not null,
  title       text not null,
  body        text not null default '',
  pinned      boolean not null default false,
  color       text not null default '#1d9bf0',   -- accent color for the card
  attachments jsonb not null default '[]',
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

alter table public.notice_board enable row level security;

-- 全員読める
create policy "nb_select" on public.notice_board for select using (true);

-- 先生のみ投稿
create policy "nb_insert" on public.notice_board for insert
  with check (auth.uid() = author_id and exists (
    select 1 from public.profiles where id = auth.uid() and role = 'sensei'));

-- 投稿した先生のみ更新
create policy "nb_update" on public.notice_board for update
  using (auth.uid() = author_id);

-- 投稿した先生のみ削除
create policy "nb_delete" on public.notice_board for delete
  using (auth.uid() = author_id);

-- Realtime
do $$ begin
  alter publication supabase_realtime add table public.notice_board;
exception when others then null; end $$;

select '⑩ notice_board テーブル追加完了！' as status;

-- ============================================================
-- ⑪ goals テーブル (生徒の目標 - 本人のみ書き込み・任意公開)
-- ============================================================
do $$ begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename='goals') then
    drop policy if exists "goals_select"        on public.goals;
    drop policy if exists "goals_insert"        on public.goals;
    drop policy if exists "goals_update"        on public.goals;
    drop policy if exists "goals_delete"        on public.goals;
  end if;
end $$;
drop table if exists public.goals cascade;

create table public.goals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles(id) on delete cascade not null unique,
  goal_text   text not null default '',
  is_public   boolean not null default false,
  checked     boolean not null default false,  -- 今日チェックしたか
  checked_at  date,                            -- 最後にチェックした日付
  streak      int  not null default 0,         -- 連続チェック日数
  updated_at  timestamptz not null default now()
);
alter table public.goals enable row level security;

-- 公開ゴールは全員読める。非公開は本人のみ
create policy "goals_select" on public.goals for select
  using (is_public = true or auth.uid() = user_id);

create policy "goals_insert" on public.goals for insert
  with check (auth.uid() = user_id);

create policy "goals_update" on public.goals for update
  using (auth.uid() = user_id);

create policy "goals_delete" on public.goals for delete
  using (auth.uid() = user_id);

do $$ begin
  alter publication supabase_realtime add table public.goals;
exception when others then null; end $$;

select '⑪ goals テーブル追加完了！' as status;

-- ============================================================
-- ⑫ subject_resources テーブル
--    先生が各教科にリソース(リンク・ヒント)を追加
--    level: 'jhs'(中学) | 'hs'(高校) | 'both'
--    subject: 'math'|'japanese'|'english'|'science'|'social'
-- ============================================================
do $$ begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename='subject_resources') then
    drop policy if exists "sr_select" on public.subject_resources;
    drop policy if exists "sr_insert" on public.subject_resources;
    drop policy if exists "sr_update" on public.subject_resources;
    drop policy if exists "sr_delete" on public.subject_resources;
  end if;
end $$;
drop table if exists public.subject_resources cascade;

create table public.subject_resources (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid references public.profiles(id) on delete cascade not null,
  subject     text not null check (subject in ('math','japanese','english','science','social')),
  level       text not null default 'both' check (level in ('jhs','hs','both')),
  title       text not null,
  description text not null default '',
  url         text not null default '',
  tip         text not null default '',   -- 勉強のコツ (URLがない場合)
  resource_type text not null default 'link' check (resource_type in ('link','tip')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.subject_resources enable row level security;

-- 全員読める
create policy "sr_select" on public.subject_resources for select using (true);

-- 先生のみ追加
create policy "sr_insert" on public.subject_resources for insert
  with check (auth.uid() = author_id and exists (
    select 1 from public.profiles where id = auth.uid() and role = 'sensei'));

-- 投稿した先生のみ編集
create policy "sr_update" on public.subject_resources for update
  using (auth.uid() = author_id);

-- 投稿した先生のみ削除
create policy "sr_delete" on public.subject_resources for delete
  using (auth.uid() = author_id);

do $$ begin
  alter publication supabase_realtime add table public.subject_resources;
exception when others then null; end $$;

select '⑫ subject_resources テーブル追加完了！' as status;

-- ============================================================
-- ⑬ profiles に avatar_url と avatar_icon を追加
--    avatar_url : Supabase Storage の公開URL (写真)
--    avatar_icon: 絵文字 1文字 (アイコン選択時)
-- ============================================================
alter table public.profiles
  add column if not exists avatar_url  text not null default '',
  add column if not exists avatar_icon text not null default '';

-- avatars バケット (公開)
insert into storage.buckets (id, name, public)
  values ('avatars', 'avatars', true)
  on conflict (id) do nothing;

do $$
begin
  drop policy if exists "avatars_select" on storage.objects;
  drop policy if exists "avatars_insert" on storage.objects;
  drop policy if exists "avatars_update" on storage.objects;
end $$;

create policy "avatars_select"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "avatars_insert"
  on storage.objects for insert
  with check (bucket_id = 'avatars' and auth.role() = 'authenticated');

create policy "avatars_update"
  on storage.objects for update
  using (bucket_id = 'avatars' and auth.role() = 'authenticated');

select '⑬ avatar_url / avatar_icon + avatars bucket 追加完了！' as status;
