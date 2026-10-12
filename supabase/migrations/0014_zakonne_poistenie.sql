-- Rodina – zákonné poistenie (PZP): upozornenie 9 týždňov pred výročím / koncom zmluvy (čas na porovnanie a výpoveď 6 týždňov vopred)
alter table insurances add column statutory boolean not null default false;

-- existujúce PZP
update insurances set statutory = true where name ~* '\mPZP\M' or note ~* 'povinn[ée] zmluvn[ée]';

-- nové poistenie s „PZP“ v názve sa označí samo (dá sa potom vypnúť)
create or replace function insurances_statutory_default() returns trigger
language plpgsql set search_path = public as $$
begin
  if not new.statutory and (new.name ~* '\mPZP\M' or coalesce(new.note, '') ~* 'povinn[ée] zmluvn[ée]') then
    new.statutory := true;
  end if;
  return new;
end $$;
create trigger insurances_statutory before insert on insurances for each row execute function insurances_statutory_default();
revoke all on function insurances_statutory_default() from public, anon, authenticated;
