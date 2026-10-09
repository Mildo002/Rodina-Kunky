-- Rodina – prístupové práva (RLS), pomocné funkcie a akcie (RPC)
-- Pravidlo: každý vidí iba rodiny, v ktorých je členom. Zdravotné záznamy podľa nastavenia osoby.

-- ===== Pomocné funkcie =====
create or replace function is_member(h uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where household_id = h and user_id = auth.uid())
$$;

create or replace function is_admin(h uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where household_id = h and user_id = auth.uid() and role = 'spravca')
$$;

create or replace function shares_household(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members a join members b on a.household_id = b.household_id
    where a.user_id = auth.uid() and b.user_id = u)
$$;

-- Smie prihlásený vidieť zdravotné záznamy osoby?
create or replace function can_see_health(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from persons x
    where x.id = p and is_member(x.household_id) and (
         x.user_id = auth.uid()                                         -- vlastné
      or (x.user_id is null and is_admin(x.household_id))               -- osoba bez účtu (napr. dieťa) – správca
      or (x.health_visibility = 'spravcovia' and is_admin(x.household_id))
      or  x.health_visibility = 'vsetci'
      or (x.health_visibility = 'vybrani' and exists (
            select 1 from health_viewers v where v.person_id = x.id and v.user_id = auth.uid()))
    ))
$$;

-- Patrí osoba / auto do tej istej rodiny?
create or replace function person_in(p uuid, h uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p is null or exists (select 1 from persons where id = p and household_id = h)
$$;
create or replace function vehicle_in(v uuid, h uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select v is null or exists (select 1 from vehicles where id = v and household_id = h)
$$;

-- ===== RLS =====
alter table households     enable row level security;
alter table profiles       enable row level security;
alter table members        enable row level security;
alter table invitations    enable row level security;
alter table persons        enable row level security;
alter table health_viewers enable row level security;
alter table devices        enable row level security;
alter table vehicles       enable row level security;
alter table insurances     enable row level security;
alter table reminders      enable row level security;
alter table health_visits  enable row level security;
alter table shopping_items enable row level security;

-- Rodina: zakladá sa cez create_household(); meniť názov smie správca
create policy households_read   on households for select using (is_member(id));
create policy households_update on households for update using (is_admin(id)) with check (is_admin(id));

-- Profily: svoj a profily ľudí z mojich rodín
create policy profiles_read   on profiles for select using (id = auth.uid() or shares_household(id));
create policy profiles_update on profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- Členovia: vidí každý člen; meniť roly a odoberať smie správca, odísť môže každý sám
create policy members_read   on members for select using (is_member(household_id));
create policy members_update on members for update using (is_admin(household_id)) with check (is_admin(household_id));
create policy members_delete on members for delete using (is_admin(household_id) or user_id = auth.uid());

-- Pozvánky: iba správca
create policy invitations_admin on invitations for all
  using (is_admin(household_id)) with check (is_admin(household_id));

-- Osoby: vidia všetci členovia, pridáva/upravuje/maže správca.
-- Viditeľnosť zdravotných záznamov sa mení iba cez set_health_visibility() (0003).
create policy persons_read   on persons for select using (is_member(household_id));
create policy persons_insert on persons for insert with check (is_admin(household_id) and user_id is null);
create policy persons_update on persons for update using (is_admin(household_id)) with check (is_admin(household_id));
create policy persons_delete on persons for delete using (is_admin(household_id) and user_id is null);

-- Kto vidí zdravie: čítať smie ten, kto vidí záznamy osoby; meniť iba cez funkciu
create policy health_viewers_read on health_viewers for select using (can_see_health(person_id));

-- Spoločné údaje rodiny: všetci členovia čítajú aj upravujú
create policy devices_all on devices for all
  using (is_member(household_id)) with check (is_member(household_id));
create policy vehicles_all on vehicles for all
  using (is_member(household_id)) with check (is_member(household_id));
create policy insurances_all on insurances for all
  using (is_member(household_id))
  with check (is_member(household_id) and person_in(person_id, household_id) and vehicle_in(vehicle_id, household_id));
create policy reminders_all on reminders for all
  using (is_member(household_id))
  with check (is_member(household_id) and person_in(person_id, household_id));
create policy shopping_all on shopping_items for all
  using (is_member(household_id)) with check (is_member(household_id));

-- Zdravie: iba kto smie vidieť záznamy danej osoby
create policy health_visits_all on health_visits for all
  using (can_see_health(person_id))
  with check (can_see_health(person_id) and person_in(person_id, household_id));

-- ===== Akcie (RPC) =====

-- Založenie rodiny: zakladateľ je správca a má svoju osobu
create or replace function create_household(p_name text, p_my_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare h uuid;
begin
  if auth.uid() is null then raise exception 'Nie ste prihlásený'; end if;
  insert into households (name, created_by) values (trim(p_name), auth.uid()) returning id into h;
  insert into members (household_id, user_id, role) values (h, auth.uid(), 'spravca');
  insert into persons (household_id, name, user_id)
    values (h, coalesce(nullif(trim(p_my_name), ''), (select full_name from profiles where id = auth.uid()), 'Ja'), auth.uid());
  return h;
end $$;

-- Údaje o pozvánke pred prihlásením (názov rodiny, platnosť)
create or replace function invitation_info(p_token text)
returns table (household_name text, valid boolean)
language sql stable security definer set search_path = public as $$
  select h.name, (i.accepted_at is null and i.expires_at > now())
  from invitations i join households h on h.id = i.household_id
  where i.token = p_token
$$;

-- Prijatie pozvánky
create or replace function accept_invitation(p_token text, p_my_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare inv invitations%rowtype;
begin
  if auth.uid() is null then raise exception 'Nie ste prihlásený'; end if;
  select * into inv from invitations where token = p_token for update;
  if not found then raise exception 'Pozvánka neexistuje'; end if;
  if exists (select 1 from members where household_id = inv.household_id and user_id = auth.uid()) then
    return inv.household_id;                     -- už je členom
  end if;
  if inv.accepted_at is not null then raise exception 'Pozvánka už bola použitá'; end if;
  if inv.expires_at <= now() then raise exception 'Platnosť pozvánky vypršala'; end if;

  insert into members (household_id, user_id, role) values (inv.household_id, auth.uid(), inv.role);
  insert into persons (household_id, name, user_id)
    values (inv.household_id,
            coalesce(nullif(trim(p_my_name), ''), (select full_name from profiles where id = auth.uid()), 'Člen'),
            auth.uid())
    on conflict (household_id, user_id) do nothing;
  update invitations set accepted_by = auth.uid(), accepted_at = now() where id = inv.id;
  return inv.household_id;
end $$;

-- ===== Zmeny v reálnom čase =====
alter publication supabase_realtime add table shopping_items, reminders;
