-- Rodina – okamžité upozornenia všetkým členom: nákupný zoznam, nové pripomienky a poznámky (+ rýchle správy)
-- a ochrana autora záznamu (added_by / created_by nemožno podvrhnúť).

-- ===== Autor záznamu = prihlásený používateľ (z aplikácie). Konektor Claude (service role) autora nastavuje sám. =====
create or replace function force_author() returns trigger
language plpgsql set search_path = public as $$
declare col text := tg_argv[0];
begin
  if auth.uid() is not null then
    new := jsonb_populate_record(new, jsonb_build_object(col, auth.uid()));
  end if;
  return new;
end $$;
create trigger shopping_items_author before insert on shopping_items for each row execute function force_author('added_by');
create trigger reminders_author before insert on reminders for each row execute function force_author('created_by');
create trigger quick_messages_author before insert on quick_messages for each row execute function force_author('created_by');

-- ===== Spoločné volanie serverovej funkcie upozornení =====
create or replace function call_upozornenia(p_body jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://tiadykirohlgabalkxyn.supabase.co/functions/v1/upozornenia',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select value from app_secrets where key = 'cron')),
    body := p_body,
    timeout_milliseconds := 15000);
end $$;
revoke all on function call_upozornenia(jsonb) from public, anon, authenticated;

-- Nákup: jedno upozornenie na celé vloženie (aj keď Claude pridá viac položiek naraz)
create or replace function notify_shopping() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select household_id, coalesce(auth.uid(), min(added_by::text)::uuid) actor, array_agg(id) ids
           from new_rows group by household_id loop
    perform call_upozornenia(jsonb_build_object('event', 'nakup', 'household', r.household_id, 'ids', to_jsonb(r.ids), 'actor', r.actor));
  end loop;
  return null;
end $$;
create trigger shopping_items_notify after insert on shopping_items
  referencing new table as new_rows for each statement execute function notify_shopping();

-- Nová pripomienka
create or replace function notify_reminder() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform call_upozornenia(jsonb_build_object('event', 'pripomienka', 'id', new.id, 'actor', coalesce(auth.uid(), new.created_by)));
  return new;
end $$;
create trigger reminders_notify after insert on reminders for each row execute function notify_reminder();

-- Nová poznámka / recept / nápad (súkromné nie)
create or replace function notify_note() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.private then return new; end if;
  perform call_upozornenia(jsonb_build_object('event', 'poznamka', 'id', new.id, 'actor', coalesce(auth.uid(), new.created_by)));
  return new;
end $$;
create trigger notes_notify after insert on notes for each row execute function notify_note();

-- Rýchla správa: pri vložení cez Claude (bez prihlásenia) je autorom created_by – nedostane vlastnú správu
create or replace function notify_quick_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  perform call_upozornenia(jsonb_build_object('msg', new.id, 'status', new.status,
    'actor', coalesce(auth.uid(), case when tg_op = 'INSERT' then new.created_by end)));
  return new;
end $$;

revoke all on function notify_shopping() from public, anon, authenticated;
revoke all on function notify_reminder() from public, anon, authenticated;
revoke all on function notify_note() from public, anon, authenticated;
revoke all on function notify_quick_message() from public, anon, authenticated;

-- ===== AI čítanie dokladov: počítadlo použitia (limit na používateľa a deň) – iba server =====
create table ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  household_id uuid not null references households on delete cascade,
  kind text not null,
  created_at timestamptz not null default now()
);
create index on ai_usage (user_id, created_at desc);
create index on ai_usage (household_id);
alter table ai_usage enable row level security;
