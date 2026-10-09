-- Rodina – číslo na ikone aplikácie (neprečítané upozornenia od posledného otvorenia)
alter table profiles add column last_seen_at timestamptz not null default now();

-- Aplikácia volá pri otvorení: nastaví „videné teraz“ (iba sebe)
create or replace function mark_seen() returns void
language sql security definer set search_path = public as $$
  update profiles set last_seen_at = now() where id = auth.uid()
$$;
