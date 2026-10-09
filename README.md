# Rodina

Spoločný prehľad celej domácnosti pre všetkých členov rodiny – na mobile aj počítači.

## Čo aplikácia vie (fáza 1)

- **Rodina a pozvánky** – založíte rodinu, členov pozvete odkazom (WhatsApp, SMS…). Roly správca / člen.
  Deti či starí rodičia môžu byť v rodine aj bez vlastného účtu.
- **Prehľad** – všetko, čo vás čaká v najbližších 30 dňoch, a čo je po termíne.
- **Kalendár** – pripomienky, návštevy lekára, STK a EK, diaľničné známky, platby a koniec poistení, záruky a servisy zariadení.
- **Nákupný zoznam** – spoločný, mení sa u všetkých naživo.
- **Domácnosť** – zariadenia (záruka, servis), autá (STK, EK, známka, servis), poistenia
  (auto, osoby, životné, majetok) s ročným súčtom poistného.
- **Zdravie** – prehliadky a návštevy lekára každej osoby. Každý si sám nastaví, kto jeho záznamy vidí:
  iba ja / ja a správcovia / všetci / vybraní členovia.
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

## Čo príde neskôr

Logo, upozornenia e-mailom a notifikácie v mobile, prílohy (zmluvy, technické preukazy, správy od lekára),
offline režim, predplatné.
