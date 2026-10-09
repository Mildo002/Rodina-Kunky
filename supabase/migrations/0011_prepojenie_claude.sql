-- Rodina – prístupové kľúče pre konektor Claude (MCP). Ukladá sa iba odtlačok (SHA-256) kľúča.
create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  household_id uuid not null references households on delete cascade,
  name text not null default 'Claude',
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table api_tokens enable row level security;
create policy api_tokens_own on api_tokens for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and is_member(household_id));
