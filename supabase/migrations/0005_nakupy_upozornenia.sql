-- Rodina – nákupy so zárukou, prílohy (bločky, faktúry), upozornenia (web push)

-- ===== Nákupy so zárukou =====
create table purchases (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  name text not null check (length(trim(name)) > 0),
  store text,
  price numeric(10,2),
  purchased_on date not null,
  warranty_months int not null default 24 check (warranty_months > 0 and warranty_months <= 600),
  warranty_until date generated always as ((purchased_on + make_interval(months => warranty_months))::date) stored,
  serial_number text,
  person_id uuid references persons on delete set null,
  note text,
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on purchases (household_id, warranty_until);
alter table purchases enable row level security;
create policy purchases_all on purchases for all
  using (is_member(household_id))
  with check (is_member(household_id) and person_in(person_id, household_id));

-- Prílohy (fotka / sken bločka, faktúry, záručného listu). Súbor je v úložisku „prilohy“
-- na ceste {household_id}/nakupy/{purchase_id}/{súbor}
create table attachments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  purchase_id uuid references purchases on delete cascade,
  path text not null unique,
  file_name text,
  mime text,
  size_bytes int,
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  check (split_part(path, '/', 1) = household_id::text)
);
create index on attachments (purchase_id);
alter table attachments enable row level security;
create policy attachments_all on attachments for all
  using (is_member(household_id)) with check (is_member(household_id));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('prilohy', 'prilohy', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'])
on conflict (id) do nothing;

create or replace function storage_household(p text) returns uuid
language plpgsql immutable set search_path = public as $$
begin
  return split_part(p, '/', 1)::uuid;
exception when others then return null;
end $$;

create policy prilohy_read on storage.objects for select
  using (bucket_id = 'prilohy' and is_member(storage_household(name)));
create policy prilohy_insert on storage.objects for insert
  with check (bucket_id = 'prilohy' and is_member(storage_household(name)));
create policy prilohy_delete on storage.objects for delete
  using (bucket_id = 'prilohy' and is_member(storage_household(name)));

-- ===== Upozornenia =====
-- Odbery web push (jedno zariadenie / prehliadač = jeden riadok)
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device text,
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;
create policy push_own on push_subscriptions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Čo už bolo odoslané (aby nič neprišlo dvakrát) – iba server
create table notification_log (
  user_id uuid not null references auth.users on delete cascade,
  key text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table notification_log enable row level security;

-- Tajné hodnoty servera – bez pravidiel RLS, číta ich iba serverová funkcia (service role) a cron
create table app_secrets (key text primary key, value text not null);
alter table app_secrets enable row level security;
insert into app_secrets (key, value) values ('cron', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

-- Verejné nastavenia (verejný kľúč pre web push)
create table app_config (key text primary key, value text not null);
alter table app_config enable row level security;
create policy app_config_read on app_config for select using (true);

-- Pravidelné spúšťanie: každú hodinu, funkcia sama pracuje iba o 7:00 slovenského času
create extension if not exists pg_net;
create extension if not exists pg_cron;
select cron.schedule('rodina-upozornenia', '0 * * * *', $cron$
  select net.http_post(
    url := 'https://tiadykirohlgabalkxyn.supabase.co/functions/v1/upozornenia',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select value from public.app_secrets where key = 'cron')),
    body := '{"run": true}'::jsonb,
    timeout_milliseconds := 60000)
$cron$);
