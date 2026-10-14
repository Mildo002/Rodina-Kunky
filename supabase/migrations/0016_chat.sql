-- Rodina – CHAT medzi členmi rodiny (súkromne vo dvojici, vo vybranej skupine alebo celá rodina).
-- Správy vidia iba účastníci konverzácie (nie celá rodina). Konverzácie zakladá iba funkcia open_chat().

-- ===== Konverzácie =====
create table chats (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  is_family boolean not null default false,            -- celá rodina (aj budúci členovia)
  member_key text not null,                            -- zoradené ID účastníkov / 'rodina' – jedna konverzácia na zostavu
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (household_id, member_key)
);
create table chat_members (
  chat_id uuid not null references chats on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  household_id uuid not null references households on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);
create index on chat_members (user_id);
create index on chat_members (household_id);
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats on delete cascade,
  household_id uuid not null references households on delete cascade,
  sender_id uuid references auth.users on delete set null default auth.uid(),
  body text not null default '',
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  constraint chat_body_len check (deleted or char_length(btrim(body)) between 1 and 4000)
);
create index on chat_messages (chat_id, created_at desc);
create index on chat_messages (household_id);
create index on chat_messages (sender_id);
create index on chats (created_by);

-- ===== Kto smie čítať konverzáciu: člen rodiny a (celá rodina alebo účastník) =====
create or replace function is_chat_member(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from chats ch
    where ch.id = c and is_member(ch.household_id)
      and (ch.is_family or exists (select 1 from chat_members m where m.chat_id = c and m.user_id = auth.uid()))
  )
$$;
revoke execute on function is_chat_member(uuid) from public, anon;
grant execute on function is_chat_member(uuid) to authenticated;

alter table chats enable row level security;
alter table chat_members enable row level security;
alter table chat_messages enable row level security;

-- Konverzácie a účastníci: iba čítanie (zakladá open_chat, prečítanie mark_chat_read)
create policy chats_read on chats for select to authenticated using (is_chat_member(id));
create policy chat_members_read on chat_members for select to authenticated using (is_chat_member(chat_id));

-- Správy: čítať a písať smie iba účastník; meniť / zmazať iba vlastnú
create policy chat_messages_read on chat_messages for select to authenticated using (is_chat_member(chat_id));
create policy chat_messages_insert on chat_messages for insert to authenticated
  with check (is_chat_member(chat_id) and sender_id = (select auth.uid()));
create policy chat_messages_update on chat_messages for update to authenticated
  using (sender_id = (select auth.uid()) and is_chat_member(chat_id))
  with check (sender_id = (select auth.uid()) and is_chat_member(chat_id));

-- Pred vložením: odosielateľ = prihlásený, rodina podľa konverzácie (nedá sa podvrhnúť)
create or replace function chat_message_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then new.sender_id := auth.uid(); end if;
  select household_id into new.household_id from chats where id = new.chat_id;
  if new.household_id is null then raise exception 'Konverzácia neexistuje'; end if;
  new.body := btrim(new.body);
  new.deleted := false; new.edited_at := null; new.created_at := now();
  return new;
end $$;
create trigger chat_messages_before_insert before insert on chat_messages
  for each row execute function chat_message_before_insert();

-- Úprava: iba text alebo zmazanie; zmazaná správa sa už nedá obnoviť ani upraviť
create or replace function chat_message_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.chat_id is distinct from old.chat_id or new.household_id is distinct from old.household_id
     or new.sender_id is distinct from old.sender_id or new.created_at is distinct from old.created_at then
    raise exception 'Správu nemožno presunúť';
  end if;
  if old.deleted then raise exception 'Správa je zmazaná'; end if;
  if new.deleted then new.body := ''; new.edited_at := now();
  elsif new.body is distinct from old.body then new.body := btrim(new.body); new.edited_at := now();
  end if;
  return new;
end $$;
create trigger chat_messages_guard before update on chat_messages
  for each row execute function chat_message_guard();

-- Po vložení: čas poslednej správy, odosielateľ ju má prečítanú, upozornenie ostatným účastníkom
create or replace function chat_message_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update chats set last_message_at = new.created_at where id = new.chat_id;
  if new.sender_id is not null then
    insert into chat_members (chat_id, user_id, household_id, last_read_at)
    values (new.chat_id, new.sender_id, new.household_id, new.created_at)
    on conflict (chat_id, user_id) do update set last_read_at = excluded.last_read_at;
  end if;
  perform call_upozornenia(jsonb_build_object('event', 'chat', 'id', new.id, 'actor', new.sender_id));
  return new;
end $$;
create trigger chat_messages_after_insert after insert on chat_messages
  for each row execute function chat_message_after_insert();

revoke all on function chat_message_before_insert() from public, anon, authenticated;
revoke all on function chat_message_after_insert() from public, anon, authenticated;
revoke all on function chat_message_guard() from public, anon, authenticated;

-- ===== Otvoriť konverzáciu (alebo nájsť existujúcu) s vybranými členmi; prázdny zoznam = celá rodina =====
create or replace function open_chat(p_household uuid, p_users uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  ids uuid[];
  k text;
  cid uuid;
begin
  if me is null or not is_member(p_household) then raise exception 'Nie ste členom tejto rodiny'; end if;
  if coalesce(array_length(p_users, 1), 0) = 0 then
    k := 'rodina';
    insert into chats (household_id, is_family, member_key, created_by) values (p_household, true, k, me)
    on conflict (household_id, member_key) do nothing;
    select id into cid from chats where household_id = p_household and member_key = k;
    return cid;
  end if;
  select array_agg(distinct u order by u) into ids from unnest(p_users || me) u;
  if array_length(ids, 1) < 2 then raise exception 'Vyberte aspoň jedného člena rodiny'; end if;
  if array_length(ids, 1) > 50 then raise exception 'Príliš veľa účastníkov'; end if;
  if exists (select 1 from unnest(ids) u where not exists (select 1 from members m where m.household_id = p_household and m.user_id = u)) then
    raise exception 'Vybraný človek nie je členom rodiny';
  end if;
  k := array_to_string(ids, ',');
  insert into chats (household_id, member_key, created_by) values (p_household, k, me)
  on conflict (household_id, member_key) do nothing;
  select id into cid from chats where household_id = p_household and member_key = k;
  insert into chat_members (chat_id, user_id, household_id, last_read_at)
  select cid, u, p_household, '-infinity'::timestamptz from unnest(ids) u
  on conflict (chat_id, user_id) do nothing;
  return cid;
end $$;
revoke execute on function open_chat(uuid, uuid[]) from public, anon;
grant execute on function open_chat(uuid, uuid[]) to authenticated;

-- Prečítané (iba sebe, iba v konverzácii, ktorú smie čítať)
create or replace function mark_chat_read(p_chat uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_chat_member(p_chat) then raise exception 'Konverzácia nie je dostupná'; end if;
  insert into chat_members (chat_id, user_id, household_id, last_read_at)
  select id, auth.uid(), household_id, now() from chats where id = p_chat
  on conflict (chat_id, user_id) do update set last_read_at = now();
end $$;
revoke execute on function mark_chat_read(uuid) from public, anon;
grant execute on function mark_chat_read(uuid) to authenticated;

-- Zoznam mojich konverzácií s poslednou správou a počtom neprečítaných (beží s právami volajúceho → RLS)
create or replace function my_chats(p_household uuid)
returns table (id uuid, is_family boolean, member_ids uuid[], last_message_at timestamptz,
               last_body text, last_sender uuid, last_deleted boolean, unread int)
language sql stable security invoker set search_path = public as $$
  select c.id, c.is_family,
    coalesce((select array_agg(m.user_id order by m.user_id) from chat_members m where m.chat_id = c.id and not c.is_family), '{}'),
    c.last_message_at, lm.body, lm.sender_id, lm.deleted,
    (select count(*)::int from chat_messages x
      where x.chat_id = c.id and x.sender_id is distinct from auth.uid() and not x.deleted
        and x.created_at > coalesce((select r.last_read_at from chat_members r where r.chat_id = c.id and r.user_id = auth.uid()), '-infinity'))
  from chats c
  left join lateral (select body, sender_id, deleted from chat_messages x where x.chat_id = c.id order by created_at desc limit 1) lm on true
  where c.household_id = p_household
  order by c.last_message_at desc
$$;
revoke execute on function my_chats(uuid) from public, anon;
grant execute on function my_chats(uuid) to authenticated;

-- Naživo (Realtime rešpektuje RLS – správu dostanú iba účastníci)
alter publication supabase_realtime add table chat_messages;
