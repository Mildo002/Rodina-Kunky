// Rodina – konektor pre Claude (MCP cez HTTP, JSON-RPC).
// Adresa: https://tiadykirohlgabalkxyn.supabase.co/functions/v1/rodina-mcp/<kľúč>
// Kľúč si používateľ vytvorí v aplikácii (Rodina → Prepojenie s Claude); v databáze je iba jeho odtlačok.
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

function localNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bratislava", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const addDays = (s: string, n: number) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmt = (s: string) => { const [y, m, d] = s.split("-").map(Number); return `${d}. ${m}. ${y}`; };
const WD = ["nedeľa", "pondelok", "utorok", "streda", "štvrtok", "piatok", "sobota"];
const weekday = (s: string) => WD[new Date(s + "T12:00:00Z").getUTCDay()];
async function sha256(t: string) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

type Ctx = { user_id: string; household_id: string; household: string };
async function authenticate(req: Request): Promise<Ctx | null> {
  const path = new URL(req.url).pathname.split("/").filter(Boolean);
  const token = path[path.length - 1] !== "rodina-mcp" ? path[path.length - 1]
    : (req.headers.get("x-rodina-token") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  if (!token || token.length < 20) return null;
  const { data: t } = await db.from("api_tokens").select("*").eq("token_hash", await sha256(token)).maybeSingle();
  if (!t) return null;
  const { data: m } = await db.from("members").select("user_id").eq("household_id", t.household_id).eq("user_id", t.user_id).maybeSingle();
  if (!m) return null; // už nie je členom rodiny
  const { data: h } = await db.from("households").select("name").eq("id", t.household_id).single();
  await db.from("api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", t.id);
  return { user_id: t.user_id, household_id: t.household_id, household: h?.name || "Rodina" };
}

const DATE = { type: "string", description: "Dátum vo formáte RRRR-MM-DD (slovenský čas)." };
const TOOLS = [
  {
    name: "pridat_pripomienku",
    description: "Uloží pripomienku do kalendára aplikácie Rodina. Aplikácia pošle upozornenie do mobilu všetkým členom rodiny v nastavenom predstihu.",
    inputSchema: {
      type: "object", required: ["nazov", "datum"],
      properties: {
        nazov: { type: "string", description: "Čo treba urobiť, krátko (napr. „Vyzdvihnúť Peťka zo školy“)." },
        datum: DATE,
        cas: { type: "string", description: "Čas udalosti HH:MM (24 h). Bez času sa upozornenie ráta od 7:00." },
        upozornit_minut_vopred: { type: "integer", description: "Koľko minút pred udalosťou upozorniť (0 = v čase udalosti, 60 = hodinu vopred, 1440 = deň vopred). Predvolené 120." },
        opakovat_mesiace: { type: "integer", description: "Ak sa opakuje: 1 = mesačne, 12 = ročne. Inak vynechať." },
        poznamka: { type: "string", description: "Podrobnosti (nepovinné)." },
      },
    },
  },
  {
    name: "pridat_poznamku",
    description: "Uloží poznámku, recept alebo nápad do sekcie Pripomienky v aplikácii Rodina (vidí ju celá rodina, ak nie je súkromná). Pri recepte zapíš suroviny a postup prehľadne po riadkoch.",
    inputSchema: {
      type: "object", required: ["nadpis"],
      properties: {
        nadpis: { type: "string" },
        text: { type: "string", description: "Obsah poznámky / receptu. Môže mať viac riadkov." },
        druh: { type: "string", enum: ["poznamka", "recept", "napad", "ine"], description: "Predvolené „poznamka“." },
        sukromna: { type: "boolean", description: "true = uvidí ju iba autor. Predvolené false." },
      },
    },
  },
  {
    name: "pridat_na_nakup",
    description: "Pridá položky na spoločný nákupný zoznam rodiny (ostatní ich uvidia hneď).",
    inputSchema: {
      type: "object", required: ["polozky"],
      properties: {
        polozky: {
          type: "array", description: "Zoznam položiek.",
          items: { type: "object", required: ["nazov"], properties: { nazov: { type: "string" }, mnozstvo: { type: "string", description: "napr. „2 l“, „3 ks“" } } },
        },
      },
    },
  },
  {
    name: "poslat_rychlu_spravu",
    description: "Pošle rýchlu správu celej rodine s okamžitým upozornením (pomoc, odvoz, škola, nákup…).",
    inputSchema: {
      type: "object", required: ["druh"],
      properties: {
        druh: { type: "string", enum: ["pomoc", "odvoz", "do_skoly", "zo_skoly", "nakup", "ine"] },
        text: { type: "string", description: "Podrobnosti; pri druhu „ine“ samotná správa." },
        datum: DATE, cas: { type: "string", description: "HH:MM" }, miesto: { type: "string" },
      },
    },
  },
  {
    name: "zoznam_terminov",
    description: "Vypíše naplánované pripomienky a termíny rodiny na najbližšie dni (pripomienky, lekár, STK, poistenia, záruky).",
    inputSchema: { type: "object", properties: { dni: { type: "integer", description: "Koľko dní dopredu, predvolené 14." } } },
  },
  {
    name: "hladat_poznamky",
    description: "Vyhľadá v poznámkach a receptoch rodiny podľa slova.",
    inputSchema: { type: "object", required: ["hladat"], properties: { hladat: { type: "string" } } },
  },
];

const ok = (text: string) => ({ content: [{ type: "text", text }] });
const fail = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s: unknown) => typeof s === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(s);

async function callTool(name: string, a: Record<string, any>, c: Ctx) {
  if (name === "pridat_pripomienku") {
    if (!a.nazov?.trim()) return fail("Chýba názov pripomienky.");
    if (!isDate(a.datum)) return fail("Dátum musí byť vo formáte RRRR-MM-DD.");
    if (a.cas && !isTime(a.cas)) return fail("Čas musí byť vo formáte HH:MM.");
    const before = Number.isInteger(a.upozornit_minut_vopred) ? Math.max(0, a.upozornit_minut_vopred) : 120;
    const { error } = await db.from("reminders").insert({
      household_id: c.household_id, created_by: c.user_id, title: a.nazov.trim(), due_on: a.datum, due_time: a.cas || null,
      remind_before_minutes: before, repeat_months: Number.isInteger(a.opakovat_mesiace) && a.opakovat_mesiace > 0 ? a.opakovat_mesiace : null,
      note: a.poznamka?.trim() || null,
    });
    if (error) return fail("Nepodarilo sa uložiť: " + error.message);
    const base = new Date(`${a.datum}T${a.cas || "07:00"}:00`), at = new Date(base.getTime() - before * 60000);
    const when = before ? ` Upozornenie príde ${at.getDate()}. ${at.getMonth() + 1}. o ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}.` : " Upozornenie príde v čase udalosti.";
    return ok(`Uložené do aplikácie Rodina (${c.household}): „${a.nazov.trim()}“ – ${weekday(a.datum)} ${fmt(a.datum)}${a.cas ? ` o ${a.cas}` : ""}.${when}`);
  }
  if (name === "pridat_poznamku") {
    if (!a.nadpis?.trim()) return fail("Chýba nadpis.");
    const druh = ["poznamka", "recept", "napad", "ine"].includes(a.druh) ? a.druh : "poznamka";
    const { error } = await db.from("notes").insert({
      household_id: c.household_id, created_by: c.user_id, title: a.nadpis.trim().slice(0, 200), body: a.text?.trim() || null, category: druh, private: !!a.sukromna,
    });
    if (error) return fail("Nepodarilo sa uložiť: " + error.message);
    return ok(`Uložené do aplikácie Rodina → Pripomienky (${{ poznamka: "poznámka", recept: "recept", napad: "nápad", ine: "iné" }[druh]}): „${a.nadpis.trim()}“.`);
  }
  if (name === "pridat_na_nakup") {
    const items = (Array.isArray(a.polozky) ? a.polozky : []).map((x: any) => typeof x === "string" ? { nazov: x } : x).filter((x: any) => x?.nazov?.trim());
    if (!items.length) return fail("Žiadne položky.");
    const { error } = await db.from("shopping_items").insert(items.map((x: any) => ({ household_id: c.household_id, added_by: c.user_id, text: x.nazov.trim(), quantity: x.mnozstvo?.trim() || null })));
    if (error) return fail("Nepodarilo sa uložiť: " + error.message);
    return ok(`Pridané na nákupný zoznam: ${items.map((x: any) => x.nazov.trim() + (x.mnozstvo ? ` (${x.mnozstvo})` : "")).join(", ")}.`);
  }
  if (name === "poslat_rychlu_spravu") {
    const druh = ["pomoc", "odvoz", "do_skoly", "zo_skoly", "nakup", "ine"].includes(a.druh) ? a.druh : "ine";
    if (druh === "ine" && !a.text?.trim()) return fail("Chýba text správy.");
    let when_at = null;
    if (a.datum || a.cas) {
      const d = isDate(a.datum) ? a.datum : localNow().date;
      if (a.cas && !isTime(a.cas)) return fail("Čas musí byť HH:MM.");
      const off = new Intl.DateTimeFormat("en", { timeZone: "Europe/Bratislava", timeZoneName: "longOffset" }).formatToParts(new Date(`${d}T12:00:00Z`)).find((p) => p.type === "timeZoneName")?.value.replace("GMT", "") || "+01:00";
      when_at = new Date(`${d}T${a.cas || "00:00"}:00${off}`).toISOString();
    }
    const { error } = await db.from("quick_messages").insert({ household_id: c.household_id, created_by: c.user_id, kind: druh, text: a.text?.trim() || null, when_at, place: a.miesto?.trim() || null });
    if (error) return fail("Nepodarilo sa odoslať: " + error.message);
    return ok("Rýchla správa odoslaná celej rodine – dostanú upozornenie.");
  }
  if (name === "zoznam_terminov") {
    const now = localNow(), to = addDays(now.date, Math.min(Math.max(Number(a.dni) || 14, 1), 120));
    const h = c.household_id;
    const [r, veh, ins, pur] = await Promise.all([
      db.from("reminders").select("title,due_on,due_time,note").eq("household_id", h).eq("done", false).gte("due_on", now.date).lte("due_on", to).order("due_on"),
      db.from("vehicles").select("name,stk_until,ek_until,vignette_until,next_service_on").eq("household_id", h),
      db.from("insurances").select("name,next_payment_on,valid_until").eq("household_id", h),
      db.from("purchases").select("name,warranty_until").eq("household_id", h),
    ]);
    const ev: [string, string][] = [];
    for (const x of r.data || []) ev.push([x.due_on, `${x.title}${x.due_time ? ` o ${String(x.due_time).slice(0, 5)}` : ""}${x.note ? ` – ${x.note}` : ""}`]);
    const inR = (d: string | null) => d && d >= now.date && d <= to;
    for (const v of veh.data || []) for (const [k, l] of [["stk_until", "STK"], ["ek_until", "Emisná kontrola"], ["vignette_until", "Diaľničná známka"], ["next_service_on", "Servis"]] as const) if (inR(v[k])) ev.push([v[k], `${l}: ${v.name}`]);
    for (const x of ins.data || []) { if (inR(x.next_payment_on)) ev.push([x.next_payment_on, `Platba poistenia: ${x.name}`]); if (inR(x.valid_until)) ev.push([x.valid_until, `Končí poistenie: ${x.name}`]); }
    for (const x of pur.data || []) if (inR(x.warranty_until)) ev.push([x.warranty_until, `Končí záruka: ${x.name}`]);
    ev.sort((x, y) => x[0].localeCompare(y[0]));
    return ok(`Dnes je ${weekday(now.date)} ${fmt(now.date)}, ${now.time}. Rodina „${c.household}“ – termíny do ${fmt(to)}:\n` +
      (ev.length ? ev.map(([d, t]) => `• ${weekday(d)} ${fmt(d)}: ${t}`).join("\n") : "Nič naplánované.") +
      "\n(Zdravotné záznamy sa cez konektor nezobrazujú – sú v aplikácii.)");
  }
  if (name === "hladat_poznamky") {
    const q = String(a.hladat || "").trim().replace(/[%,()]/g, " ");
    if (!q) return fail("Zadajte, čo hľadať.");
    const { data, error } = await db.from("notes").select("title,body,category,private,created_by").eq("household_id", c.household_id)
      .or(`title.ilike.%${q}%,body.ilike.%${q}%`).order("updated_at", { ascending: false }).limit(10);
    if (error) return fail(error.message);
    const list = (data || []).filter((n) => !n.private || n.created_by === c.user_id);
    return ok(list.length ? list.map((n) => `## ${n.title}\n${n.body || ""}`).join("\n\n") : `Nič sa nenašlo pre „${q}“.`);
  }
  return fail("Neznámy nástroj: " + name);
}

async function handle(msg: any, c: Ctx) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return null; // notifikácia – bez odpovede
  const res = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (method === "initialize") {
    const v = VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[0];
    const now = localNow();
    return res({
      protocolVersion: v, capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "rodina", title: "Rodina", version: "1.0.0" },
      instructions: `Aplikácia Rodina pre rodinu „${c.household}“. Dnes je ${weekday(now.date)} ${now.date}, ${now.time} (slovenský čas). ` +
        "Keď používateľ chce niečo pripomenúť, uložiť recept či poznámku, pridať na nákup alebo poslať správu rodine, použi nástroje. Dátumy RRRR-MM-DD, čas HH:MM. Odpovedaj po slovensky.",
    });
  }
  if (method === "ping") return res({});
  if (method === "tools/list") return res({ tools: TOOLS });
  if (method === "tools/call") {
    try { return res(await callTool(params?.name, params?.arguments || {}, c)); }
    catch (e) { return res(fail("Chyba: " + (e as Error).message)); }
  }
  return err(-32601, "Metóda nie je podporovaná: " + method);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...HEADERS, "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" } });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Použite POST (MCP)" }), { status: 405, headers: { ...HEADERS, Allow: "POST" } });
  const c = await authenticate(req);
  if (!c) return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Neplatný alebo zrušený kľúč. Vytvorte nový v aplikácii Rodina → Prepojenie s Claude." } }), { status: 401, headers: HEADERS });
  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Chybný JSON" } }), { status: 400, headers: HEADERS }); }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(m, c)))).filter(Boolean);
    return out.length ? new Response(JSON.stringify(out), { headers: HEADERS }) : new Response(null, { status: 202, headers: HEADERS });
  }
  const out = await handle(body, c);
  return out ? new Response(JSON.stringify(out), { headers: HEADERS }) : new Response(null, { status: 202, headers: HEADERS });
});
