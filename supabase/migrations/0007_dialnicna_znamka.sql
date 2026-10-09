-- Rodina – druh diaľničnej známky a presný čas konca platnosti
-- Upozornenie: ročná 7 dní vopred (denné pravidlo o 7:00), kratšia ako rok 24 hodín pred koncom,
-- 24-hodinová v momente konca platnosti.

alter table vehicles add column vignette_kind text check (vignette_kind in ('rocna','30dni','10dni','1den'));
alter table vehicles add column vignette_until_time time;

-- Známky, ktorých čas upozornenia padne do okna (p_from, p_to]. Bez času sa koniec berie 23:59.
create or replace function due_vignettes(p_from timestamptz, p_to timestamptz)
returns table (id uuid, household_id uuid, name text, plate text, vignette_kind text, vignette_until date,
               vignette_until_time time, expires_at timestamptz, notify_at timestamptz)
language sql stable set search_path = public as $$
  select * from (
    select v.id, v.household_id, v.name, v.plate, v.vignette_kind, v.vignette_until, v.vignette_until_time,
           e.expires_at,
           case when v.vignette_kind = '1den' then e.expires_at else e.expires_at - interval '24 hours' end as notify_at
    from vehicles v
    cross join lateral (select ((v.vignette_until + coalesce(v.vignette_until_time, time '23:59')) at time zone 'Europe/Bratislava') as expires_at) e
    where v.vignette_until is not null and v.vignette_kind in ('30dni','10dni','1den')
      and v.vignette_until between (p_from at time zone 'Europe/Bratislava')::date - 2 and (p_to at time zone 'Europe/Bratislava')::date + 2
  ) x
  where x.notify_at > p_from and x.notify_at <= p_to
$$;
