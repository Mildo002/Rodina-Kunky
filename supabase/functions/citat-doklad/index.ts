// Rodina – AI čítanie dokladov (Claude vision): technický preukaz → formulár Auto, poistná zmluva → formulár Poistenie.
// Vstup (POST, prihlásený používateľ): {"household_id":uuid, "kind":"vehicle"|"insurance", "files":[{"mime":"image/jpeg","data":"<base64>"}]}
// Výstup: {"fields":{…}} – iba návrh hodnôt do formulára, nič sa neukladá. Obrázky sa neukladajú ani nelogujú.
// Tajomstvo ANTHROPIC_API_KEY (Supabase → Edge Functions → Secrets) zadáva majiteľ.
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const MODEL = "claude-sonnet-5-5";
const LIMIT_USER_DAY = 40, LIMIT_HOUSEHOLD_DAY = 120;
const MAX_FILES = 4, MAX_BYTES = 9 * 1024 * 1024; // spolu (base64 dĺžka)
const MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];
const ALLOWED_ORIGINS = ["https://kunky.vercel.app"];

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  const ok = ALLOWED_ORIGINS.includes(o) || /^https:\/\/kunky-[a-z0-9-]+-mi-ldo002(s-projects)?\.vercel\.app$/.test(o) || /^http:\/\/localhost(:\d+)?$/.test(o);
  return {
    "Access-Control-Allow-Origin": ok ? o : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const D = { type: ["string", "null"], description: "Dátum vo formáte RRRR-MM-DD, alebo null" };
const S = (d: string) => ({ type: ["string", "null"], description: d });
const SCHEMAS: Record<string, { name: string; description: string; input_schema: unknown }> = {
  vehicle: {
    name: "vyplnit_auto",
    description: "Vyplní formulár auta podľa technického preukazu / osvedčenia o evidencii vozidla.",
    input_schema: {
      type: "object",
      properties: {
        doklad: S("Čo je na obrázku, napr. 'Osvedčenie o evidencii časť I', 'protokol STK', 'nečitateľné'"),
        plate: S("Evidenčné číslo vozidla (kolónka A), bez medzier navyše, napr. 'PU123AB'"),
        make: S("Značka (D.1), napr. 'ŠKODA'"),
        model: S("Obchodný názov (D.3), prípadne typ (D.2), napr. 'OCTAVIA'"),
        vin: S("VIN (kolónka E), 17 znakov"),
        year_made: { type: ["integer", "null"], description: "Rok výroby; ak chýba, rok dátumu prvej evidencie (kolónka B)" },
        first_registration: D,
        stk_until: { ...D, description: "Platnosť technickej kontroly (STK) do, iba ak je na doklade" },
        ek_until: { ...D, description: "Platnosť emisnej kontroly do, iba ak je na doklade" },
        fuel: S("Palivo (P.3), napr. 'BA', 'NM', 'Elektrina'"),
        color: S("Farba (R)"),
        note: S("Krátka poznámka s ďalšími užitočnými údajmi (výkon P.2, objem P.1, palivo, farba, číslo TP), max. 200 znakov"),
      },
      required: ["doklad"],
    },
  },
  insurance: {
    name: "vyplnit_poistenie",
    description: "Vyplní formulár poistenia podľa poistnej zmluvy, návrhu alebo potvrdenia (zelená karta, PZP, havarijné, životné, majetok…).",
    input_schema: {
      type: "object",
      properties: {
        doklad: S("Čo je na obrázku, napr. 'poistná zmluva PZP', 'zelená karta', 'nečitateľné'"),
        kind: { type: ["string", "null"], enum: ["auto", "osoba", "zivotne", "majetok", "ine", null], description: "auto = PZP/havarijné; osoba = úrazové/cestovné/zdravotné; zivotne = životné/investičné životné; majetok = domácnosť/nehnuteľnosť; ine" },
        name: S("Krátky výstižný názov, napr. 'PZP Škoda Octavia', 'Poistenie domácnosti', 'Životné poistenie Milan'"),
        insurer: S("Poisťovňa, napr. 'Allianz – Slovenská poisťovňa'"),
        policy_no: S("Číslo poistnej zmluvy"),
        premium: { type: ["number", "null"], description: "Výška jednej splátky poistného v € podľa frekvencie platenia (nie ročné, ak sa platí mesačne)" },
        frequency: { type: ["string", "null"], enum: ["mesacne", "stvrtrocne", "polrocne", "rocne", "jednorazovo", null] },
        next_payment_on: { ...D, description: "Najbližší dátum splatnosti poistného (budúci, odvodený od výročia a frekvencie), ak sa dá určiť" },
        valid_from: { ...D, description: "Začiatok poistenia" },
        valid_until: { ...D, description: "Koniec poistenia; pri dobe neurčitej null" },
        insured_person: S("Meno poistenej osoby (pri poistení osôb, životnom) – pri PZP null"),
        vehicle_plate: S("EČV poisteného vozidla (pri poistení auta)"),
        note: S("Krátka poznámka: rozsah krytia, limity, spoluúčasť, výročný deň, kontakt na škody; max. 250 znakov"),
      },
      required: ["doklad"],
    },
  },
};

const SYSTEM = `Si pomocník slovenskej rodinnej aplikácie. Z fotky alebo skenu slovenského / českého dokladu presne prepíšeš údaje do formulára.
Pravidlá: vyplň iba to, čo na doklade naozaj je alebo sa z neho dá jednoznačne odvodiť; inak null. Nevymýšľaj.
Dátumy vždy RRRR-MM-DD. Čísla ako číslo (desatinná bodka). Texty po slovensky, s diakritikou podľa dokladu.
Technický preukaz (osvedčenie o evidencii): A = EČV, B = dátum prvej evidencie, D.1 = značka, D.2 = typ, D.3 = obchodný názov, E = VIN, P.1 objem, P.2 výkon, P.3 palivo, R farba.
Ak je obrázok nečitateľný alebo nejde o požadovaný doklad, uveď to v poli „doklad“ a ostatné nechaj null.
Dnešný dátum: ${new Date().toISOString().slice(0, 10)}.`;

Deno.serve(async (req) => {
  const H = cors(req);
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...H, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method !== "POST") return json({ error: "Nepovolená metóda" }, 405);
  try {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await db.auth.getUser(token);
    if (!user) return json({ error: "Nie ste prihlásený" }, 401);

    const raw = await req.text();
    if (raw.length > MAX_BYTES + 20000) return json({ error: "Súbory sú príliš veľké (spolu max. 6 MB)." }, 413);
    const body = JSON.parse(raw || "{}");
    const kind = String(body.kind || "");
    if (!SCHEMAS[kind]) return json({ error: "Neznámy druh dokladu" }, 400);
    const hid = String(body.household_id || "");
    if (!/^[0-9a-f-]{36}$/i.test(hid)) return json({ error: "Chýba rodina" }, 400);
    const { data: mem } = await db.from("members").select("user_id").eq("household_id", hid).eq("user_id", user.id).maybeSingle();
    if (!mem) return json({ error: "Nie ste členom tejto rodiny" }, 403);

    const files = Array.isArray(body.files) ? body.files : [];
    if (!files.length || files.length > MAX_FILES) return json({ error: `Pridajte 1 až ${MAX_FILES} fotky alebo PDF.` }, 400);
    let total = 0;
    for (const f of files) {
      if (!MIMES.includes(f?.mime) || typeof f?.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(f.data.slice(0, 200))) return json({ error: "Nepodporovaný súbor. Použite fotku (JPG, PNG) alebo PDF." }, 400);
      total += f.data.length;
    }
    if (total > MAX_BYTES) return json({ error: "Súbory sú príliš veľké (spolu max. 6 MB)." }, 413);

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "AI čítanie dokladov ešte nie je nastavené (chýba kľúč ANTHROPIC_API_KEY)." }, 503);

    // limit použitia
    const since = new Date(Date.now() - 86400000).toISOString();
    const [u, h] = await Promise.all([
      db.from("ai_usage").select("id", { count: "exact", head: true }).eq("user_id", user.id).gt("created_at", since),
      db.from("ai_usage").select("id", { count: "exact", head: true }).eq("household_id", hid).gt("created_at", since),
    ]);
    if ((u.count || 0) >= LIMIT_USER_DAY || (h.count || 0) >= LIMIT_HOUSEHOLD_DAY) return json({ error: "Denný limit čítania dokladov je vyčerpaný. Skúste to zajtra." }, 429);
    await db.from("ai_usage").insert({ user_id: user.id, household_id: hid, kind });

    const tool = SCHEMAS[kind];
    const content: unknown[] = files.map((f: { mime: string; data: string }) => f.mime === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } }
      : { type: "image", source: { type: "base64", media_type: f.mime, data: f.data } });
    content.push({ type: "text", text: kind === "vehicle"
      ? "Prepíš údaje z tohto dokladu vozidla do formulára auta."
      : "Prepíš údaje z tejto poistnej zmluvy / dokladu do formulára poistenia." });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1500, system: SYSTEM,
        tools: [tool], tool_choice: { type: "tool", name: tool.name },
        messages: [{ role: "user", content }],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("anthropic", res.status, t.slice(0, 300));
      if (res.status === 401) return json({ error: "Kľúč ANTHROPIC_API_KEY je neplatný." }, 502);
      if (res.status === 429 || res.status === 529) return json({ error: "AI je práve preťažená, skúste to o chvíľu." }, 503);
      return json({ error: "Doklad sa nepodarilo prečítať. Skúste ostrejšiu fotku." }, 502);
    }
    const out = await res.json();
    const use = (out.content || []).find((c: { type: string }) => c.type === "tool_use");
    if (!use) return json({ error: "Doklad sa nepodarilo prečítať." }, 502);
    const fields = clean(kind, use.input || {});

    // priradenie osoby a auta z tejto rodiny (pri poistení)
    if (kind === "insurance") {
      const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (fields.vehicle_plate) {
        const { data: veh } = await db.from("vehicles").select("id,plate").eq("household_id", hid);
        const v = (veh || []).find((x) => x.plate && norm(x.plate) === norm(String(fields.vehicle_plate)));
        if (v) fields.vehicle_id = v.id;
      }
      if (fields.insured_person) {
        const { data: per } = await db.from("persons").select("id,name").eq("household_id", hid);
        const n = norm(String(fields.insured_person));
        const p = (per || []).find((x) => { const m = norm(x.name); return m && (n.includes(m) || m.includes(n) || n.startsWith(m.slice(0, 5))); });
        if (p) fields.person_id = p.id;
      }
    }
    return json({ fields });
  } catch (e) {
    console.error(e);
    return json({ error: "Nastala chyba pri čítaní dokladu." }, 500);
  }
});

/* Iba povolené polia a bezpečné hodnoty */
function clean(kind: string, i: Record<string, unknown>) {
  const str = (v: unknown, max = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) ? v : null);
  const o: Record<string, unknown> = { doklad: str(i.doklad, 120) };
  if (kind === "vehicle") {
    o.plate = str(i.plate, 12)?.toUpperCase().replace(/\s+/g, "") ?? null;
    o.make = str(i.make, 40); o.model = str(i.model, 60);
    const vin = str(i.vin, 20)?.toUpperCase().replace(/\s+/g, "");
    o.vin = vin && /^[A-HJ-NPR-Z0-9]{11,17}$/.test(vin) ? vin : null;
    const y = Number(i.year_made); o.year_made = Number.isInteger(y) && y > 1900 && y <= new Date().getFullYear() + 1 ? y : (date(i.first_registration) ? Number(String(i.first_registration).slice(0, 4)) : null);
    o.stk_until = date(i.stk_until); o.ek_until = date(i.ek_until);
    const nm = [o.make, o.model].filter(Boolean).join(" ");
    o.name = nm ? nm.toLowerCase().replace(/(^|\s|-)\S/g, (c) => c.toUpperCase()) : null;
    o.note = [str(i.note, 200), date(i.first_registration) ? `1. evidencia ${i.first_registration}` : null].filter(Boolean).join(" · ") || null;
  } else {
    const kinds = ["auto", "osoba", "zivotne", "majetok", "ine"], freq = ["mesacne", "stvrtrocne", "polrocne", "rocne", "jednorazovo"];
    o.kind = kinds.includes(String(i.kind)) ? i.kind : null;
    o.name = str(i.name, 80); o.insurer = str(i.insurer, 80); o.policy_no = str(i.policy_no, 40);
    const pr = Number(i.premium); o.premium = isFinite(pr) && pr > 0 && pr < 1e6 ? Math.round(pr * 100) / 100 : null;
    o.frequency = freq.includes(String(i.frequency)) ? i.frequency : null;
    o.next_payment_on = date(i.next_payment_on); o.valid_from = date(i.valid_from); o.valid_until = date(i.valid_until);
    o.insured_person = str(i.insured_person, 80); o.vehicle_plate = str(i.vehicle_plate, 12);
    o.note = str(i.note, 250);
  }
  return o;
}
