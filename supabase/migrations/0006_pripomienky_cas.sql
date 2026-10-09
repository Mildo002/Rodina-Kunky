-- Rodina – pripomienky s presným časom upozornenia („2 hodiny vopred“)

alter table reminders add column remind_before_minutes int not null default 0
  check (remind_before_minutes >= 0 and remind_before_minutes <= 60 * 24 * 31);

-- Pripomienky, ktorých čas upozornenia padne do okna (p_from, p_to].
-- Bez zadaného času sa ráta od 7:00 v deň termínu. Čas je slovenský (Europe/Bratislava).
create or replace function due_reminders(p_from timestamptz, p_to timestamptz)
returns table (id uuid, household_id uuid, title text, due_on date, due_time time, person_id uuid, note text,
               remind_before_minutes int, notify_at timestamptz)
language sql stable set search_path = public as $$
  select * from (
    select r.id, r.household_id, r.title, r.due_on, r.due_time, r.person_id, r.note, r.remind_before_minutes,
           ((r.due_on + coalesce(r.due_time, time '07:00')) at time zone 'Europe/Bratislava')
             - make_interval(mins => r.remind_before_minutes) as notify_at
    from reminders r
    where not r.done and r.due_on between (p_from at time zone 'Europe/Bratislava')::date - 1
                                      and (p_to at time zone 'Europe/Bratislava')::date + 32
  ) x
  where x.notify_at > p_from and x.notify_at <= p_to
$$;

-- Kontrola každých 5 minút (denné pravidlá funkcia aj tak posiela iba o 7:00)
select cron.schedule('rodina-upozornenia', '*/5 * * * *', $cron$
  select net.http_post(
    url := 'https://tiadykirohlgabalkxyn.supabase.co/functions/v1/upozornenia',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select value from public.app_secrets where key = 'cron')),
    body := '{"run": true}'::jsonb,
    timeout_milliseconds := 60000)
$cron$);
