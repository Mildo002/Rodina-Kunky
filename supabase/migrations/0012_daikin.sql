-- 0012: Daikin Onecta – prepojenie tepelného čerpadla a klimatizácie (kúrenie / chladenie)
-- Tokeny a vyrovnávacia pamäť stavu: iba server (RLS bez pravidiel), aplikácia ide cez edge funkciu „daikin“.
create table daikin_accounts (
  household_id uuid primary key references households on delete cascade,
  connected_by uuid references auth.users on delete set null,
  refresh_token text,
  access_token text,
  expires_at timestamptz,
  devices_cache jsonb,
  cache_at timestamptz,
  rate_remaining_day int,
  blocked_until timestamptz,
  created_at timestamptz not null default now()
);
alter table daikin_accounts enable row level security;

-- Dočasné stavy OAuth prihlásenia (ochrana pred podvrhnutím návratu)
create table daikin_oauth_states (
  state text primary key,
  household_id uuid not null references households on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now()
);
alter table daikin_oauth_states enable row level security;
