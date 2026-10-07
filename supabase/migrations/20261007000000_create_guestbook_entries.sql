create table public.guestbook_entries (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 20),
  message text not null check (char_length(btrim(message)) between 1 and 200),
  ai_reply text,
  ai_error text,
  created_at timestamptz not null default now()
);

create index guestbook_entries_created_at_idx
  on public.guestbook_entries (created_at desc);

alter table public.guestbook_entries enable row level security;

create policy "anyone can read entries"
  on public.guestbook_entries for select
  to anon, authenticated
  using (true);

create policy "anyone can add entries without ai fields"
  on public.guestbook_entries for insert
  to anon, authenticated
  with check (ai_reply is null and ai_error is null);

-- 브라우저(anon)는 읽기/쓰기만. UPDATE/DELETE는 주지 않는다.
grant select, insert on public.guestbook_entries to anon, authenticated;

-- 2단계: Edge Function(service_role)이 글을 읽고 AI 답글을 저장한다.
grant select, update on public.guestbook_entries to service_role;
-- 기본으로 붙는 불필요한 권한 회수
revoke truncate, trigger, references on public.guestbook_entries from anon, authenticated;
