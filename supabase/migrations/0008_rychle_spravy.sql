-- Rodina – rýchle správy (pomoc, odvoz, škola…) s okamžitým upozornením všetkých členov

create table quick_messages (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  kind text not null default 'ine' check (kind in ('pomoc','odvoz','do_skoly','zo_skoly','nakup','ine')),
  text text,
  when_at timestamptz,
  place text,
  status text not null default 'otvorena' check (status in ('otvorena','prevzata','vybavena','zrusena')),
  created_by uuid references auth.users on delete set null default auth.uid(),
  handled_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on quick_messages (household_id, created_at desc);
alter table quick_messages enable row level security;
create policy quick_messages_all on quick_messages for all
  using (is_member(household_id)) with check (is_member(household_id));

-- Autora a rodinu nemožno meniť; čas poslednej zmeny sa nastaví sám
create or replace function guard_quick_messages() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.household_id is distinct from old.household_id or new.created_by is distinct from old.created_by then
    raise exception 'Správu nemožno presunúť';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger quick_messages_guard before update on quick_messages for each row execute function guard_quick_messages();

-- Nová správa alebo zmena stavu → serverová funkcia hneď pošle upozornenie ostatným členom
create or replace function notify_quick_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  perform net.http_post(
    url := 'https://tiadykirohlgabalkxyn.supabase.co/functions/v1/upozornenia',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select value from app_secrets where key = 'cron')),
    body := jsonb_build_object('msg', new.id, 'status', new.status, 'actor', auth.uid()),
    timeout_milliseconds := 15000);
  return new;
end $$;
create trigger quick_messages_notify after insert or update on quick_messages
  for each row execute function notify_quick_message();

alter publication supabase_realtime add table quick_messages;
