# Pokyny pre Claude – Rodina

- Komunikuj po slovensky, celé rozhranie aplikácie je po slovensky.
- Aplikácia je statická PWA bez zostavovania: `index.html`, `styles.css`, `app.js` (ES modul), `config.js`.
  Knižnica Supabase sa načítava z CDN (`cdn.jsdelivr.net`). Žiadny npm ani build krok.
- Pri každej zmene `app.js` / `styles.css` zvýš `APP_VERSION` v `config.js`.
- Cieľ: služba pre viac rodín (neskôr predplatné). Každá rodina je oddelená – stráži to RLS v databáze, nie obrazovka.

## Infraštruktúra

| Čo | Kde |
|---|---|
| Repozitár | GitHub `Mildo002/Rodina-Kunky`, vetva `main` |
| Hosting | Vercel – projekt prepojený s repozitárom (každý push do `main` sa nasadí) |
| Databáza | Supabase projekt `rodina`, ID `tiadykirohlgabalkxyn`, Frankfurt (eu-central-1) |

## Databáza

- Zmeny iba ako nový súbor `supabase/migrations/000N_popis.sql`, potom aplikovať cez Supabase konektor a skontrolovať `get_advisors`.
- Každá nová tabuľka: `household_id`, RLS cez `is_member()` / `is_admin()`.
- Zdravotné záznamy (`health_visits`) iba cez `can_see_health()`. Viditeľnosť mení výhradne `set_health_visibility()`
  (stráži trigger `guard_persons`). Tabuľka `health_viewers` sa nepoužíva.
- Predplatné (`households.plan`, `trial_until`) z aplikácie meniť nemožno (trigger `guard_households`).
- `0004_opravnenia.sql` zatiaľ nie je aplikovaná – vyžaduje potvrdenie majiteľa v Supabase.
- RLS sa testuje v DO bloku so `set local role authenticated` a `request.jwt.claims`, na konci `raise exception` (všetko sa vráti späť).

## Upozornenia a zámok

- Edge funkcia `supabase/functions/upozornenia` (verify_jwt vypnuté – vlastné overenie: cron tajomstvo / token používateľa).
  pg_cron ju volá každých 5 minút: pripomienky (`due_reminders`) a krátke známky (`due_vignettes`) v presnom čase,
  denné pravidlá iba o 7:00 Europe/Bratislava (duplicity stráži `notification_log`). Pravidlá a sviatky SR sú v funkcii.
- Kľúče web push (VAPID) a tajomstvo cronu sú v tabuľke `app_secrets` (RLS bez pravidiel – iba server). Verejný kľúč v `app_config`.
- Test funkcie z databázy cez `net.http_post` s hlavičkou `x-cron-secret` z `app_secrets`, `{"run":true,"dry":true,"date":"…"}`.
- Rýchle správy (`quick_messages`): trigger `notify_quick_message` volá funkciu cez pg_net hneď pri vložení / zmene stavu
  (`{"msg":id,"actor":uid}`), upozornenie dostanú všetci členovia okrem autora zmeny.
- Pripomienky: sekcia `#/pripomienky` – rýchly zápis (aj diktovanie), s dátumom ide do `reminders`, inak do `notes`
  (recept / poznámka / nápad, súkromné vidí iba autor).
- Konektor pre Claude: edge funkcia `rodina-mcp` (MCP cez HTTP, JSON-RPC, verify_jwt vypnuté). Kľúč v URL
  `/functions/v1/rodina-mcp/<kľúč>`, v `api_tokens` iba SHA-256 odtlačok. Nástroje: pridat_pripomienku, pridat_poznamku,
  pridat_na_nakup, poslat_rychlu_spravu, zoznam_terminov, hladat_poznamky, kurenie_stav, kurenie_nastav
  (zdravotné údaje cez konektor nejdú).
- Kúrenie / chladenie (Daikin Onecta): edge funkcia `daikin` (verify_jwt vypnuté; overenie tokenom používateľa
  alebo `x-cron-secret` pre rodina-mcp). Akcie `cached`, `status`, `set`, `start`, `disconnect`; návrat OAuth
  `/functions/v1/daikin/callback` → `#/kurenie?daikin=ok|chyba|…`. Tokeny a cache v `daikin_accounts` (iba server).
  Limit Onecta 200 dotazov/deň → cache 15 min, vynútené obnovenie najskôr po 3 min. Tajomstvá `DAIKIN_CLIENT_ID`,
  `DAIKIN_CLIENT_SECRET` v Supabase (Edge Functions → Secrets) zadáva majiteľ.
- Zámok aplikácie je iba na zariadení (localStorage): PBKDF2 odtlačok kódu + WebAuthn platform authenticator.
- Logo: `tools/logo_foto.py` (fotka `tools/kuny-foto.png` v srdci) generuje `logo.png`, `favicon.png`, `ikona-*.png`.

## Pracovný postup

1. Zadanie zopakuj vlastnými slovami; ak je nejasné, jedna otázka.
2. Väčšie zmeny na vetve `claude/<popis>` → náhľad na Verceli → po súhlase merge do `main`.
3. Commity s popisom po slovensky. Na konci: čo pribudlo, ako to vyskúšať, čo musí urobiť majiteľ.
