-- Rodina – databázová schéma (fáza 1)
-- Viac rodín (skupín) v jednej databáze; každá rodina vidí iba svoje dáta (RLS v 0002).

create extension if not exists pgcrypto;

create type member_role       as enum ('spravca','clen');
create type health_visibility as enum ('ja','spravcovia','vsetci','vybrani');
create type policy_kind       as enum ('auto','osoba','zivotne','majetok','ine');
create type pay_frequency     as enum ('mesacne','stvrtrocne','polrocne','rocne','jednorazovo');

-- Rodina (skupina). plan/trial_until sú pripravené na budúce predplatné.
create table households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  plan text not null default 'skusobny',
  trial_until date not null default (current_date + 60),
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

-- Profil používateľa
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text not null default '',
  email text,
  created_at timestamptz not null default now()
);

-- Členstvo používateľa v rodine
create table members (
  household_id uuid not null references households on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role member_role not null default 'clen',
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index on members (user_id);

-- Pozvánky (odkaz s tokenom)
create table invitations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  token text not null unique default encode(gen_random_bytes(16), 'hex'),
  note text,                                  -- komu je určená (napr. „Mama“)
  role member_role not null default 'clen',
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_by uuid references auth.users on delete set null,
  accepted_at timestamptz
);

-- Osoby v rodine – aj deti či starí rodičia bez vlastného účtu
create table persons (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  name text not null check (length(trim(name)) > 0),
  birth_date date,
  user_id uuid references auth.users on delete set null,
  health_visibility health_visibility not null default 'ja',
  note text,
  created_at timestamptz not null default now(),
  unique (household_id, user_id)
);
create index on persons (household_id);

-- Kto smie vidieť zdravotné záznamy osoby (pri voľbe „vybraní“)
create table health_viewers (
  person_id uuid not null references persons on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  primary key (person_id, user_id)
);

-- Zariadenia v domácnosti
create table devices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  name text not null check (length(trim(name)) > 0),
  category text,
  manufacturer text,
  model text,
  serial_number text,
  location text,
  purchased_on date,
  warranty_until date,
  next_service_on date,
  note text,
  created_at timestamptz not null default now()
);
create index on devices (household_id);

-- Autá
create table vehicles (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  name text not null check (length(trim(name)) > 0),
  plate text,
  vin text,
  make text,
  model text,
  year_made int,
  stk_until date,
  ek_until date,
  vignette_until date,
  next_service_on date,
  note text,
  created_at timestamptz not null default now()
);
create index on vehicles (household_id);

-- Poistenia (auto, osoba, životné, majetok, iné)
create table insurances (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  kind policy_kind not null,
  name text not null check (length(trim(name)) > 0),
  insurer text,
  policy_no text,
  person_id uuid references persons on delete set null,
  vehicle_id uuid references vehicles on delete set null,
  premium numeric(10,2),
  frequency pay_frequency,
  next_payment_on date,
  valid_from date,
  valid_until date,
  note text,
  created_at timestamptz not null default now()
);
create index on insurances (household_id);

-- Pripomienky (kalendár)
create table reminders (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  title text not null check (length(trim(title)) > 0),
  due_on date not null,
  due_time time,
  repeat_months int check (repeat_months is null or repeat_months > 0),
  person_id uuid references persons on delete set null,
  note text,
  done boolean not null default false,
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on reminders (household_id, due_on);

-- Návštevy lekára a prehliadky
create table health_visits (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  person_id uuid not null references persons on delete cascade,
  title text not null check (length(trim(title)) > 0),
  doctor text,
  place text,
  visit_on date not null,
  visit_time time,
  repeat_months int check (repeat_months is null or repeat_months > 0),
  note text,
  done boolean not null default false,
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on health_visits (person_id, visit_on);

-- Spoločný nákupný zoznam
create table shopping_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  text text not null check (length(trim(text)) > 0),
  quantity text,
  checked boolean not null default false,
  added_by uuid references auth.users on delete set null default auth.uid(),
  checked_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  checked_at timestamptz
);
create index on shopping_items (household_id);

-- Nový používateľ dostane profil
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name, email)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'full_name',''), split_part(new.email,'@',1)), new.email);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();
