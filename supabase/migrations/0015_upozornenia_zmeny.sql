-- Rodina – upozornenia aj pri ZMENÁCH (nielen pri pridaní):
--   nákupný zoznam (upravená položka, nakúpené), kalendár / pripomienky (zmena, splnené),
--   rýchle správy (úprava textu, času, miesta), zdravie (nová návšteva lekára aj jej zmena).
-- Upozornenie dostanú všetci členovia okrem autora zmeny; zdravie iba tí, ktorí smú vidieť zdravotné záznamy osoby.
-- Úpravy autora do 2 minút po vytvorení sa neohlasujú (napr. doplnenie poznámky hneď po uložení).

-- ===== Zdravie: autor = prihlásený používateľ =====
create trigger health_visits_author before insert on health_visits
  for each row execute function force_author('created_by');

-- ===== Nákupný zoznam: zmena položiek (jedno volanie na celý príkaz) =====
create or replace function notify_shopping_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in
    select n.household_id,
           coalesce(auth.uid(), min(n.checked_by::text) filter (where n.checked and not o.checked)::uuid) actor,
           coalesce(array_agg(n.id) filter (where n.checked and not o.checked), '{}') bought,
           coalesce(array_agg(n.id) filter (where not n.checked and (n.text is distinct from o.text or n.quantity is distinct from o.quantity)), '{}') edited
    from new_rows n join old_rows o on o.id = n.id
    group by n.household_id
  loop
    if cardinality(r.bought) > 0 or cardinality(r.edited) > 0 then
      perform call_upozornenia(jsonb_build_object('event', 'nakup-zmena', 'household', r.household_id,
        'bought', to_jsonb(r.bought), 'edited', to_jsonb(r.edited), 'actor', r.actor));
    end if;
  end loop;
  return null;
end $$;
create trigger shopping_items_notify_change after update on shopping_items
  referencing old table as old_rows new table as new_rows
  for each statement execute function notify_shopping_change();

-- ===== Kalendár / pripomienky: nová aj zmenená =====
create or replace function notify_reminder() returns trigger
language plpgsql security definer set search_path = public as $$
declare actor uuid := coalesce(auth.uid(), new.created_by); is_done boolean := false; is_moved boolean := false;
begin
  if tg_op = 'UPDATE' then
    is_done := new.done and not old.done;
    is_moved := (new.due_on, new.due_time) is distinct from (old.due_on, old.due_time);
    if (new.title, new.due_on, new.due_time, new.person_id, new.note, new.done)
       is not distinct from (old.title, old.due_on, old.due_time, old.person_id, old.note, old.done) then return new; end if;
    if actor = new.created_by and new.created_at > now() - interval '2 minutes' then return new; end if;
  end if;
  perform call_upozornenia(jsonb_build_object('event', 'pripomienka', 'id', new.id, 'actor', actor,
    'op', lower(tg_op), 'done', is_done, 'moved', is_moved));
  return new;
end $$;
drop trigger if exists reminders_notify on reminders;
create trigger reminders_notify after insert or update on reminders for each row execute function notify_reminder();

-- ===== Zdravie: nová návšteva lekára aj zmena =====
create or replace function notify_health() returns trigger
language plpgsql security definer set search_path = public as $$
declare actor uuid := coalesce(auth.uid(), new.created_by); is_done boolean := false; is_moved boolean := false;
begin
  if tg_op = 'UPDATE' then
    is_done := new.done and not old.done;
    is_moved := (new.visit_on, new.visit_time) is distinct from (old.visit_on, old.visit_time);
    if (new.title, new.doctor, new.place, new.visit_on, new.visit_time, new.person_id, new.note, new.done)
       is not distinct from (old.title, old.doctor, old.place, old.visit_on, old.visit_time, old.person_id, old.note, old.done) then return new; end if;
    if actor = new.created_by and new.created_at > now() - interval '2 minutes' then return new; end if;
  end if;
  perform call_upozornenia(jsonb_build_object('event', 'zdravie', 'id', new.id, 'actor', actor,
    'op', lower(tg_op), 'done', is_done, 'moved', is_moved));
  return new;
end $$;
create trigger health_visits_notify after insert or update on health_visits for each row execute function notify_health();

-- ===== Rýchle správy: aj úprava textu, času alebo miesta =====
create or replace function notify_quick_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare edited boolean := false;
begin
  if tg_op = 'UPDATE' then
    if new.status is distinct from old.status then edited := false;  -- zmena stavu má vlastný text
    elsif (new.kind, new.text, new.when_at, new.place) is distinct from (old.kind, old.text, old.when_at, old.place) then edited := true;
    else return new; end if;
  end if;
  perform call_upozornenia(jsonb_build_object('msg', new.id, 'status', new.status,
    'edited', edited,
    'actor', coalesce(auth.uid(), case when tg_op = 'INSERT' then new.created_by end)));
  return new;
end $$;

revoke all on function notify_shopping_change() from public, anon, authenticated;
revoke all on function notify_reminder() from public, anon, authenticated;
revoke all on function notify_health() from public, anon, authenticated;
revoke all on function notify_quick_message() from public, anon, authenticated;

-- Počítadlo na ikone: rýchle hľadanie neprečítaných
create index if not exists notification_log_user_sent on notification_log (user_id, sent_at desc);
