-- Rodina – stráženie zmien triggermi a viditeľnosť zdravia
-- Tabuľka health_viewers z 0001 sa nepoužíva; vybraní sú v persons.health_viewer_ids.

alter table persons add column health_viewer_ids uuid[] not null default '{}';

create or replace function can_see_health(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from persons x
    where x.id = p and is_member(x.household_id) and (
         x.user_id = auth.uid()
      or (x.user_id is null and is_admin(x.household_id))
      or (x.health_visibility = 'spravcovia' and is_admin(x.household_id))
      or  x.health_visibility = 'vsetci'
      or (x.health_visibility = 'vybrani' and auth.uid() = any(x.health_viewer_ids))
    ))
$$;

-- Svoju osobu nastavuje každý sám; osobu bez účtu (dieťa) nastavuje správca.
create or replace function set_health_visibility(p_person uuid, p_visibility health_visibility, p_viewers uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare x persons%rowtype;
begin
  select * into x from persons where id = p_person;
  if not found then raise exception 'Osoba neexistuje'; end if;
  if not (x.user_id = auth.uid() or (x.user_id is null and is_admin(x.household_id))) then
    raise exception 'Toto nastavenie môže zmeniť iba daná osoba';
  end if;
  perform set_config('rodina.health_change', 'ano', true);
  update persons set
    health_visibility = p_visibility,
    health_viewer_ids = case when p_visibility = 'vybrani' then coalesce((
      select array_agg(m.user_id) from members m
      where m.household_id = x.household_id and m.user_id = any(coalesce(p_viewers, '{}'))
        and m.user_id is distinct from x.user_id), '{}') else '{}' end
  where id = p_person;
  perform set_config('rodina.health_change', '', true);
end $$;

-- Osoba: účet a viditeľnosť zdravia nemožno meniť mimo funkcií
create or replace function guard_persons() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.household_id is distinct from old.household_id or new.user_id is distinct from old.user_id then
    raise exception 'Osobu nemožno presunúť ani priradiť k inému účtu';
  end if;
  if (new.health_visibility is distinct from old.health_visibility or new.health_viewer_ids is distinct from old.health_viewer_ids)
     and coalesce(current_setting('rodina.health_change', true), '') <> 'ano' then
    raise exception 'Viditeľnosť zdravotných záznamov mení iba daná osoba';
  end if;
  return new;
end $$;
create trigger persons_guard before update on persons for each row execute function guard_persons();

create or replace function guard_persons_insert() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null and coalesce(current_setting('rodina.health_change', true), '') <> 'ano'
     and (new.health_viewer_ids <> '{}' or new.health_visibility not in ('ja','spravcovia')) then
    new.health_viewer_ids := '{}'; new.health_visibility := 'ja';
  end if;
  return new;
end $$;
create trigger persons_guard_insert before insert on persons for each row execute function guard_persons_insert();

-- Členstvo: iba zmena roly
create or replace function guard_members() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.household_id is distinct from old.household_id or new.user_id is distinct from old.user_id then
    raise exception 'Členstvo nemožno presunúť';
  end if;
  return new;
end $$;
create trigger members_guard before update on members for each row execute function guard_members();

-- Predplatné a skúšobné obdobie mení iba prevádzkovateľ
create or replace function guard_households() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null and (new.plan is distinct from old.plan or new.trial_until is distinct from old.trial_until
     or new.created_by is distinct from old.created_by) then
    raise exception 'Predplatné nemožno meniť z aplikácie';
  end if;
  return new;
end $$;
create trigger households_guard before update on households for each row execute function guard_households();

-- Pozvánku nemožno prepísať, iba vytvoriť alebo zrušiť (prijatie ide cez accept_invitation)
create or replace function guard_invitations() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null and current_user = 'authenticated' then
    raise exception 'Pozvánku nemožno upravovať, iba zrušiť a vytvoriť novú';
  end if;
  return new;
end $$;
create trigger invitations_guard before update on invitations for each row execute function guard_invitations();

-- Profil: meniť možno iba meno
create or replace function guard_profiles() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.id is distinct from old.id or (new.email is distinct from old.email and current_user = 'authenticated') then
    raise exception 'Meniť možno iba meno';
  end if;
  return new;
end $$;
create trigger profiles_guard before update on profiles for each row execute function guard_profiles();
