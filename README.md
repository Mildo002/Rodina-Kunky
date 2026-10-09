# Rodina

Spoločný prehľad celej domácnosti pre všetkých členov rodiny – na mobile aj počítači.

## Čo aplikácia vie (fáza 1)

- **Rodina a pozvánky** – založíte rodinu, členov pozvete odkazom (WhatsApp, SMS…). Roly správca / člen.
  Deti či starí rodičia môžu byť v rodine aj bez vlastného účtu.
- **Prehľad** – všetko, čo vás čaká v najbližších 30 dňoch, a čo je po termíne.
- **Kalendár** – pripomienky, návštevy lekára, STK a EK, diaľničné známky, platby a koniec poistení, záruky a servisy zariadení.
- **Rýchle správy** – „Potrebujem pomoc“, „Odvoz / taxi“, „Do školy“, „Zo školy“, „Nakúpiť“ alebo vlastná správa,
  s časom a miestom. Ostatní kliknú „Vybavím to“ / „Vybavené“; každá nová správa aj zmena stavu príde
  hneď ako upozornenie všetkým ostatným členom.
- **Pripomienky** – rýchly zápis pripomienok, poznámok, receptov a nápadov, aj hlasom (diktovanie).
- **Prepojenie s Claude** – po pridaní konektora stačí Claudovi povedať „pripomeň mi…“ alebo „ulož recept…“
  a zapíše to do Rodiny (Rodina → Prepojenie s Claude).
- **Kúrenie / chladenie** – tepelné čerpadlo, klimatizácia a ohrev vody Daikin (cez Daikin Onecta):
  teploty doma aj vonku, zapnúť / vypnúť, režim, nastavená teplota, rýchly ohrev. Ovládať sa dá aj hlasom
  cez Claude („nastav kúrenie na 22 stupňov“).
- **Nákupný zoznam** – spoločný, mení sa u všetkých naživo.
- **Domácnosť** – zariadenia (záruka, servis), autá (STK, EK, známka, servis), poistenia
  (auto, osoby, životné, majetok) s ročným súčtom poistného.
- **Zdravie** – prehliadky a návštevy lekára každej osoby. Každý si sám nastaví, kto jeho záznamy vidí:
  iba ja / ja a správcovia / všetci / vybraní členovia.
- **Nákupy a záruky** – tovar so zárukou, dátum nákupu, fotka alebo sken bločka či faktúry, stráženie konca záruky.
- **Upozornenia** do mobilu aj počítača: pripomienky v nastavenom čase (napr. 2 hodiny vopred), lekár jeden
  pracovný deň vopred, platba poistenia 20. deň v mesiaci pred splatnosťou, koniec poistenia 3 mesiace vopred,
  STK a EK 10 dní vopred, diaľničná známka ročná 7 dní / kratšia 24 hodín / 24-hodinová pri konci platnosti,
  koniec záruky 30 dní vopred. Denné pravidlá chodia o 7:00. Na iPhone treba aplikáciu najprv pridať na plochu.
- **Zámok aplikácie** – Face ID / odtlačok / Windows Hello, inak 4-miestny kód (na každom zariadení zvlášť).
- Opakované pripomienky a prehliadky – po označení „hotovo“ sa sám vytvorí ďalší termín.
- Viac rodín v jednej aplikácii (napr. rodičia, chalupa) a príprava na predplatné.

## Technika

Statická webová aplikácia (HTML + JavaScript) bez zostavovania, dáta v Supabase (Frankfurt).
Bezpečnosť stojí na pravidlách v databáze (Row Level Security) – každá rodina vidí iba svoje údaje.

## Nastavenie (raz)

1. **Vercel**: Add New → Project → repozitár `Rodina-Kunky` → Deploy (žiadne nastavenia netreba).
2. **Supabase** → projekt `rodina` → Authentication → URL Configuration:
   - Site URL: adresa z Vercelu (`https://kunky.vercel.app`)
   - Redirect URLs: tá istá adresa
3. Supabase posiela potvrdzovacie e-maily iba v obmedzenom počte za hodinu. Pre ostrú prevádzku
   treba vlastný SMTP (napr. Resend) – Authentication → Emails → SMTP Settings.

4. **Daikin** (pre dlaždicu Kúrenie / chladenie): na developer.cloud.daikineurope.com vytvoriť aplikáciu
   s Redirect URI `https://tiadykirohlgabalkxyn.supabase.co/functions/v1/daikin/callback`, potom v Supabase →
   Edge Functions → Secrets pridať `DAIKIN_CLIENT_ID` a `DAIKIN_CLIENT_SECRET`. V aplikácii Rodina → Kúrenie →
   „Prepojiť s Daikin Onecta“ (správca rodiny).

## Čo príde neskôr

Upozornenia e-mailom, prílohy aj k zmluvám, technickým preukazom a správam od lekára,
offline režim, predplatné.
