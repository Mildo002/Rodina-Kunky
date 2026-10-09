-- Rodina – poznámky v sekcii „Pripomienky“ (recepty, nápady, poznámky); s časom sa ukladajú ako pripomienky (reminders)
create table notes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  title text not null check (length(trim(title)) > 0),
  body text,
  category text not null default 'poznamka' check (category in ('poznamka','recept','napad','ine')),
  pinned boolean not null default false,
  private boolean not null default false,
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on notes (household_id, created_at desc);
alter table notes enable row level security;
-- súkromnú poznámku vidí iba autor, ostatné celá rodina
create policy notes_read on notes for select
  using (is_member(household_id) and (not private or created_by = auth.uid()));
create policy notes_insert on notes for insert
  with check (is_member(household_id) and created_by = auth.uid());
create policy notes_update on notes for update
  using (is_member(household_id) and (not private or created_by = auth.uid()))
  with check (is_member(household_id) and (not private or created_by = auth.uid()));
create policy notes_delete on notes for delete
  using (is_member(household_id) and (not private or created_by = auth.uid()));

create or replace function guard_notes() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.household_id is distinct from old.household_id or new.created_by is distinct from old.created_by then
    raise exception 'Poznámku nemožno presunúť';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger notes_guard before update on notes for each row execute function guard_notes();
