// Rodina – Daikin Onecta (tepelné čerpadlo, klimatizácia)
// POST {action:"status"|"cached"|"set"|"start"|"disconnect", household_id, ...} – s tokenom prihláseného člena rodiny
//      alebo interne (konektor Claude) s hlavičkou x-cron-secret.
// GET  /daikin/callback?code&state – návrat z prihlásenia Daikin (OAuth)
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CLIENT_ID = Deno.env.get("DAIKIN_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("DAIKIN_CLIENT_SECRET") || "";
const IDP = "https://idp.onecta.daikineurope.com/v1/oidc";
const API = "https://api.onecta.daikineurope.com";
const REDIRECT = "https://tiadykirohlgabalkxyn.supabase.co/functions/v1/daikin/callback";
const APP = "https://kunky.vercel.app";
const CACHE_MS = 15 * 60 * 1000;      // limit Daikin: 200 požiadaviek denne → údaje najviac raz za 15 min
const MIN_REFRESH_MS = 3 * 60 * 1000;  // ručné obnovenie najskôr po 3 min
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class UserError extends Error {}

/* ---------- prístup ---------- */
async function context(req: Request, body: any) {
  const hid = body.household_id;
  if (!hid) throw new UserError("Chýba rodina");
  const secret = req.headers.get("x-cron-secret");
  if (secret) {
    const { data } = await db.from("app_secrets").select("value").eq("key", "cron").single();
    if (secret !== data?.value) throw new UserError("Neoprávnený prístup");
    return { hid, user: body.user_id || null, admin: false };
  }
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) throw new UserError("Nie ste prihlásený");
  const { data: m } = await db.from("members").select("role").eq("household_id", hid).eq("user_id", user.id).maybeSingle();
  if (!m) throw new UserError("Nie ste členom tejto rodiny");
  return { hid, user: user.id, admin: m.role === "spravca" };
}

/* ---------- tokeny a volania Daikin ---------- */
async function tokenRequest(params: Record<string, string>) {
  const res = await fetch(`${IDP}/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new UserError(`Daikin prihlásenie zlyhalo (${data.error || res.status})`);
  return data as { access_token: string; refresh_token?: string; expires_in?: number };
}
async function accessToken(acc: any, force = false) {
  if (!force && acc.access_token && acc.expires_at && new Date(acc.expires_at).getTime() > Date.now() + 60000) return acc.access_token;
  if (!acc.refresh_token) throw new UserError("Daikin nie je prepojený");
  let t;
  try { t = await tokenRequest({ grant_type: "refresh_token", refresh_token: acc.refresh_token }); }
  catch (e) {
    await db.from("daikin_accounts").update({ refresh_token: null, access_token: null }).eq("household_id", acc.household_id);
    throw new UserError("Prepojenie s Daikin vypršalo – prepojte ho znova v Rodine (Kúrenie / chladenie).");
  }
  acc.access_token = t.access_token;
  acc.refresh_token = t.refresh_token || acc.refresh_token;
  acc.expires_at = new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString();
  await db.from("daikin_accounts").update({ access_token: acc.access_token, refresh_token: acc.refresh_token, expires_at: acc.expires_at }).eq("household_id", acc.household_id);
  return acc.access_token;
}
async function daikin(acc: any, path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  if (acc.blocked_until && new Date(acc.blocked_until).getTime() > Date.now()) {
    throw new UserError(`Denný limit Daikin je vyčerpaný – skúste po ${new Date(acc.blocked_until).toLocaleTimeString("sk-SK", { timeZone: "Europe/Bratislava", hour: "2-digit", minute: "2-digit" })}.`);
  }
  const tok = await accessToken(acc);
  const res = await fetch(API + path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${tok}`, Accept: "application/json" } });
  const remaining = Number(res.headers.get("x-ratelimit-remaining-day"));
  const upd: Record<string, unknown> = {};
  if (!Number.isNaN(remaining) && res.headers.has("x-ratelimit-remaining-day")) upd.rate_remaining_day = remaining;
  if (res.status === 429) {
    const after = Number(res.headers.get("retry-after")) || 3600;
    upd.blocked_until = new Date(Date.now() + after * 1000).toISOString();
  }
  if (Object.keys(upd).length) { Object.assign(acc, upd); await db.from("daikin_accounts").update(upd).eq("household_id", acc.household_id); }
  if (res.status === 401 && retry) { await accessToken(acc, true); return daikin(acc, path, init, false); }
  if (res.status === 429) throw new UserError("Denný limit Daikin je vyčerpaný – skúste to neskôr.");
  return res;
}

/* ---------- prevod údajov Onecta na jednoduchý tvar ---------- */
const num = (x: any) => (typeof x?.value === "number" ? x.value : null);
function normalize(devices: any[]) {
  const out: any[] = [];
  for (const d of devices || []) {
    const gw = (d.managementPoints || []).find((m: any) => m.managementPointType === "gateway");
    const model = gw?.modelInfo?.value || d.deviceModel || "";
    const online = d.isCloudConnectionUp?.value !== false;
    for (const mp of d.managementPoints || []) {
      const type = mp.managementPointType;
      if (type !== "climateControl" && type !== "domesticHotWaterTank") continue;
      const mode = mp.operationMode?.value || "heating";
      const s = mp.sensoryData?.value || {};
      const sp = mp.temperatureControl?.value?.operationModes?.[mode]?.setpoints || {};
      const setpoints = Object.entries(sp).filter(([, v]: any) => typeof v?.value === "number").map(([k, v]: any) => ({
        key: k, path: `/operationModes/${mode}/setpoints/${k}`, value: v.value, min: v.minValue ?? null, max: v.maxValue ?? null, step: v.stepValue ?? 0.5,
        settable: v.settable !== false && mp.temperatureControl?.settable !== false,
      }));
      const isHeatPump = /altherma/i.test(`${d.deviceModel} ${model}`) || type === "domesticHotWaterTank" || setpoints.some((x) => /leavingWater/.test(x.key));
      out.push({
        device: d.id, mp: mp.embeddedId, type, kind: type === "domesticHotWaterTank" ? "voda" : isHeatPump ? "cerpadlo" : "klima",
        name: mp.name?.value || (type === "domesticHotWaterTank" ? "Teplá voda" : d.deviceModel || "Daikin"), model, online,
        on: mp.onOffMode?.value === "on", onSettable: mp.onOffMode?.settable !== false && !!mp.onOffMode,
        mode, modes: mp.operationMode?.settable ? (mp.operationMode?.values || []) : [],
        roomTemp: num(s.roomTemperature), outdoorTemp: num(s.outdoorTemperature), tankTemp: num(s.tankTemperature), leavingWater: num(s.leavingWaterTemperature),
        setpoints, powerful: mp.powerfulMode ? { on: mp.powerfulMode.value === "on", settable: mp.powerfulMode.settable !== false } : null,
        error: !!(mp.isInErrorState?.value),
      });
    }
  }
  return out;
}

async function account(hid: string) {
  const { data } = await db.from("daikin_accounts").select("*").eq("household_id", hid).maybeSingle();
  return data;
}
function publicState(acc: any, extra: Record<string, unknown> = {}) {
  return {
    configured: !!(CLIENT_ID && CLIENT_SECRET), connected: !!acc?.refresh_token,
    items: acc?.devices_cache || [], cache_at: acc?.cache_at || null,
    rate_remaining_day: acc?.rate_remaining_day ?? null, blocked_until: acc?.blocked_until || null, ...extra,
  };
}
async function status(hid: string, force: boolean) {
  const acc = await account(hid);
  if (!acc?.refresh_token) return publicState(acc);
  const age = acc.cache_at ? Date.now() - new Date(acc.cache_at).getTime() : Infinity;
  if (age < (force ? MIN_REFRESH_MS : CACHE_MS)) return publicState(acc, { fresh: false });
  try {
    const res = await daikin(acc, "/v1/gateway-devices");
    if (!res.ok) throw new UserError(`Daikin odpovedal chybou ${res.status}`);
    const items = normalize(await res.json());
    const cache_at = new Date().toISOString();
    await db.from("daikin_accounts").update({ devices_cache: items, cache_at }).eq("household_id", hid);
    return publicState({ ...acc, devices_cache: items, cache_at }, { fresh: true });
  } catch (e) {
    if (e instanceof UserError) return publicState(acc, { warning: e.message });
    throw e;
  }
}
const ALLOWED = new Set(["onOffMode", "operationMode", "temperatureControl", "powerfulMode"]);
async function setValue(hid: string, b: any) {
  if (!ALLOWED.has(b.characteristic)) throw new UserError("Toto nastavenie nie je povolené");
  const acc = await account(hid);
  if (!acc?.refresh_token) throw new UserError("Daikin nie je prepojený");
  const item = (acc.devices_cache || []).find((x: any) => x.device === b.device && x.mp === b.mp);
  if (!item) throw new UserError("Zariadenie sa nenašlo – obnovte údaje");
  if (b.characteristic === "temperatureControl") {
    const sp = item.setpoints.find((x: any) => x.path === b.path);
    if (!sp?.settable) throw new UserError("Túto teplotu nemožno meniť");
    if (typeof b.value !== "number" || (sp.min != null && b.value < sp.min) || (sp.max != null && b.value > sp.max)) throw new UserError(`Teplota musí byť ${sp.min}–${sp.max} °C`);
  }
  const body: Record<string, unknown> = { value: b.value };
  if (b.path) body.path = b.path;
  const res = await daikin(acc, `/v1/gateway-devices/${encodeURIComponent(b.device)}/management-points/${encodeURIComponent(b.mp)}/characteristics/${b.characteristic}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text(); throw new UserError(`Daikin zmenu neprijal (${res.status}) ${t.slice(0, 120)}`); }
  // uložiť zmenu aj do uložených údajov (bez ďalšieho volania Daikin)
  if (b.characteristic === "onOffMode") item.on = b.value === "on";
  if (b.characteristic === "operationMode") item.mode = b.value;
  if (b.characteristic === "powerfulMode" && item.powerful) item.powerful.on = b.value === "on";
  if (b.characteristic === "temperatureControl") item.setpoints.find((x: any) => x.path === b.path).value = b.value;
  await db.from("daikin_accounts").update({ devices_cache: acc.devices_cache }).eq("household_id", hid);
  return publicState(acc, { ok: true });
}

/* ---------- prepojenie (OAuth) ---------- */
async function start(hid: string, user: string) {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new UserError("Údaje aplikácie Daikin ešte nie sú nastavené na serveri.");
  const state = [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, "0")).join("");
  await db.from("daikin_oauth_states").insert({ state, household_id: hid, user_id: user });
  const url = `${IDP}/authorize?` + new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: "openid onecta:basic.integration", state });
  return { url };
}
async function callback(u: URL) {
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `${APP}/#/kurenie?${q}` } });
  const code = u.searchParams.get("code"), state = u.searchParams.get("state");
  if (!code || !state) return back("daikin=zrusene");
  const { data: st } = await db.from("daikin_oauth_states").select("*").eq("state", state).maybeSingle();
  if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60000) return back("daikin=vyprsalo");
  await db.from("daikin_oauth_states").delete().eq("state", state);
  try {
    const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT });
    await db.from("daikin_accounts").upsert({
      household_id: st.household_id, connected_by: st.user_id, refresh_token: t.refresh_token, access_token: t.access_token,
      expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(), devices_cache: null, cache_at: null, blocked_until: null,
    });
    return back("daikin=ok");
  } catch { return back("daikin=chyba"); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);
  if (req.method === "GET" && u.pathname.endsWith("/callback")) return callback(u);
  if (req.method !== "POST") return json({ error: "Použite POST" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const c = await context(req, body);
    switch (body.action) {
      case "cached": return json(publicState(await account(c.hid)));
      case "status": return json(await status(c.hid, !!body.force));
      case "set": return json(await setValue(c.hid, body));
      case "start":
        if (!c.user || !c.admin) throw new UserError("Daikin môže prepojiť iba správca rodiny");
        return json(await start(c.hid, c.user));
      case "disconnect":
        if (!c.admin) throw new UserError("Odpojiť môže iba správca rodiny");
        await db.from("daikin_accounts").update({ refresh_token: null, access_token: null, devices_cache: null, cache_at: null }).eq("household_id", c.hid);
        return json({ ok: true });
      default: return json({ error: "Neznáma akcia" }, 400);
    }
  } catch (e) {
    if (e instanceof UserError) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "Chyba servera" }, 500);
  }
});
