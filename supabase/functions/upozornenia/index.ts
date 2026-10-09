// Rodina – upozornenia (web push)
// Režimy:
//   GET / {"vapid":true}            → verejný kľúč pre prihlásenie na odber (vytvorí ho pri prvom volaní)
//   {"test":true} + prihlásený      → skúšobné upozornenie na zariadenia prihláseného používateľa
//   {"run":true}  + x-cron-secret   → beží každých 5 minút: pripomienky v nastavenom čase,
//                  denné pravidlá iba o 7:00 slovenského času
//                  voliteľne "date":"RRRR-MM-DD", "now":"ISO čas", "dry":true (iba výpis), "force":true
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const APP_URL = "https://kunky.vercel.app";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/* ---------- dátumy (Europe/Bratislava) ---------- */
function localNow() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bratislava", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
const parse = (s: string) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
function addMonths(s: string, n: number) {
  const d = parse(s); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); return iso(d);
}
const daysBetween = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000);
const fmt = (s: string) => { const d = parse(s); return `${d.getUTCDate()}. ${d.getUTCMonth() + 1}. ${d.getUTCFullYear()}`; };
const WEEKDAY = ["v nedeľu", "v pondelok", "v utorok", "v stredu", "vo štvrtok", "v piatok", "v sobotu"];

/* Dni pracovného pokoja na Slovensku. Pozor: 8. 5. a 15. 9. sú v roku 2026 výnimočne pracovné dni.
   Pri zmene zákona treba zoznam upraviť. */
function easter(y: number) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(new Date(Date.UTC(y, month - 1, day)));
}
function isHoliday(s: string) {
  const y = Number(s.slice(0, 4)), md = s.slice(5);
  if (["01-01", "01-06", "05-01", "07-05", "08-29", "11-01", "12-24", "12-25", "12-26"].includes(md)) return true;
  if (["05-08", "09-15"].includes(md) && y !== 2026) return true;
  const e = easter(y);
  return s === addDays(e, -2) || s === addDays(e, 1);
}
const isWorkday = (s: string) => { const w = parse(s).getUTCDay(); return w !== 0 && w !== 6 && !isHoliday(s); };
function prevWorkday(s: string) { let d = addDays(s, -1); while (!isWorkday(d)) d = addDays(d, -1); return d; }

/* ---------- kľúče web push ---------- */
const b64url = (u8: Uint8Array) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function vapidKeys() {
  const read = async () => {
    const { data } = await db.from("app_secrets").select("key,value").in("key", ["vapid_public", "vapid_private"]);
    const m = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
    return m.vapid_public && m.vapid_private ? { pub: m.vapid_public as string, priv: m.vapid_private as string } : null;
  };
  let k = await read();
  if (!k) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pub = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
    await db.from("app_secrets").upsert([{ key: "vapid_public", value: pub }, { key: "vapid_private", value: jwk.d! }], { onConflict: "key", ignoreDuplicates: true });
    k = await read();
  }
  await db.from("app_config").upsert({ key: "vapid_public", value: k!.pub }, { onConflict: "key" });
  webpush.setVapidDetails(APP_URL, k!.pub, k!.priv);
  return k!;
}

/* ---------- odoslanie ---------- */
type Msg = { title: string; body: string; url?: string; tag?: string };
async function pushToUser(userId: string, msg: Msg) {
  const { data: subs } = await db.from("push_subscriptions").select("*").eq("user_id", userId);
  let ok = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ ...msg, url: msg.url || "/#/prehlad" }), { TTL: 86400 });
      ok++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from("push_subscriptions").delete().eq("id", s.id); // zariadenie sa odhlásilo
      else console.error("push chyba", code, (e as Error).message);
    }
  }
  return ok;
}

/* ---------- výpočet upozornení na daný deň ---------- */
type Item = Msg & { users: string[]; key: string };
type Person = { id: string; name: string; user_id: string | null; health_visibility: string; health_viewer_ids: string[] };

function canSeeHealth(p: Person, uid: string, admins: Set<string>) {
  if (p.user_id === uid) return true;
  if (!p.user_id && admins.has(uid)) return true;
  if (p.health_visibility === "spravcovia" && admins.has(uid)) return true;
  if (p.health_visibility === "vsetci") return true;
  if (p.health_visibility === "vybrani") return (p.health_viewer_ids || []).includes(uid);
  return false;
}
const FREQ_MONTHS: Record<string, number> = { mesacne: 1, stvrtrocne: 3, polrocne: 6, rocne: 12 };
const eur = (n: number | null) => (n == null ? "" : `${Number(n).toFixed(2).replace(".", ",")} €`);

async function itemsFor(today: string, dry: boolean): Promise<Item[]> {
  const out: Item[] = [];
  const { data: hhs } = await db.from("households").select("id,name");
  for (const h of hhs || []) {
    const [mem, per, vis, ins, veh, dev, pur] = await Promise.all([
      db.from("members").select("user_id,role").eq("household_id", h.id),
      db.from("persons").select("id,name,user_id,health_visibility,health_viewer_ids").eq("household_id", h.id),
      db.from("health_visits").select("*").eq("household_id", h.id).eq("done", false).gt("visit_on", today).lte("visit_on", addDays(today, 10)),
      db.from("insurances").select("*").eq("household_id", h.id),
      db.from("vehicles").select("*").eq("household_id", h.id),
      db.from("devices").select("*").eq("household_id", h.id),
      db.from("purchases").select("*").eq("household_id", h.id),
    ]);
    const all = (mem.data || []).map((m) => m.user_id as string);
    const admins = new Set((mem.data || []).filter((m) => m.role === "spravca").map((m) => m.user_id as string));
    const persons = (per.data || []) as Person[];

    // Lekár: vždy jeden pracovný deň vopred
    for (const v of vis.data || []) {
      if (prevWorkday(v.visit_on) !== today) continue;
      const p = persons.find((x) => x.id === v.person_id); if (!p) continue;
      const when = daysBetween(today, v.visit_on) === 1 ? "zajtra" : WEEKDAY[parse(v.visit_on).getUTCDay()];
      out.push({
        users: all.filter((u) => canSeeHealth(p, u, admins)), key: `lekar:${v.id}:${v.visit_on}`,
        title: `Lekár ${when}: ${p.name}`,
        body: [v.title, `${fmt(v.visit_on)}${v.visit_time ? ` o ${String(v.visit_time).slice(0, 5)}` : ""}`, v.doctor, v.place].filter(Boolean).join(" · "),
        url: "/#/zdravie", tag: `lekar-${v.id}`,
      });
    }

    // Poistenie: platba vždy 20. v predošlom mesiaci; po termíne sa dátum platby posunie podľa frekvencie
    for (const x of ins.data || []) {
      let pay: string | null = x.next_payment_on;
      if (pay && pay < today && FREQ_MONTHS[x.frequency]) {
        while (pay < today) pay = addMonths(pay, FREQ_MONTHS[x.frequency]);
        if (!dry) await db.from("insurances").update({ next_payment_on: pay }).eq("id", x.id);
      }
      if (pay) {
        const d = parse(pay); const remind = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 20)));
        if (remind === today) out.push({
          users: all, key: `platba:${x.id}:${pay}`, title: `Platba poistenia: ${x.name}`,
          body: [eur(x.premium), `splatné ${fmt(pay)}`, x.insurer].filter(Boolean).join(" · "), url: "/#/domacnost", tag: `platba-${x.id}`,
        });
      }
      if (x.valid_until && addMonths(x.valid_until, -3) === today) out.push({
        users: all, key: `poistenie-koniec:${x.id}:${x.valid_until}`, title: `Poistenie končí o 3 mesiace`,
        body: `${x.name} · platí do ${fmt(x.valid_until)}${x.insurer ? ` · ${x.insurer}` : ""}`, url: "/#/domacnost/poistenia",
      });
    }

    // Autá: STK a EK 10 dní vopred, ročná diaľničná známka 7 dní (kratšie známky rieši vignetteItems), servis 30 a 7 dní
    const VEH: [string, string, number[]][] = [["stk_until", "STK", [10]], ["ek_until", "Emisná kontrola", [10]], ["vignette_until", "Diaľničná známka", [7]], ["next_service_on", "Servis", [30, 7]]];
    for (const v of veh.data || []) for (const [k, l, when] of VEH) {
      const d = v[k]; if (!d) continue; const n = daysBetween(today, d);
      if (k === "vignette_until" && v.vignette_kind && v.vignette_kind !== "rocna") continue;
      if (when.includes(n)) out.push({ users: all, key: `auto:${v.id}:${k}:${d}:${n}`, title: `${l} o ${n} dní: ${v.name}`, body: `do ${fmt(d)}${v.plate ? ` · ${v.plate}` : ""}`, url: "/#/domacnost/auta" });
    }

    // Zariadenia: koniec záruky 30 dní vopred, servis 7 dní vopred
    for (const x of dev.data || []) {
      if (x.warranty_until && daysBetween(today, x.warranty_until) === 30) out.push({ users: all, key: `zaruka-zar:${x.id}:${x.warranty_until}`, title: `Záruka končí o 30 dní`, body: `${x.name} · do ${fmt(x.warranty_until)}`, url: "/#/domacnost" });
      if (x.next_service_on && daysBetween(today, x.next_service_on) === 7) out.push({ users: all, key: `servis-zar:${x.id}:${x.next_service_on}`, title: `Servis o 7 dní: ${x.name}`, body: fmt(x.next_service_on), url: "/#/domacnost" });
    }

    // Nákupy: koniec záruky 30 dní vopred
    for (const x of pur.data || []) {
      if (x.warranty_until && daysBetween(today, x.warranty_until) === 30) out.push({ users: all, key: `zaruka:${x.id}:${x.warranty_until}`, title: `Záruka končí o 30 dní`, body: `${x.name}${x.store ? ` (${x.store})` : ""} · do ${fmt(x.warranty_until)}`, url: "/#/domacnost" });
    }
  }
  return out;
}

/* Pripomienky: v čase „X vopred“ podľa nastavenia (okno posledných 30 minút, aby sa nič nestratilo) */
async function reminderItems(nowIso: string): Promise<Item[]> {
  const to = new Date(nowIso), from = new Date(to.getTime() - 30 * 60000);
  const { data, error } = await db.rpc("due_reminders", { p_from: from.toISOString(), p_to: to.toISOString() });
  if (error) throw error;
  const out: Item[] = [];
  const cache: Record<string, { all: string[]; persons: { id: string; name: string }[] }> = {};
  for (const r of data || []) {
    if (!cache[r.household_id]) {
      const [m, p] = await Promise.all([
        db.from("members").select("user_id").eq("household_id", r.household_id),
        db.from("persons").select("id,name").eq("household_id", r.household_id),
      ]);
      cache[r.household_id] = { all: (m.data || []).map((x) => x.user_id), persons: p.data || [] };
    }
    const c = cache[r.household_id];
    const time = r.due_time ? String(r.due_time).slice(0, 5) : "";
    const local = localNow().date;
    const day = r.due_on === local ? "dnes" : r.due_on === addDays(local, 1) ? "zajtra" : fmt(r.due_on);
    out.push({
      users: c.all, key: `pripomienka:${r.id}:${r.due_on}:${r.due_time || ""}:${r.remind_before_minutes}`, title: r.title,
      body: [time ? `${day} o ${time}` : day, c.persons.find((x) => x.id === r.person_id)?.name, r.note].filter(Boolean).join(" · "),
      url: "/#/kalendar", tag: `pripomienka-${r.id}`,
    });
  }
  return out;
}

/* Diaľničná známka kratšia ako rok: 24 hodín pred koncom; 24-hodinová: v momente konca platnosti */
const VIGNETTE: Record<string, string> = { "30dni": "30-dňová", "10dni": "10-dňová", "1den": "24-hodinová" };
async function vignetteItems(nowIso: string): Promise<Item[]> {
  const to = new Date(nowIso), from = new Date(to.getTime() - 30 * 60000);
  const { data, error } = await db.rpc("due_vignettes", { p_from: from.toISOString(), p_to: to.toISOString() });
  if (error) throw error;
  const out: Item[] = [];
  for (const v of data || []) {
    const { data: m } = await db.from("members").select("user_id").eq("household_id", v.household_id);
    const time = v.vignette_until_time ? String(v.vignette_until_time).slice(0, 5) : "23:59";
    const ended = v.vignette_kind === "1den";
    out.push({
      users: (m || []).map((x) => x.user_id), key: `znamka:${v.id}:${v.vignette_until}:${time}`,
      title: ended ? `Diaľničnej známke práve skončila platnosť: ${v.name}` : `Diaľničná známka končí o 24 hodín: ${v.name}`,
      body: [`${VIGNETTE[v.vignette_kind]} známka`, `platná do ${fmt(v.vignette_until)} ${time}`, v.plate].filter(Boolean).join(" · "),
      url: "/#/domacnost/auta", tag: `znamka-${v.id}`,
    });
  }
  return out;
}

async function run(today: string, dry: boolean, daily: boolean, nowIso: string) {
  const items = [...(daily ? await itemsFor(today, dry) : []), ...(await reminderItems(nowIso)), ...(await vignetteItems(nowIso))];
  if (dry) return { date: today, items: items.map((i) => ({ title: i.title, body: i.body, recipients: i.users.length, key: i.key })) };
  await vapidKeys();
  let sent = 0;
  for (const it of items) for (const u of it.users) {
    const { error } = await db.from("notification_log").insert({ user_id: u, key: it.key });
    if (error) continue; // už odoslané
    sent += await pushToUser(u, { title: it.title, body: it.body, url: it.url, tag: it.tag });
  }
  return { date: today, items: items.length, sent };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    if (req.method === "GET" || body.vapid) return json({ publicKey: (await vapidKeys()).pub });

    if (body.test) {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: { user } } = await db.auth.getUser(token);
      if (!user) return json({ error: "Nie ste prihlásený" }, 401);
      await vapidKeys();
      const n = await pushToUser(user.id, { title: "Upozornenia fungujú", body: "Takto vám aplikácia Rodina pripomenie termíny.", url: "/#/prehlad", tag: "test" });
      return json({ sent: n });
    }

    if (body.run) {
      const { data } = await db.from("app_secrets").select("value").eq("key", "cron").single();
      if (!data || req.headers.get("x-cron-secret") !== data.value) return json({ error: "Neoprávnený prístup" }, 401);
      const now = localNow();
      const daily = !!(body.force || body.dry || body.date || now.hour === 7);
      return json(await run(body.date || now.date, !!body.dry, daily, body.now || new Date().toISOString()));
    }
    return json({ error: "Neznáma požiadavka" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
