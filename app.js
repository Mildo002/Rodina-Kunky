import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY, APP_VERSION } from "./config.js";

// Chyba z odkazu v e-maile (napr. už použitý potvrdzovací odkaz) – zachytiť skôr, než ju spracuje Supabase
const AUTH_LINK_ERROR = (() => {
  const hp = new URLSearchParams(location.hash.replace(/^#\/?/, "") || location.search.slice(1));
  const code = hp.get("error_code") || hp.get("error");
  if (!code) return null;
  history.replaceState(null, "", location.pathname + "#/prehlad");
  if (/otp_expired|access_denied/.test(code))
    return "Odkaz z e-mailu už bol použitý alebo mu vypršala platnosť. Ak ste e-mail už potvrdili, stačí sa prihlásiť. Inak sa zaregistrujte znova a pošleme nový odkaz.";
  return "Odkaz z e-mailu nefunguje: " + (hp.get("error_description") || code).replace(/\+/g, " ");
})();

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $app = document.getElementById("app");
const $sheet = document.getElementById("sheet-root");

/* ================= stav ================= */
const S = {
  session: null, user: null, profile: null,
  households: [], hid: null, role: null,
  persons: [], members: [],
  channel: null, live: false, recovery: false,
  calMonth: null, calSel: null, homeTab: "zariadenia", healthPerson: null,
};

/* ================= pomocné ================= */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function parse(s) { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); }
const today = () => iso(new Date());
const daysTo = (s) => Math.round((parse(s) - parse(today())) / 86400000);
const fmt = (s) => (s ? parse(s).toLocaleDateString("sk-SK", { day: "numeric", month: "numeric", year: "numeric" }) : "");
const fmtTime = (t) => (t ? t.slice(0, 5) : "");
function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); }
function addMonths(s, n) {
  const d = parse(s); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); return iso(d);
}
function plural(n, one, few, many) { return n === 1 ? one : n >= 2 && n <= 4 ? few : many; }
function relDays(s) {
  const n = daysTo(s);
  if (n === 0) return "dnes";
  if (n === 1) return "zajtra";
  if (n === -1) return "včera";
  if (n > 0) return `o ${n} ${plural(n, "deň", "dni", "dní")}`;
  return `pred ${-n} ${plural(-n, "dňom", "dňami", "dňami")}`;
}
function pill(s, warnDays = 30) {
  if (!s) return "";
  const n = daysTo(s);
  const cls = n < 0 ? "bad" : n <= warnDays ? "warn" : "ok";
  return `<span class="pill ${cls}">${n < 0 ? "po termíne" : relDays(s)}</span>`;
}
let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
function errText(e) {
  const m = e?.message || String(e);
  if (/Invalid login credentials/i.test(m)) return "Nesprávny e-mail alebo heslo.";
  if (/Email not confirmed/i.test(m)) return "E-mail ešte nie je potvrdený. Otvorte odkaz, ktorý vám prišiel e-mailom.";
  if (/User already registered/i.test(m)) return "Tento e-mail je už zaregistrovaný. Prihláste sa.";
  if (/Password should be at least/i.test(m)) return "Heslo musí mať aspoň 6 znakov.";
  if (/rate limit/i.test(m)) return "Príliš veľa pokusov. Skúste to o chvíľu znova.";
  if (/Failed to fetch|NetworkError/i.test(m)) return "Nie ste pripojený na internet.";
  return m;
}
const myName = () => S.profile?.full_name || S.user?.email || "";
const isAdmin = () => S.role === "spravca";
const personName = (id) => S.persons.find((p) => p.id === id)?.name || "";

const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>',
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h2.5l2.2 11.2a1.5 1.5 0 0 0 1.5 1.2h8.6a1.5 1.5 0 0 0 1.5-1.1L21 8H6.3"/><circle cx="9.5" cy="20" r="1.3"/><circle cx="17.5" cy="20" r="1.3"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/><path d="M8 12h2l1-2 2 4 1-2h2"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2 .7 3.2 2.4 3.5 5.2"/></svg>',
  car: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16.5h14v-4.2a2 2 0 0 0-.4-1.2L16.8 8.5a2 2 0 0 0-1.6-.8H8.8a2 2 0 0 0-1.6.8L5.4 11.1a2 2 0 0 0-.4 1.2z"/><path d="M5 16.5V19M19 16.5V19M4 12h16"/><circle cx="8" cy="14.3" r=".9"/><circle cx="16" cy="14.3" r=".9"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m8.8 12 2.2 2.2 4.4-4.4"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-2.5-1.6L13 21l-2.5-1.6L8 21l-2-1.3z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/></svg>',
  washer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="3" width="15" height="18" rx="2.5"/><path d="M4.5 7.5h15"/><circle cx="12" cy="14" r="4"/><path d="M8 5.2h.01M11 5.2h.01"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  face: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 16a3.5 3.5 0 0 0 5 0"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
};

/* ================= číselníky ================= */
const KIND_LABEL = { auto: "Poistenie auta", osoba: "Poistenie osôb", zivotne: "Životné poistenie", majetok: "Poistenie majetku", ine: "Iné poistenie" };
const FREQ = [["mesacne", "mesačne"], ["stvrtrocne", "štvrťročne"], ["polrocne", "polročne"], ["rocne", "ročne"], ["jednorazovo", "jednorazovo"]];
const REPEAT = [["", "Neopakovať"], ["1", "Každý mesiac"], ["3", "Každé 3 mesiace"], ["6", "Každého pol roka"], ["12", "Každý rok"], ["24", "Každé 2 roky"]];
const REMIND = [["0", "V čase udalosti"], ["15", "15 minút vopred"], ["30", "30 minút vopred"], ["60", "1 hodinu vopred"], ["120", "2 hodiny vopred"], ["180", "3 hodiny vopred"], ["1440", "1 deň vopred"], ["2880", "2 dni vopred"], ["10080", "1 týždeň vopred"]];
const VIGNETTE = [["", "—"], ["rocna", "Ročná"], ["30dni", "30-dňová"], ["10dni", "10-dňová"], ["1den", "24-hodinová"]];
const WARRANTY = [["6", "6 mesiacov"], ["12", "12 mesiacov"], ["24", "24 mesiacov (zákonná)"], ["36", "3 roky"], ["48", "4 roky"], ["60", "5 rokov"], ["120", "10 rokov"]];
const DEV_CAT = ["Spotrebič", "Elektronika", "Kúrenie a voda", "Záhrada", "Náradie", "Iné"].map((x) => [x, x]);

const personOpts = (filter) => [["", "—"], ...S.persons.filter(filter || (() => true)).map((p) => [p.id, p.name])];

const FORMS = {
  device: () => ({
    table: "devices", title: "Zariadenie", fields: [
      { k: "name", l: "Názov", req: true, ph: "napr. Práčka" },
      { k: "category", l: "Druh", t: "select", opts: [["", "—"], ...DEV_CAT], half: true },
      { k: "location", l: "Umiestnenie", ph: "napr. kúpeľňa", half: true },
      { k: "manufacturer", l: "Výrobca", half: true }, { k: "model", l: "Model", half: true },
      { k: "serial_number", l: "Výrobné číslo" },
      { k: "purchased_on", l: "Kúpené", t: "date", half: true }, { k: "warranty_until", l: "Záruka do", t: "date", half: true },
      { k: "next_service_on", l: "Najbližší servis alebo revízia", t: "date" },
      { k: "note", l: "Poznámka", t: "textarea" },
    ],
  }),
  vehicle: () => ({
    table: "vehicles", title: "Auto", fields: [
      { k: "name", l: "Názov", req: true, ph: "napr. Škoda Octavia" },
      { k: "plate", l: "EČV", half: true }, { k: "year_made", l: "Rok výroby", t: "number", half: true },
      { k: "make", l: "Značka", half: true }, { k: "model", l: "Model", half: true },
      { k: "vin", l: "VIN" },
      { k: "stk_until", l: "STK platí do", t: "date", half: true }, { k: "ek_until", l: "EK platí do", t: "date", half: true },
      { k: "vignette_kind", l: "Diaľničná známka", t: "select", opts: VIGNETTE, half: true }, { k: "vignette_until", l: "Známka platí do", t: "date", half: true },
      { k: "vignette_until_time", l: "Známka platí do (čas)", t: "time", half: true }, { k: "next_service_on", l: "Najbližší servis", t: "date", half: true },
      { k: "note", l: "Poznámka", t: "textarea" },
    ],
  }),
  insurance: (vehicles = []) => ({
    table: "insurances", title: "Poistenie", fields: [
      { k: "kind", l: "Druh poistenia", t: "select", req: true, opts: Object.entries(KIND_LABEL) },
      { k: "name", l: "Názov", req: true, ph: "napr. PZP Octavia" },
      { k: "insurer", l: "Poisťovňa", half: true }, { k: "policy_no", l: "Číslo zmluvy", half: true },
      { k: "person_id", l: "Poistená osoba", t: "select", opts: personOpts(), half: true },
      { k: "vehicle_id", l: "Auto", t: "select", opts: [["", "—"], ...vehicles.map((v) => [v.id, v.name])], half: true },
      { k: "premium", l: "Poistné (€)", t: "number", step: "0.01", half: true },
      { k: "frequency", l: "Platí sa", t: "select", opts: [["", "—"], ...FREQ], half: true },
      { k: "next_payment_on", l: "Najbližšia platba", t: "date", half: true }, { k: "valid_until", l: "Platí do", t: "date", half: true },
      { k: "note", l: "Poznámka", t: "textarea" },
    ],
  }),
  purchase: () => ({
    table: "purchases", title: "Nákup so zárukou", fields: [
      { k: "name", l: "Čo ste kúpili", req: true, ph: "napr. Robotický vysávač" },
      { k: "store", l: "Obchod", half: true }, { k: "price", l: "Cena (€)", t: "number", step: "0.01", half: true },
      { k: "purchased_on", l: "Dátum nákupu", t: "date", req: true, half: true },
      { k: "warranty_months", l: "Záruka", t: "select", req: true, num: true, half: true, opts: WARRANTY },
      { k: "serial_number", l: "Výrobné číslo", half: true },
      { k: "person_id", l: "Komu patrí", t: "select", opts: personOpts(), half: true },
      { k: "note", l: "Poznámka", t: "textarea" },
    ],
  }),
  reminder: () => ({
    table: "reminders", title: "Pripomienka", fields: [
      { k: "title", l: "Čo treba urobiť", req: true, ph: "napr. Zaplatiť daň z nehnuteľnosti" },
      { k: "due_on", l: "Dátum", t: "date", req: true, half: true }, { k: "due_time", l: "Čas", t: "time", half: true },
      { k: "remind_before_minutes", l: "Upozorniť", t: "select", num: true, opts: REMIND, half: true },
      { k: "repeat_months", l: "Opakovanie", t: "select", opts: REPEAT, half: true },
      { k: "person_id", l: "Pre koho", t: "select", opts: personOpts(), half: true },
      { k: "note", l: "Poznámka", t: "textarea" },
    ],
  }),
  visit: () => ({
    table: "health_visits", title: "Návšteva lekára", fields: [
      { k: "person_id", l: "Kto", t: "select", req: true, opts: S.persons.filter(canSeeHealth).map((p) => [p.id, p.name]) },
      { k: "title", l: "Druh", req: true, ph: "napr. preventívna prehliadka, zubár" },
      { k: "doctor", l: "Lekár", half: true }, { k: "place", l: "Miesto", half: true },
      { k: "visit_on", l: "Dátum", t: "date", req: true, half: true }, { k: "visit_time", l: "Čas", t: "time", half: true },
      { k: "repeat_months", l: "Ďalšia prehliadka", t: "select", opts: REPEAT },
      { k: "note", l: "Poznámka", t: "textarea", ph: "Výsledky, odporúčania, čo si priniesť…" },
    ],
  }),
};

/* ================= spodný panel s formulárom ================= */
function closeSheet() { $sheet.innerHTML = ""; document.removeEventListener("keydown", escClose); }
function escClose(e) { if (e.key === "Escape") closeSheet(); }
function openSheet(title, bodyHtml, bind) {
  $sheet.innerHTML = `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sh"><h2>${esc(title)}</h2><button class="iconbtn" style="background:var(--paper);color:var(--ink)" data-close aria-label="Zavrieť">${ICON.x}</button></div>
    ${bodyHtml}</div></div>`;
  const scrim = $sheet.querySelector(".scrim");
  scrim.addEventListener("click", (e) => { if (e.target === scrim || e.target.closest("[data-close]")) closeSheet(); });
  document.addEventListener("keydown", escClose);
  bind?.($sheet.querySelector(".sheet"));
  $sheet.querySelector("input,select,textarea")?.focus();
}
function fieldHtml(f, v) {
  const val = v ?? "";
  const req = f.req ? " required" : "";
  const ph = f.ph ? ` placeholder="${esc(f.ph)}"` : "";
  let input;
  if (f.t === "select") input = `<select name="${f.k}"${req}>${f.opts.map(([o, l]) => `<option value="${esc(o)}"${String(o) === String(val) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  else if (f.t === "textarea") input = `<textarea name="${f.k}"${ph}>${esc(val)}</textarea>`;
  else input = `<input name="${f.k}" type="${f.t || "text"}"${f.step ? ` step="${f.step}"` : ""} value="${esc(f.t === "time" ? fmtTime(val) : val)}"${req}${ph}>`;
  return `<label class="f">${esc(f.l)}${input}</label>`;
}
function formHtml(fields, data) {
  let out = "", buf = [];
  const flush = () => { if (buf.length) { out += `<div class="grid2">${buf.join("")}</div>`; buf = []; } };
  for (const f of fields) { if (f.half) buf.push(fieldHtml(f, data[f.k])); else { flush(); out += fieldHtml(f, data[f.k]); } }
  flush(); return out;
}
function readForm(form, fields) {
  const fd = new FormData(form), o = {};
  for (const f of fields) {
    let v = fd.get(f.k); v = typeof v === "string" ? v.trim() : v;
    o[f.k] = v === "" || v == null ? null : f.t === "number" || f.num || f.k === "repeat_months" ? Number(String(v).replace(",", ".")) : v;
  }
  return o;
}
/** Formulár na pridanie / úpravu záznamu v tabuľke. */
function editRecord(def, row = {}, after) {
  const isNew = !row.id;
  openSheet((isNew ? "Pridať: " : "Upraviť: ") + def.title.toLowerCase(),
    `<form novalidate><div class="err hidden"></div>${formHtml(def.fields, row)}
      <div class="actions">${isNew ? "" : '<button type="button" class="btn danger" data-del>Odstrániť</button>'}
      <button class="btn">${isNew ? "Pridať" : "Uložiť"}</button></div></form>`,
    (el) => {
      const form = el.querySelector("form"), err = el.querySelector(".err");
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const missing = def.fields.filter((f) => f.req && !String(new FormData(form).get(f.k) || "").trim());
        if (missing.length) { err.textContent = `Vyplňte: ${missing.map((f) => f.l).join(", ")}.`; err.classList.remove("hidden"); return; }
        const vals = readForm(form, def.fields);
        const btn = form.querySelector("button:not([type])"); btn.disabled = true;
        const q = isNew ? sb.from(def.table).insert({ ...vals, household_id: S.hid }) : sb.from(def.table).update(vals).eq("id", row.id);
        const { error } = await q;
        btn.disabled = false;
        if (error) { err.textContent = errText(error); err.classList.remove("hidden"); return; }
        closeSheet(); toast(isNew ? "Pridané" : "Uložené"); after ? after() : route();
      });
      el.querySelector("[data-del]")?.addEventListener("click", async () => {
        if (!confirm("Naozaj odstrániť tento záznam?")) return;
        const { error } = await sb.from(def.table).delete().eq("id", row.id);
        if (error) { err.textContent = errText(error); err.classList.remove("hidden"); return; }
        closeSheet(); toast("Odstránené"); after ? after() : route();
      });
    });
}
async function editById(type, id) {
  if (type === "purchase") {
    const { data } = await sb.from("purchases").select("*").eq("id", id).maybeSingle();
    return data ? editPurchase(data) : toast("Záznam sa nenašiel");
  }
  const def = type === "insurance" ? FORMS.insurance(await vehiclesList()) : FORMS[type]();
  const { data, error } = await sb.from(def.table).select("*").eq("id", id).maybeSingle();
  if (error || !data) return toast("Záznam sa nenašiel");
  editRecord(def, data);
}
async function vehiclesList() {
  const { data } = await sb.from("vehicles").select("id,name").eq("household_id", S.hid).order("name");
  return data || [];
}
async function addInsurance() { editRecord(FORMS.insurance(await vehiclesList()), { kind: "auto" }); }

/* ================= nákup so zárukou + bločky / faktúry ================= */
const safeName = (n) => n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-80);
/** Veľké fotky z mobilu zmenší (max. 2000 px), aby sa rýchlo nahrali. PDF a iné nechá tak. */
async function shrink(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.5e6) return file;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch { return file; }
}
async function uploadAttachments(purchaseId, files) {
  for (const f0 of files) {
    const f = await shrink(f0);
    if (f.size > 10 * 1024 * 1024) throw new Error(`Súbor ${f0.name} je väčší ako 10 MB.`);
    const path = `${S.hid}/nakupy/${purchaseId}/${Date.now()}-${safeName(f.name)}`;
    const up = await sb.storage.from("prilohy").upload(path, f, { contentType: f.type || "application/octet-stream" });
    if (up.error) throw up.error;
    const { error } = await sb.from("attachments").insert({ household_id: S.hid, purchase_id: purchaseId, path, file_name: f0.name, mime: f.type, size_bytes: f.size });
    if (error) throw error;
  }
}
async function editPurchase(row = {}) {
  const def = FORMS.purchase(), isNew = !row.id;
  let atts = [], urls = [];
  if (!isNew) {
    const { data } = await sb.from("attachments").select("*").eq("purchase_id", row.id).order("created_at");
    atts = data || [];
    if (atts.length) urls = (await sb.storage.from("prilohy").createSignedUrls(atts.map((a) => a.path), 900)).data || [];
  }
  const attHtml = atts.map((a, i) => {
    const u = urls[i]?.signedUrl || "";
    const thumb = a.mime?.startsWith("image/") && u ? `<img src="${esc(u)}" alt="">` : `<span class="doc">${a.mime === "application/pdf" ? "PDF" : "súbor"}</span>`;
    return `<div class="att"><a href="${esc(u)}" target="_blank" rel="noopener">${thumb}<span>${esc(a.file_name || "Príloha")}</span></a><button type="button" class="iconbtn" data-delatt="${a.id}" aria-label="Odstrániť ${esc(a.file_name || "prílohu")}">${ICON.x}</button></div>`;
  }).join("");
  const data = { purchased_on: today(), warranty_months: 24, ...row };
  openSheet(isNew ? "Pridať nákup so zárukou" : "Nákup so zárukou", `<form novalidate><div class="err hidden"></div>
    ${formHtml(def.fields, data)}
    ${row.warranty_until ? `<p class="note">Záruka platí do <b>${fmt(row.warranty_until)}</b> (${daysTo(row.warranty_until) < 0 ? "už skončila" : relDays(row.warranty_until)}).</p>` : ""}
    <div class="f">Bloček, faktúra, záručný list
      ${atts.length ? `<div class="atts">${attHtml}</div>` : ""}
      <label class="btn ghost wide filebtn">Odfotiť alebo vybrať súbor<input type="file" name="files" accept="image/*,application/pdf" multiple></label>
      <div class="mut sm" id="picked">Fotka z mobilu alebo PDF, najviac 10 MB.</div>
    </div>
    <div class="actions">${isNew ? "" : '<button type="button" class="btn danger" data-del>Odstrániť</button>'}<button class="btn" data-save>${isNew ? "Pridať" : "Uložiť"}</button></div></form>`, (el) => {
    const form = el.querySelector("form"), err = el.querySelector(".err"), fileIn = form.querySelector('[name="files"]');
    const fail = (e) => { err.textContent = errText(e); err.classList.remove("hidden"); el.scrollTop = 0; };
    fileIn.addEventListener("change", () => {
      const n = fileIn.files.length;
      el.querySelector("#picked").textContent = n ? `Vybraté: ${[...fileIn.files].map((f) => f.name).join(", ")}` : "";
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const missing = def.fields.filter((f) => f.req && !String(new FormData(form).get(f.k) || "").trim());
      if (missing.length) return fail(`Vyplňte: ${missing.map((f) => f.l).join(", ")}.`);
      const btn = form.querySelector("[data-save]"); btn.disabled = true; btn.textContent = "Ukladám…";
      try {
        const vals = readForm(form, def.fields);
        const q = isNew ? sb.from("purchases").insert({ ...vals, household_id: S.hid }) : sb.from("purchases").update(vals).eq("id", row.id);
        const { data: saved, error } = await q.select("id").single();
        if (error) throw error;
        if (fileIn.files.length) await uploadAttachments(saved.id, [...fileIn.files]);
        closeSheet(); toast(isNew ? "Nákup pridaný" : "Uložené"); S.homeTab = "nakupy"; route();
      } catch (er) { fail(er); btn.disabled = false; btn.textContent = isNew ? "Pridať" : "Uložiť"; }
    });
    el.querySelectorAll("[data-delatt]").forEach((b) => b.addEventListener("click", async () => {
      const a = atts.find((x) => x.id === b.dataset.delatt);
      if (!confirm(`Odstrániť prílohu ${a.file_name || ""}?`)) return;
      await sb.storage.from("prilohy").remove([a.path]);
      const { error } = await sb.from("attachments").delete().eq("id", a.id);
      if (error) return fail(error);
      toast("Príloha odstránená"); editPurchase(row);
    }));
    el.querySelector("[data-del]")?.addEventListener("click", async () => {
      if (!confirm("Naozaj odstrániť tento nákup aj s prílohami?")) return;
      if (atts.length) await sb.storage.from("prilohy").remove(atts.map((a) => a.path));
      const { error } = await sb.from("purchases").delete().eq("id", row.id);
      if (error) return fail(error);
      closeSheet(); toast("Odstránené"); route();
    });
  });
}

/* Splnenie pripomienky / návštevy – pri opakovaní sa vytvorí ďalší termín */
async function markDone(table, row) {
  const dateKey = table === "reminders" ? "due_on" : "visit_on";
  const { error } = await sb.from(table).update({ done: true }).eq("id", row.id);
  if (error) return toast(errText(error));
  if (row.repeat_months) {
    const next = { ...row }; delete next.id; delete next.created_at; delete next.created_by;
    next.done = false; next[dateKey] = addMonths(row[dateKey], row.repeat_months);
    await sb.from(table).insert(next);
    toast(`Hotovo. Ďalší termín ${fmt(next[dateKey])}`);
  } else toast("Hotovo");
  route();
}

/* ================= zdravie – kto smie vidieť ================= */
function canSeeHealth(p) {
  const me = S.user.id;
  if (p.user_id === me) return true;
  if (!p.user_id && isAdmin()) return true;
  if (p.health_visibility === "spravcovia" && isAdmin()) return true;
  if (p.health_visibility === "vsetci") return true;
  if (p.health_visibility === "vybrani") return (p.health_viewer_ids || []).includes(me);
  return false;
}
const canSetHealth = (p) => p.user_id === S.user.id || (!p.user_id && isAdmin());

/* ================= termíny zo všetkých častí aplikácie ================= */
async function loadEvents(from, to) {
  const h = S.hid;
  const rq = sb.from("reminders").select("*").eq("household_id", h).eq("done", false).lte("due_on", to);
  const vq = sb.from("health_visits").select("*").eq("household_id", h).eq("done", false).lte("visit_on", to);
  if (from) { rq.gte("due_on", from); vq.gte("visit_on", from); }
  const [r, v, veh, ins, dev, pur] = await Promise.all([
    rq, vq,
    sb.from("vehicles").select("id,name,stk_until,ek_until,vignette_until,next_service_on").eq("household_id", h),
    sb.from("insurances").select("id,name,kind,next_payment_on,valid_until,premium").eq("household_id", h),
    sb.from("devices").select("id,name,warranty_until,next_service_on").eq("household_id", h),
    sb.from("purchases").select("id,name,store,warranty_until").eq("household_id", h),
  ]);
  const err = [r, v, veh, ins, dev, pur].find((x) => x.error);
  if (err) throw err.error;
  const ev = [];
  const inRange = (d) => d && d <= to && (!from || d >= from);
  for (const x of r.data) ev.push({ date: x.due_on, time: x.due_time, title: x.title, sub: x.person_id ? personName(x.person_id) : "Pripomienka", k: "pripomienka", type: "reminder", id: x.id, row: x, done: "reminders" });
  for (const x of v.data) ev.push({ date: x.visit_on, time: x.visit_time, title: x.title, sub: [personName(x.person_id), x.doctor].filter(Boolean).join(" · "), k: "zdravie", type: "visit", id: x.id, row: x, done: "health_visits" });
  for (const x of veh.data) {
    [["stk_until", "STK"], ["ek_until", "Emisná kontrola"], ["vignette_until", "Diaľničná známka"], ["next_service_on", "Servis auta"]]
      .forEach(([key, l]) => inRange(x[key]) && ev.push({ date: x[key], title: `${l}: ${x.name}`, sub: "Auto", k: "auto", type: "vehicle", id: x.id }));
  }
  for (const x of ins.data) {
    if (inRange(x.next_payment_on)) ev.push({ date: x.next_payment_on, title: `Platba: ${x.name}`, sub: x.premium ? `${Number(x.premium).toLocaleString("sk-SK", { minimumFractionDigits: 2 })} €` : KIND_LABEL[x.kind], k: "poistenie", type: "insurance", id: x.id });
    if (inRange(x.valid_until)) ev.push({ date: x.valid_until, title: `Končí poistenie: ${x.name}`, sub: KIND_LABEL[x.kind], k: "poistenie", type: "insurance", id: x.id });
  }
  for (const x of dev.data) {
    if (inRange(x.warranty_until)) ev.push({ date: x.warranty_until, title: `Končí záruka: ${x.name}`, sub: "Zariadenie", k: "zariadenie", type: "device", id: x.id });
    if (inRange(x.next_service_on)) ev.push({ date: x.next_service_on, title: `Servis: ${x.name}`, sub: "Zariadenie", k: "zariadenie", type: "device", id: x.id });
  }
  for (const x of pur.data) {
    if (inRange(x.warranty_until)) ev.push({ date: x.warranty_until, title: `Končí záruka: ${x.name}`, sub: x.store || "Nákup", k: "nakup", type: "purchase", id: x.id });
  }
  ev.sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  return ev;
}
function eventRow(e, showDate = false) {
  const canDone = !!e.done;
  return `<div class="row">
    <span class="tag k-${e.k}"></span>
    ${canDone ? `<button class="check" data-done="${e.done}:${e.id}" aria-label="Označiť ako hotové"></button>` : ""}
    <button class="main linkish" data-open="${e.type}:${e.id}" style="background:none;border:0;text-align:left;padding:0;cursor:pointer">
      <b>${esc(e.title)}</b><span>${esc([showDate ? fmt(e.date) : "", fmtTime(e.time), e.sub].filter(Boolean).join(" · "))}</span>
    </button>
    ${showDate ? pill(e.date, 14) : ""}
  </div>`;
}
function bindEvents(root, events) {
  root.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => {
    const [type, id] = b.dataset.open.split(":"); editById(type, id);
  }));
  root.querySelectorAll("[data-done]").forEach((b) => b.addEventListener("click", () => {
    const [table, id] = b.dataset.done.split(":");
    const e = events.find((x) => x.id === id); if (e) markDone(table, e.row);
  }));
}

/* ================= rozloženie ================= */
const TABS = [
  ["prehlad", "Domov", ICON.home], ["kalendar", "Kalendár", ICON.cal], ["nakup", "Nákup", ICON.cart],
  ["domacnost", "Domácnosť", ICON.box], ["zdravie", "Zdravie", ICON.heart],
];
function layout(view, inner) {
  const h = S.households.find((x) => x.id === S.hid);
  const hh = S.households.length > 1
    ? `<select id="hh" aria-label="Rodina">${S.households.map((x) => `<option value="${x.id}"${x.id === S.hid ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`
    : `<b>${esc(h?.name)}</b>`;
  $app.innerHTML = `
    <header class="top">
      <img class="mark" src="logo.png" alt="" width="40" height="40">
      <div class="who">${hh}<small>${esc(myName())}${isAdmin() ? " · správca" : ""}</small></div>
      <a class="iconbtn" href="#/rodina" aria-label="Rodina a nastavenia" ${view === "rodina" ? 'style="background:var(--sun);color:#22204a"' : ""}>${ICON.people}</a>
    </header>
    <main>${inner}</main>
    <nav class="tabbar" aria-label="Hlavné menu">${TABS.map(([k, l, i]) => `<a href="#/${k}" class="${view === k ? "on" : ""}" ${view === k ? 'aria-current="page"' : ""}>${i}<span>${l}</span></a>`).join("")}</nav>`;
  document.getElementById("hh")?.addEventListener("change", async (e) => { S.hid = e.target.value; store.set("rodina_hid", S.hid); await loadContext(); route(); });
}
const loading = (view) => layout(view, '<p class="mut">Načítavam…</p>');

/* ================= PREHĽAD ================= */
/* Dlaždice úvodnej obrazovky – jedna pre každú sekciu */
const TILES = [
  { k: "pripomienka", href: "#/kalendar", icon: "cal", name: "Kalendár", empty: "Pripomienky a termíny" },
  { k: "nakupny", href: "#/nakup", icon: "cart", name: "Nákupný zoznam", empty: "Spoločný zoznam" },
  { k: "zdravie", href: "#/zdravie", icon: "heart", name: "Zdravie", empty: "Prehliadky a lekári" },
  { k: "auto", href: "#/domacnost/auta", icon: "car", name: "Autá", empty: "STK, EK, známka, servis" },
  { k: "poistenie", href: "#/domacnost/poistenia", icon: "shield", name: "Poistenia", empty: "Auto, osoby, majetok" },
  { k: "nakup", href: "#/domacnost/nakupy", icon: "receipt", name: "Nákupy a záruky", empty: "Bločky a koniec záruky" },
  { k: "zariadenie", href: "#/domacnost/zariadenia", icon: "washer", name: "Zariadenia", empty: "Spotrebiče a servis" },
  { k: "rodina", href: "#/rodina", icon: "people", name: "Rodina", empty: "Členovia a nastavenia" },
];
async function viewPrehlad() {
  loading("prehlad");
  const to = addDays(today(), 30);
  let ev, shop;
  try {
    [ev, shop] = await Promise.all([loadEvents(null, to), sb.from("shopping_items").select("id", { count: "exact", head: true }).eq("household_id", S.hid).eq("checked", false)]);
  } catch (e) { return layout("prehlad", `<div class="err">${esc(errText(e))}</div>`); }
  const t = today();
  const late = ev.filter((e) => e.date < t);
  const soon = ev.filter((e) => e.date >= t);
  const status = (k) => {
    if (k === "nakupny") { const n = shop.count ?? 0; return { line: n ? `${n} ${plural(n, "položka", "položky", "položiek")} na kúpenie` : "Nič netreba kúpiť", badge: n || "" }; }
    if (k === "rodina") return { line: `${S.persons.length} ${plural(S.persons.length, "osoba", "osoby", "osôb")} v rodine`, badge: "" };
    const lateK = late.filter((e) => e.k === k).length;
    const next = soon.find((e) => e.k === k);
    if (lateK) return { line: `${lateK} po termíne`, alert: true, badge: lateK };
    if (next) return { line: `${next.title.replace(/^[^:]+:\s*/, "")} · ${relDays(next.date)}`, warn: daysTo(next.date) <= 7 };
    return { line: null };
  };
  const tiles = TILES.map((tl) => {
    const st = status(tl.k);
    return `<a class="tile k-${tl.k}" href="${tl.href}">
      <span class="ticon">${ICON[tl.icon]}${st.badge ? `<i class="badge ${st.alert ? "bad" : ""}">${st.badge}</i>` : ""}</span>
      <b>${esc(tl.name)}</b>
      <span class="tline ${st.alert ? "bad" : st.warn ? "warn" : ""}">${esc(st.line || tl.empty)}</span></a>`;
  }).join("");
  const groups = {};
  for (const e of soon.slice(0, 8)) (groups[e.date] ||= []).push(e);
  const dayBlock = (items, cls, numHtml) => `<div class="day ${cls}"><div class="num">${numHtml}</div><div class="list">${items.map((e) => eventRow(e, cls === "late")).join("")}</div></div>`;
  let agenda = late.length ? dayBlock(late, "late", `<b>!</b><small>po termíne</small>`) : "";
  for (const [d, items] of Object.entries(groups)) {
    const dt = parse(d);
    agenda += dayBlock(items, d === t ? "today" : "", `<b>${dt.getDate()}</b><small>${d === t ? "dnes" : dt.toLocaleDateString("sk-SK", { weekday: "short", month: "short" })}</small>`);
  }
  const hour = new Date().getHours();
  const greet = hour < 10 ? "Dobré ráno" : hour < 18 ? "Dobrý deň" : "Dobrý večer";
  layout("prehlad", `
    <div class="head"><h1>${greet}, ${esc(myName().split(" ")[0])}</h1></div>
    <div id="pushAsk"></div>
    <nav class="tiles" aria-label="Sekcie">${tiles}</nav>
    <section>
      <div class="head"><h2>Najbližšie termíny</h2><a class="btn ghost sm" href="#/kalendar">Celý kalendár</a></div>
      ${ev.length ? `<div class="agenda">${agenda}</div>` : `<div class="card empty"><b>Najbližších 30 dní je voľných</b>Pridajte pripomienku, auto s termínom STK alebo poistenie a termíny sa tu zobrazia samy.</div>`}
      <div class="row" style="padding:16px 0 0;border:0;gap:8px;flex-wrap:wrap">
        <button class="btn" id="addRem">Pridať pripomienku</button>
        <button class="btn ghost" id="addVis">Pridať návštevu lekára</button>
      </div>
    </section>`);
  bindEvents($app, ev);
  document.getElementById("addRem").onclick = () => editRecord(FORMS.reminder(), { due_on: today(), remind_before_minutes: 120 });
  document.getElementById("addVis").onclick = () => newVisit();
  askForPush();
}
async function askForPush() {
  const box = document.getElementById("pushAsk");
  if (!box || store.get("rodina_push_ask") === "nie") return;
  const st = await pushState();
  if (st !== "off" && !(st === "unsupported" && isIOS && !isStandalone())) return;
  box.innerHTML = `<div class="card note-card"><b>Chcete, aby vám aplikácia pripomínala termíny?</b>
    <p class="mut sm">Pripomienky v čase, ktorý si nastavíte, lekár deň vopred, platby poistenia, STK, známka…</p>
    <div class="row" style="border:0;padding:0;gap:8px;flex-wrap:wrap"><a class="btn sm" href="#/rodina">Nastaviť upozornenia</a><button class="btn ghost sm" id="pLater">Teraz nie</button></div></div>`;
  box.querySelector("#pLater").onclick = () => { store.set("rodina_push_ask", "nie"); box.innerHTML = ""; };
}
function newVisit(date) {
  const visible = S.persons.filter(canSeeHealth);
  if (!visible.length) return toast("Nemáte prístup k zdravotným záznamom nikoho z rodiny");
  editRecord(FORMS.visit(), { visit_on: date || today(), person_id: (visible.find((p) => p.user_id === S.user.id) || visible[0]).id });
}

/* ================= KALENDÁR ================= */
async function viewKalendar() {
  if (!S.calMonth) { const d = new Date(); S.calMonth = new Date(d.getFullYear(), d.getMonth(), 1); }
  if (!S.calSel) S.calSel = today();
  loading("kalendar");
  const m = S.calMonth;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const end = new Date(start); end.setDate(start.getDate() + 41);
  let ev;
  try { ev = await loadEvents(iso(start), iso(end)); } catch (e) { return layout("kalendar", `<div class="err">${esc(errText(e))}</div>`); }
  const byDay = {};
  for (const e of ev) (byDay[e.date] ||= []).push(e);
  let cells = ["Po", "Ut", "St", "Št", "Pi", "So", "Ne"].map((d) => `<div class="dow">${d}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i); const s = iso(d);
    const kinds = [...new Set((byDay[s] || []).map((e) => e.k))].slice(0, 4);
    const cls = [d.getMonth() !== m.getMonth() ? "out" : "", s === today() ? "today" : "", s === S.calSel ? "sel" : ""].join(" ");
    cells += `<button class="${cls}" data-d="${s}" aria-label="${fmt(s)}${kinds.length ? `, ${(byDay[s] || []).length} termínov` : ""}">${d.getDate()}<span class="dots">${kinds.map((k) => `<i class="k-${k}"></i>`).join("")}</span></button>`;
  }
  const sel = byDay[S.calSel] || [];
  const monthName = m.toLocaleDateString("sk-SK", { month: "long", year: "numeric" });
  layout("kalendar", `
    <div class="cal-nav">
      <button class="iconbtn" style="background:var(--card);color:var(--ink)" id="prev" aria-label="Predchádzajúci mesiac">${ICON.left}</button>
      <h2>${esc(monthName.charAt(0).toUpperCase() + monthName.slice(1))}</h2>
      <button class="btn ghost sm" id="tdy">Dnes</button>
      <button class="iconbtn" style="background:var(--card);color:var(--ink)" id="next" aria-label="Ďalší mesiac">${ICON.right}</button>
    </div>
    <div class="cal">${cells}</div>
    <section>
      <div class="head"><h2>${esc(parse(S.calSel).toLocaleDateString("sk-SK", { weekday: "long", day: "numeric", month: "long" }))}</h2></div>
      ${sel.length ? `<div class="list">${sel.map((e) => eventRow(e)).join("")}</div>` : `<div class="card empty">Na tento deň nie je nič naplánované.</div>`}
      <div class="row" style="padding:14px 0 0;border:0;gap:8px;flex-wrap:wrap">
        <button class="btn" id="addRem">Pridať pripomienku</button>
        <button class="btn ghost" id="addVis">Pridať návštevu lekára</button>
      </div>
    </section>`);
  bindEvents($app, ev);
  $app.querySelectorAll(".cal [data-d]").forEach((b) => b.addEventListener("click", () => {
    S.calSel = b.dataset.d; const d = parse(S.calSel);
    if (d.getMonth() !== m.getMonth()) S.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    viewKalendar();
  }));
  document.getElementById("prev").onclick = () => { S.calMonth = new Date(m.getFullYear(), m.getMonth() - 1, 1); viewKalendar(); };
  document.getElementById("next").onclick = () => { S.calMonth = new Date(m.getFullYear(), m.getMonth() + 1, 1); viewKalendar(); };
  document.getElementById("tdy").onclick = () => { S.calMonth = null; S.calSel = today(); viewKalendar(); };
  document.getElementById("addRem").onclick = () => editRecord(FORMS.reminder(), { due_on: S.calSel, remind_before_minutes: 120 });
  document.getElementById("addVis").onclick = () => newVisit(S.calSel);
}

/* ================= NÁKUP (v reálnom čase) ================= */
function subscribeShopping() {
  if (S.channel) { sb.removeChannel(S.channel); S.channel = null; S.live = false; }
  if (!S.hid) return;
  S.channel = sb.channel(`nakup-${S.hid}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "shopping_items", filter: `household_id=eq.${S.hid}` }, () => {
      if (currentView() === "nakup") renderShopping();
    })
    .subscribe((status) => {
      S.live = status === "SUBSCRIBED";
      document.querySelector(".live")?.classList.toggle("on", S.live);
    });
}
let shopFirst = true;
async function viewNakup() {
  shopFirst = true;
  layout("nakup", `
    <div class="head"><div><h1>Nákupný zoznam</h1><p class="live ${S.live ? "on" : ""}"><i></i>Spoločný pre celú rodinu, mení sa naživo</p></div></div>
    <form class="add" id="addItem" autocomplete="off">
      <input name="text" placeholder="Čo treba kúpiť?" aria-label="Položka" required>
      <input name="qty" placeholder="Koľko" aria-label="Množstvo" style="flex:0 0 90px">
      <button class="btn">Pridať</button>
    </form>
    <div id="shop"><p class="mut">Načítavam…</p></div>`);
  const form = document.getElementById("addItem");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = form.text.value.trim(); if (!text) return;
    const qty = form.qty.value.trim() || null;
    form.reset(); form.text.focus();
    const { error } = await sb.from("shopping_items").insert({ household_id: S.hid, text, quantity: qty });
    if (error) toast(errText(error)); else renderShopping();
  });
  renderShopping();
}
async function renderShopping() {
  const box = document.getElementById("shop"); if (!box) return;
  const { data, error } = await sb.from("shopping_items").select("*").eq("household_id", S.hid).order("checked").order("created_at");
  if (error) { box.innerHTML = `<div class="err">${esc(errText(error))}</div>`; return; }
  const open = data.filter((x) => !x.checked), done = data.filter((x) => x.checked);
  const nameOf = (uid) => S.members.find((m) => m.user_id === uid)?.full_name?.split(" ")[0] || "";
  const item = (x) => `<div class="row ${x.checked ? "done" : ""}">
      <button class="check ${x.checked ? "on" : ""}" data-t="${x.id}" aria-label="${x.checked ? "Vrátiť do zoznamu" : "Kúpené"}" aria-pressed="${x.checked}">${x.checked ? ICON.check : ""}</button>
      <div class="main"><b>${esc(x.text)}${x.quantity ? ` <span style="display:inline;color:var(--mut);font-weight:400">· ${esc(x.quantity)}</span>` : ""}</b>
      <span>${x.checked ? `kúpil(a) ${esc(nameOf(x.checked_by))}` : `pridal(a) ${esc(nameOf(x.added_by))}`}</span></div>
      <button class="iconbtn" style="background:none;color:var(--mut);width:36px;height:36px" data-x="${x.id}" aria-label="Odstrániť ${esc(x.text)}">${ICON.x}</button>
    </div>`;
  box.innerHTML = `
    ${open.length ? `<div class="list">${open.map(item).join("")}</div>` : `<div class="card empty"><b>Zoznam je prázdny</b>Napíšte, čo treba kúpiť. Ostatní to uvidia hneď.</div>`}
    ${done.length ? `<section><div class="head"><h2>Kúpené</h2><button class="btn ghost sm" id="clr">Odstrániť kúpené</button></div><div class="list">${done.map(item).join("")}</div></section>` : ""}`;
  box.querySelectorAll("[data-t]").forEach((b) => b.addEventListener("click", async () => {
    const x = data.find((i) => i.id === b.dataset.t); const on = !x.checked;
    const { error } = await sb.from("shopping_items").update({ checked: on, checked_by: on ? S.user.id : null, checked_at: on ? new Date().toISOString() : null }).eq("id", x.id);
    if (error) toast(errText(error)); else renderShopping();
  }));
  box.querySelectorAll("[data-x]").forEach((b) => b.addEventListener("click", async () => {
    const { error } = await sb.from("shopping_items").delete().eq("id", b.dataset.x);
    if (error) toast(errText(error)); else renderShopping();
  }));
  document.getElementById("clr")?.addEventListener("click", async () => {
    const { error } = await sb.from("shopping_items").delete().eq("household_id", S.hid).eq("checked", true);
    if (error) toast(errText(error)); else { toast("Kúpené položky odstránené"); renderShopping(); }
  });
  shopFirst = false;
}

/* ================= DOMÁCNOSŤ ================= */
async function viewDomacnost() {
  const tab = S.homeTab;
  const tabs = [["zariadenia", "Zariadenia"], ["nakupy", "Nákupy a záruky"], ["auta", "Autá"], ["poistenia", "Poistenia"]];
  const shell = (body, addLabel) => layout("domacnost", `
    <div class="head"><h1>Domácnosť</h1><button class="btn sm" id="add">${addLabel}</button></div>
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${k === tab}" data-tab="${k}">${l}</button>`).join("")}</div>
    ${body}`);
  shell('<p class="mut">Načítavam…</p>', "Pridať");
  const bindTabs = () => $app.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { S.homeTab = b.dataset.tab; location.hash = `#/domacnost/${b.dataset.tab}`; }));
  const nearest = (row, keys) => keys.map(([k, l]) => row[k] ? { d: row[k], l } : null).filter(Boolean).sort((a, b) => a.d.localeCompare(b.d))[0];

  if (tab === "zariadenia") {
    const { data, error } = await sb.from("devices").select("*").eq("household_id", S.hid).order("name");
    if (error) return shell(`<div class="err">${esc(errText(error))}</div>`, "Pridať zariadenie");
    shell(data.length ? `<div class="list">${data.map((x) => {
      const n = nearest(x, [["warranty_until", "záruka"], ["next_service_on", "servis"]]);
      return `<button class="row" data-id="${x.id}"><span class="tag k-zariadenie"></span><div class="main"><b>${esc(x.name)}</b><span>${esc([x.category, x.location, [x.manufacturer, x.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || "Bez podrobností")}</span></div>${n ? `<span class="sm mut">${n.l}</span>${pill(n.d)}` : ""}</button>`;
    }).join("")}</div>` : `<div class="card empty"><b>Zatiaľ žiadne zariadenia</b>Pridajte práčku, kotol či chladničku a uložte si záruku a termín servisu.</div>`, "Pridať zariadenie");
    bindTabs();
    $app.querySelectorAll("[data-id]").forEach((b) => b.addEventListener("click", () => editRecord(FORMS.device(), data.find((x) => x.id === b.dataset.id))));
    document.getElementById("add").onclick = () => editRecord(FORMS.device(), {});
  } else if (tab === "nakupy") {
    const { data, error } = await sb.from("purchases").select("*, attachments(count)").eq("household_id", S.hid);
    if (error) return shell(`<div class="err">${esc(errText(error))}</div>`, "Pridať nákup");
    const t = today();
    const active = data.filter((x) => x.warranty_until >= t).sort((a, b) => a.warranty_until.localeCompare(b.warranty_until));
    const gone = data.filter((x) => x.warranty_until < t).sort((a, b) => b.warranty_until.localeCompare(a.warranty_until));
    const row = (x) => {
      const n = daysTo(x.warranty_until), files = x.attachments?.[0]?.count || 0;
      const p = n < 0 ? `<span class="pill plain">záruka skončila</span>` : `<span class="pill ${n <= 30 ? "warn" : "ok"}">záruka do ${fmt(x.warranty_until)}</span>`;
      return `<button class="row" data-id="${x.id}"><span class="tag k-nakup"></span><div class="main"><b>${esc(x.name)}</b><span>${esc([x.store, `kúpené ${fmt(x.purchased_on)}`, files ? `${files} ${plural(files, "príloha", "prílohy", "príloh")}` : "bez bločku"].filter(Boolean).join(" · "))}</span></div>${p}</button>`;
    };
    shell(data.length ? `
      <p class="mut sm" style="margin:-4px 0 12px">Uložte si bloček alebo faktúru. Aplikácia vám 30 dní pred koncom záruky pripomenie, že ešte môžete reklamovať.</p>
      ${active.length ? `<div class="list">${active.map(row).join("")}</div>` : ""}
      ${gone.length ? `<section><h3 style="margin-bottom:8px">Po záruke</h3><div class="list">${gone.map(row).join("")}</div></section>` : ""}`
      : `<div class="card empty"><b>Zatiaľ žiadne nákupy</b>Pridajte tovar so zárukou, odfoťte bloček alebo faktúru a aplikácia bude strážiť koniec záruky.</div>`, "Pridať nákup");
    bindTabs();
    $app.querySelectorAll("[data-id]").forEach((b) => b.addEventListener("click", () => editPurchase(data.find((x) => x.id === b.dataset.id))));
    document.getElementById("add").onclick = () => editPurchase({});
  } else if (tab === "auta") {
    const { data, error } = await sb.from("vehicles").select("*").eq("household_id", S.hid).order("name");
    if (error) return shell(`<div class="err">${esc(errText(error))}</div>`, "Pridať auto");
    shell(data.length ? `<div class="list">${data.map((x) => {
      const n = nearest(x, [["stk_until", "STK"], ["ek_until", "EK"], ["vignette_until", "známka"], ["next_service_on", "servis"]]);
      return `<button class="row" data-id="${x.id}"><span class="tag k-auto"></span><div class="main"><b>${esc(x.name)}</b><span>${esc([x.plate, x.year_made].filter(Boolean).join(" · ") || "Bez podrobností")}</span></div>${n ? `<span class="sm mut">${n.l}</span>${pill(n.d)}` : ""}</button>`;
    }).join("")}</div>` : `<div class="card empty"><b>Zatiaľ žiadne autá</b>Pridajte auto a termíny STK, emisnej kontroly či diaľničnej známky sa zobrazia v kalendári.</div>`, "Pridať auto");
    bindTabs();
    $app.querySelectorAll("[data-id]").forEach((b) => b.addEventListener("click", () => editRecord(FORMS.vehicle(), data.find((x) => x.id === b.dataset.id))));
    document.getElementById("add").onclick = () => editRecord(FORMS.vehicle(), {});
  } else {
    const [{ data, error }, vehicles] = await Promise.all([sb.from("insurances").select("*").eq("household_id", S.hid).order("kind").order("name"), vehiclesList()]);
    if (error) return shell(`<div class="err">${esc(errText(error))}</div>`, "Pridať poistenie");
    const total = data.reduce((s, x) => {
      const per = { mesacne: 12, stvrtrocne: 4, polrocne: 2, rocne: 1 }[x.frequency];
      return s + (x.premium && per ? Number(x.premium) * per : 0);
    }, 0);
    const byKind = {};
    for (const x of data) (byKind[x.kind] ||= []).push(x);
    shell(data.length ? `
      ${total ? `<div class="card" style="margin-bottom:14px"><b style="font:800 1.4rem 'Bricolage Grotesque',sans-serif">${total.toLocaleString("sk-SK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</b><div class="mut sm">ročne za pravidelne platené poistenia</div></div>` : ""}
      ${Object.entries(byKind).map(([k, items]) => `<section><h3 style="margin-bottom:8px">${KIND_LABEL[k]}</h3><div class="list">${items.map((x) => {
        const who = [personName(x.person_id), vehicles.find((v) => v.id === x.vehicle_id)?.name].filter(Boolean).join(", ");
        return `<button class="row" data-id="${x.id}"><span class="tag k-poistenie"></span><div class="main"><b>${esc(x.name)}</b><span>${esc([x.insurer, who, x.premium ? `${Number(x.premium).toLocaleString("sk-SK", { minimumFractionDigits: 2 })} € ${FREQ.find((f) => f[0] === x.frequency)?.[1] || ""}` : ""].filter(Boolean).join(" · "))}</span></div>${x.valid_until ? pill(x.valid_until) : ""}</button>`;
      }).join("")}</div></section>`).join("")}`
      : `<div class="card empty"><b>Zatiaľ žiadne poistenia</b>Pridajte PZP, havarijné, životné či poistenie domácnosti a aplikácia vám pripomenie platby aj koniec zmluvy.</div>`, "Pridať poistenie");
    bindTabs();
    $app.querySelectorAll("[data-id]").forEach((b) => b.addEventListener("click", () => editRecord(FORMS.insurance(vehicles), data.find((x) => x.id === b.dataset.id))));
    document.getElementById("add").onclick = () => addInsurance();
  }
}

/* ================= ZDRAVIE ================= */
const VIS_LABEL = { ja: "Iba ja", spravcovia: "Ja a správcovia rodiny", vsetci: "Všetci v rodine", vybrani: "Vybraní členovia" };
async function viewZdravie() {
  loading("zdravie");
  if (!S.healthPerson || !S.persons.some((p) => p.id === S.healthPerson)) S.healthPerson = (S.persons.find((p) => p.user_id === S.user.id) || S.persons[0])?.id;
  const p = S.persons.find((x) => x.id === S.healthPerson);
  const tabs = `<div class="tabs" role="tablist">${S.persons.map((x) => `<button role="tab" aria-selected="${x.id === S.healthPerson}" data-p="${x.id}">${esc(x.name)}</button>`).join("")}</div>`;
  let body = "";
  let rows = [];
  if (!p) body = `<div class="card empty">V rodine zatiaľ nie sú žiadne osoby.</div>`;
  else if (!canSeeHealth(p)) body = `<div class="card empty"><b>Záznamy sú súkromné</b>${esc(p.name)} nezdieľa svoje zdravotné záznamy s vami.</div>`;
  else {
    const { data, error } = await sb.from("health_visits").select("*").eq("person_id", p.id).order("visit_on", { ascending: false });
    if (error) body = `<div class="err">${esc(errText(error))}</div>`;
    else {
      rows = data;
      const next = data.filter((x) => !x.done).sort((a, b) => a.visit_on.localeCompare(b.visit_on));
      const past = data.filter((x) => x.done);
      const visRow = (x, upcoming) => `<div class="row">
        <span class="tag k-zdravie"></span>
        ${upcoming ? `<button class="check" data-done="${x.id}" aria-label="Označiť ako absolvované"></button>` : ""}
        <button class="main" data-edit="${x.id}" style="background:none;border:0;text-align:left;padding:0;cursor:pointer"><b>${esc(x.title)}</b><span>${esc([fmt(x.visit_on), fmtTime(x.visit_time), x.doctor, x.place].filter(Boolean).join(" · "))}</span></button>
        ${upcoming ? pill(x.visit_on, 14) : ""}</div>`;
      body = `
        <div class="card" style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
          <div style="flex:1"><b>Kto vidí záznamy: ${esc(p.user_id ? VIS_LABEL[p.health_visibility] : p.health_visibility === "vsetci" ? "všetci v rodine" : p.health_visibility === "vybrani" ? "vybraní členovia" : "správcovia rodiny")}</b>
          <div class="mut sm">${p.user_id ? (p.user_id === S.user.id ? "Toto nastavenie meníte iba vy." : `Nastavuje ${esc(p.name)}.`) : "Osoba bez vlastného účtu – nastavuje správca."}</div></div>
          ${canSetHealth(p) ? '<button class="btn ghost sm" id="vis">Zmeniť</button>' : ""}
        </div>
        <section><div class="head"><h2>Naplánované</h2><button class="btn sm" id="addV">Pridať návštevu</button></div>
        ${next.length ? `<div class="list">${next.map((x) => visRow(x, true)).join("")}</div>` : `<div class="card empty">Žiadna naplánovaná návšteva. Pridajte preventívnu prehliadku, zubára či očkovanie.</div>`}</section>
        ${past.length ? `<section><h2 style="margin-bottom:10px">História</h2><div class="list">${past.map((x) => visRow(x, false)).join("")}</div></section>` : ""}`;
    }
  }
  layout("zdravie", `<div class="head"><h1>Zdravie</h1></div>${tabs}${body}`);
  $app.querySelectorAll("[data-p]").forEach((b) => b.addEventListener("click", () => { S.healthPerson = b.dataset.p; viewZdravie(); }));
  $app.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => editRecord(FORMS.visit(), rows.find((x) => x.id === b.dataset.edit))));
  $app.querySelectorAll("[data-done]").forEach((b) => b.addEventListener("click", () => markDone("health_visits", rows.find((x) => x.id === b.dataset.done))));
  document.getElementById("addV")?.addEventListener("click", () => editRecord(FORMS.visit(), { person_id: p.id, visit_on: today() }));
  document.getElementById("vis")?.addEventListener("click", () => editVisibility(p));
}
function editVisibility(p) {
  const own = !!p.user_id;
  const opts = own ? ["ja", "spravcovia", "vsetci", "vybrani"] : ["spravcovia", "vsetci", "vybrani"];
  const label = (o) => (own ? VIS_LABEL[o] : { spravcovia: "Iba správcovia rodiny", vsetci: "Všetci v rodine", vybrani: "Správcovia a vybraní členovia" }[o]);
  const help = { ja: "Nikto iný ich neuvidí.", spravcovia: own ? "Napr. rodič, ktorý spravuje rodinu." : "", vsetci: "Každý člen rodiny s účtom.", vybrani: "Zaškrtnite, komu ich ukážete." };
  const cur = !own && p.health_visibility === "ja" ? "spravcovia" : p.health_visibility;
  const others = S.members.filter((m) => m.user_id !== p.user_id);
  const chosen = new Set(p.health_viewer_ids || []);
  openSheet(`Kto vidí záznamy: ${p.name}`, `<form>
      ${opts.map((o) => `<label class="radio"><input type="radio" name="v" value="${o}"${o === cur ? " checked" : ""}><span>${esc(label(o))}${help[o] ? `<small>${esc(help[o])}</small>` : ""}</span></label>`).join("")}
      <div id="who" class="card ${cur === "vybrani" ? "" : "hidden"}" style="margin:6px 0 12px">
        ${others.length ? others.map((m) => `<label class="radio"><input type="checkbox" name="u" value="${m.user_id}"${chosen.has(m.user_id) ? " checked" : ""}><span>${esc(m.full_name || m.email)}</span></label>`).join("") : '<span class="mut">V rodine zatiaľ nie sú ďalší členovia s účtom.</span>'}
      </div>
      <div class="actions"><button class="btn">Uložiť</button></div></form>`, (el) => {
    const form = el.querySelector("form");
    form.addEventListener("change", () => el.querySelector("#who").classList.toggle("hidden", form.v.value !== "vybrani"));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = form.v.value; const users = [...form.querySelectorAll('[name="u"]:checked')].map((x) => x.value);
      const { error } = await sb.rpc("set_health_visibility", { p_person: p.id, p_visibility: v, p_viewers: users });
      if (error) return toast(errText(error));
      closeSheet(); toast("Nastavenie uložené"); await loadContext(); viewZdravie();
    });
  });
}

/* ================= UPOZORNENIA (web push) ================= */
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function b64ToU8(s) { const p = "=".repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }
function deviceName() {
  const u = navigator.userAgent;
  const os = /android/i.test(u) ? "Android" : isIOS ? "iPhone/iPad" : /windows/i.test(u) ? "Windows" : /mac/i.test(u) ? "Mac" : "zariadenie";
  const br = /edg\//i.test(u) ? "Edge" : /firefox/i.test(u) ? "Firefox" : /chrome/i.test(u) ? "Chrome" : /safari/i.test(u) ? "Safari" : "prehliadač";
  return `${br} · ${os}`;
}
async function pushState() {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}
async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Upozornenia ste v prehliadači nepovolili.");
  const reg = await navigator.serviceWorker.register("sw.js");
  await navigator.serviceWorker.ready;
  let key = (await sb.from("app_config").select("value").eq("key", "vapid_public").maybeSingle()).data?.value;
  if (!key) key = (await sb.functions.invoke("upozornenia", { body: { vapid: true } })).data?.publicKey;
  if (!key) throw new Error("Server upozornení neodpovedá. Skúste to neskôr.");
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(key) }));
  const j = sub.toJSON();
  const { error } = await sb.from("push_subscriptions").upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, device: deviceName() }, { onConflict: "endpoint" });
  if (error) throw error;
}
async function disablePush() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) { await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
}
const PUSH_RULES = `<ul class="rules">
  <li><b>Lekár</b> – jeden pracovný deň vopred</li>
  <li><b>Platba poistenia</b> – 20. deň v mesiaci pred splatnosťou</li>
  <li><b>Pripomienky</b> – v čase, ktorý si pri pripomienke nastavíte (napr. 2 hodiny vopred)</li>
  <li><b>STK a emisná kontrola</b> – 10 dní vopred</li>
  <li><b>Diaľničná známka</b> – ročná 7 dní vopred, kratšia 24 hodín pred koncom, 24-hodinová pri skončení platnosti</li>
  <li><b>Koniec poistenia</b> – 3 mesiace vopred</li>
  <li><b>Koniec záruky</b> – 30 dní vopred, <b>servis</b> – 7 dní vopred</li>
</ul><p class="mut sm">Pripomienky a známky chodia v presnom čase, ostatné upozornenia ráno o 7:00 – na všetky zariadenia, kde ich zapnete.</p>`;
async function renderPushCard(box) {
  if (!box) return;
  const st = await pushState();
  const set = (html) => { box.innerHTML = html; };
  if (st === "unsupported") {
    return set(isIOS && !isStandalone()
      ? `<b>Na iPhone najprv pridajte aplikáciu na plochu</b><p class="mut">V Safari klepnite na <b>Zdieľať</b> → <b>Pridať na plochu</b>. Potom otvorte Rodinu z plochy a tu zapnite upozornenia.</p>`
      : `<b>Tento prehliadač upozornenia nepodporuje</b><p class="mut">Skúste Chrome, Edge alebo Firefox.</p>`);
  }
  if (st === "denied") return set(`<b>Upozornenia sú v prehliadači zablokované</b><p class="mut">Kliknite na ikonu zámku vľavo v adresnom riadku → Upozornenia → Povoliť. Potom obnovte stránku.</p>`);
  if (st === "off") {
    set(`<b>Upozornenia sú na tomto zariadení vypnuté</b>${PUSH_RULES}<button class="btn wide" id="pOn">Zapnúť upozornenia</button>`);
    box.querySelector("#pOn").onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = "Zapínam…";
      try { await enablePush(); toast("Upozornenia zapnuté"); } catch (er) { toast(errText(er)); }
      renderPushCard(box);
    };
    return;
  }
  set(`<b>Upozornenia sú zapnuté na tomto zariadení</b>${PUSH_RULES}
    <div class="row" style="border:0;padding:6px 0 0;gap:8px;flex-wrap:wrap"><button class="btn" id="pTest">Poslať skúšobné upozornenie</button><button class="btn ghost" id="pOff">Vypnúť</button></div>`);
  box.querySelector("#pTest").onclick = async () => {
    const { data, error } = await sb.functions.invoke("upozornenia", { body: { test: true } });
    toast(error ? errText(error) : data?.sent ? "Odoslané – o chvíľu príde" : "Nepodarilo sa doručiť, skúste vypnúť a znova zapnúť");
  };
  box.querySelector("#pOff").onclick = async () => { await disablePush(); toast("Upozornenia vypnuté"); renderPushCard(box); };
}

/* ================= RODINA (nastavenia) ================= */
async function viewRodina() {
  loading("rodina");
  const h = S.households.find((x) => x.id === S.hid);
  let invites = [];
  if (isAdmin()) {
    const { data } = await sb.from("invitations").select("*").eq("household_id", S.hid).is("accepted_at", null).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false });
    invites = data || [];
  }
  const admins = S.members.filter((m) => m.role === "spravca").length;
  const noAccount = S.persons.filter((p) => !p.user_id);
  layout("rodina", `
    <div class="head"><div><h1>${esc(h?.name)}</h1><p class="mut sm">${h?.plan === "skusobny" ? `Skúšobné obdobie do ${fmt(h.trial_until)}` : ""}</p></div>
      ${isAdmin() ? '<button class="btn ghost sm" id="rename">Premenovať</button>' : ""}</div>

    <section><div class="head"><h2>Členovia s účtom</h2>${isAdmin() ? '<button class="btn sm" id="invite">Pozvať člena</button>' : ""}</div>
      <div class="list">${S.members.map((m) => `<div class="row"><div class="main"><b>${esc(m.full_name || m.email)}${m.user_id === S.user.id ? " (vy)" : ""}</b><span>${esc(m.email || "")}</span></div>
        <span class="pill ${m.role === "spravca" ? "warn" : "plain"}">${m.role === "spravca" ? "správca" : "člen"}</span>
        ${isAdmin() && m.user_id !== S.user.id ? `<button class="btn ghost sm" data-m="${m.user_id}">Upraviť</button>` : ""}</div>`).join("")}</div>
      ${invites.length ? `<h3 style="margin:16px 0 8px">Čakajúce pozvánky</h3><div class="list">${invites.map((i) => `<div class="row"><div class="main"><b>${esc(i.note || "Pozvánka")}</b><span>platí do ${fmt(i.expires_at)} · ${i.role === "spravca" ? "správca" : "člen"}</span></div>
        <button class="btn ghost sm" data-share="${i.token}">Poslať</button><button class="iconbtn" style="background:none;color:var(--mut)" data-delinv="${i.id}" aria-label="Zrušiť pozvánku">${ICON.x}</button></div>`).join("")}</div>` : ""}
    </section>

    <section><div class="head"><div><h2>Osoby bez účtu</h2><p class="mut sm">Deti či starí rodičia – môžete im viesť prehliadky a poistenia.</p></div>${isAdmin() ? '<button class="btn sm" id="addP">Pridať osobu</button>' : ""}</div>
      ${noAccount.length ? `<div class="list">${noAccount.map((p) => `<button class="row" data-p="${p.id}" ${isAdmin() ? "" : "disabled"}><div class="main"><b>${esc(p.name)}</b><span>${p.birth_date ? `nar. ${fmt(p.birth_date)}` : ""}</span></div></button>`).join("")}</div>` : `<div class="card empty">Zatiaľ nikto.</div>`}
    </section>

    <section><h2 style="margin-bottom:10px">Zámok aplikácie</h2><div class="card" id="lockBox"></div></section>

    <section><h2 style="margin-bottom:10px">Upozornenia</h2><div class="card" id="push"><span class="mut">Načítavam…</span></div></section>

    <section><h2 style="margin-bottom:10px">Môj účet</h2>
      <div class="list">
        <button class="row" id="me"><div class="main"><b>${esc(myName())}</b><span>${esc(S.user.email)}</span></div><span class="mut sm">Upraviť meno</span></button>
        <button class="row" id="newH"><div class="main"><b>Založiť ďalšiu rodinu</b><span>Napr. pre rodičov alebo chalupu</span></div></button>
        <button class="row" id="leave"><div class="main"><b style="color:var(--bad)">Opustiť túto rodinu</b></div></button>
        <button class="row" id="out"><div class="main"><b>Odhlásiť sa</b></div></button>
      </div>
      <p class="mut sm" style="margin-top:12px">Rodina ${APP_VERSION}</p>
    </section>`);

  document.getElementById("rename")?.addEventListener("click", () => promptSheet("Názov rodiny", h.name, async (v) => {
    const { error } = await sb.from("households").update({ name: v }).eq("id", S.hid); if (error) throw error;
    await loadHouseholds(); viewRodina();
  }));
  document.getElementById("invite")?.addEventListener("click", inviteSheet);
  $app.querySelectorAll("[data-share]").forEach((b) => b.addEventListener("click", () => shareInvite(b.dataset.share)));
  $app.querySelectorAll("[data-delinv]").forEach((b) => b.addEventListener("click", async () => {
    const { error } = await sb.from("invitations").delete().eq("id", b.dataset.delinv);
    if (error) toast(errText(error)); else { toast("Pozvánka zrušená"); viewRodina(); }
  }));
  $app.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => memberSheet(S.members.find((m) => m.user_id === b.dataset.m))));
  const personDef = { table: "persons", title: "Osoba", fields: [{ k: "name", l: "Meno", req: true }, { k: "birth_date", l: "Dátum narodenia", t: "date" }, { k: "note", l: "Poznámka", t: "textarea" }] };
  const reload = async () => { await loadContext(); viewRodina(); };
  document.getElementById("addP")?.addEventListener("click", () => editRecord(personDef, {}, reload));
  $app.querySelectorAll("[data-p]").forEach((b) => b.addEventListener("click", () => editRecord(personDef, S.persons.find((p) => p.id === b.dataset.p), reload)));
  document.getElementById("me").onclick = () => promptSheet("Vaše meno", myName(), async (v) => {
    const { error } = await sb.from("profiles").update({ full_name: v }).eq("id", S.user.id); if (error) throw error;
    S.profile.full_name = v; await loadContext(); viewRodina();
  });
  document.getElementById("newH").onclick = () => createHouseholdSheet();
  document.getElementById("leave").onclick = async () => {
    if (isAdmin() && admins === 1 && S.members.length > 1) return toast("Najprv urobte správcom niekoho iného");
    if (!confirm(`Naozaj opustiť rodinu „${h.name}“? Stratíte prístup k jej údajom.`)) return;
    const { error } = await sb.from("members").delete().eq("household_id", S.hid).eq("user_id", S.user.id);
    if (error) return toast(errText(error));
    store.set("rodina_hid", null); if (pushSupported()) navigator.serviceWorker.register("sw.js").catch(() => {});
start();
  };
  document.getElementById("out").onclick = async () => { try { await disablePush(); } catch {} await sb.auth.signOut(); };
  renderPushCard(document.getElementById("push"));
  lockSettings(document.getElementById("lockBox"));
}
function promptSheet(title, value, save) {
  openSheet(title, `<form><div class="err hidden"></div><label class="f">${esc(title)}<input name="v" value="${esc(value)}" required></label><div class="actions"><button class="btn">Uložiť</button></div></form>`, (el) => {
    const form = el.querySelector("form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); const v = form.v.value.trim(); if (!v) return;
      try { await save(v); closeSheet(); toast("Uložené"); } catch (er) { const x = el.querySelector(".err"); x.textContent = errText(er); x.classList.remove("hidden"); }
    });
  });
}
function memberSheet(m) {
  openSheet(m.full_name || m.email, `<form>
    <label class="radio"><input type="radio" name="r" value="clen"${m.role === "clen" ? " checked" : ""}><span>Člen<small>Vidí a upravuje spoločné údaje rodiny.</small></span></label>
    <label class="radio"><input type="radio" name="r" value="spravca"${m.role === "spravca" ? " checked" : ""}><span>Správca<small>Navyše pozýva a odoberá členov a spravuje osoby bez účtu.</small></span></label>
    <div class="actions"><button type="button" class="btn danger" id="rm">Odobrať z rodiny</button><button class="btn">Uložiť</button></div></form>`, (el) => {
    const form = el.querySelector("form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const { error } = await sb.from("members").update({ role: form.r.value }).eq("household_id", S.hid).eq("user_id", m.user_id);
      if (error) return toast(errText(error));
      closeSheet(); toast("Uložené"); await loadContext(); viewRodina();
    });
    el.querySelector("#rm").addEventListener("click", async () => {
      if (!confirm(`Odobrať ${m.full_name || m.email} z rodiny?`)) return;
      const { error } = await sb.from("members").delete().eq("household_id", S.hid).eq("user_id", m.user_id);
      if (error) return toast(errText(error));
      closeSheet(); toast("Člen odobratý"); await loadContext(); viewRodina();
    });
  });
}
const inviteUrl = (token) => `${location.origin}${location.pathname}#/pozvanka/${token}`;
function inviteSheet() {
  openSheet("Pozvať člena", `<form><div class="err hidden"></div>
    <label class="f">Pre koho je pozvánka<input name="note" placeholder="napr. Mama, Peter" required></label>
    <label class="radio"><input type="radio" name="r" value="clen" checked><span>Člen</span></label>
    <label class="radio"><input type="radio" name="r" value="spravca"><span>Správca</span></label>
    <p class="mut sm">Vytvorí sa odkaz platný 14 dní. Pošlete ho napr. cez WhatsApp alebo SMS. Po otvorení sa dotyčný zaregistruje a pripojí k rodine.</p>
    <div class="actions"><button class="btn">Vytvoriť pozvánku</button></div></form>`, (el) => {
    const form = el.querySelector("form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); const note = form.note.value.trim(); if (!note) return;
      const { data, error } = await sb.from("invitations").insert({ household_id: S.hid, note, role: form.r.value }).select("token").single();
      if (error) { const x = el.querySelector(".err"); x.textContent = errText(error); x.classList.remove("hidden"); return; }
      closeSheet(); shareInvite(data.token); viewRodina();
    });
  });
}
async function shareInvite(token) {
  const url = inviteUrl(token);
  const h = S.households.find((x) => x.id === S.hid);
  const text = `Pozývam ťa do našej rodiny „${h.name}“ v aplikácii Rodina:`;
  if (navigator.share) { try { await navigator.share({ title: "Pozvánka do aplikácie Rodina", text, url }); return; } catch (e) { if (e.name === "AbortError") return; } }
  openSheet("Pozvánka je pripravená", `<p>Skopírujte odkaz a pošlite ho:</p><input readonly value="${esc(url)}" id="lnk"><div class="actions" style="margin-top:12px"><button class="btn" id="cp">Kopírovať odkaz</button></div>`, (el) => {
    el.querySelector("#cp").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url); toast("Odkaz skopírovaný"); } catch { el.querySelector("#lnk").select(); }
    });
  });
}
function createHouseholdSheet() {
  openSheet("Nová rodina", `<form><div class="err hidden"></div>
    <label class="f">Názov rodiny<input name="name" placeholder="napr. Rodina Kunkovci" required></label>
    <div class="actions"><button class="btn">Založiť</button></div></form>`, (el) => {
    const form = el.querySelector("form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); const name = form.name.value.trim(); if (!name) return;
      const { data, error } = await sb.rpc("create_household", { p_name: name, p_my_name: myName() });
      if (error) { const x = el.querySelector(".err"); x.textContent = errText(error); x.classList.remove("hidden"); return; }
      closeSheet(); S.hid = data; store.set("rodina_hid", data); await loadHouseholds(); await loadContext(); location.hash = "#/prehlad"; route();
    });
  });
}

/* ================= ZÁMOK APLIKÁCIE (Face ID / odtlačok / 4-miestny kód) =================
   Zámok je na každom zariadení zvlášť. Kód sa ukladá iba ako odtlačok (PBKDF2), Face ID rieši priamo zariadenie. */
const LOCK_AFTER_MS = 60 * 1000;            // po minúte v pozadí sa aplikácia zamkne
const MAX_PIN_TRIES = 5;
const lockKey = () => `rodina_lock_${S.user.id}`;
const getLock = () => { try { return JSON.parse(store.get(lockKey()) || "null"); } catch { return null; } };
const setLock = (v) => store.set(lockKey(), v ? JSON.stringify(v) : null);
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (x) => Uint8Array.from(atob(x), (c) => c.charCodeAt(0));
async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return toB64(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: fromB64(salt), iterations: 150000, hash: "SHA-256" }, key, 256));
}
async function bioAvailable() {
  try { return !!window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch { return false; }
}
const bioLabel = () => {
  const u = navigator.userAgent;
  return isIOS ? "Face ID" : /android/i.test(u) ? "odtlačok prsta" : /windows/i.test(u) ? "Windows Hello" : /mac/i.test(u) ? "Touch ID" : "biometriu";
};
async function bioEnroll() {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { name: "Rodina", id: location.hostname },
    user: { id: new TextEncoder().encode(S.user.id).slice(0, 64), name: S.user.email, displayName: myName() || S.user.email },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
    timeout: 60000, attestation: "none",
  } });
  return toB64(cred.rawId);
}
async function bioVerify(credId) {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, timeout: 60000,
    allowCredentials: [{ type: "public-key", id: fromB64(credId), transports: ["internal"] }], userVerification: "required",
  } });
  return !!a && (new Uint8Array(a.response.authenticatorData)[32] & 0x04) !== 0; // príznak „používateľ overený“
}
function pinPad(title, sub, { bio, onBio, links = "" } = {}) {
  authShell(`<div class="lock"><h2>${esc(title)}</h2><p class="mut" id="lsub">${esc(sub)}</p>
    <div class="dots4" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <div class="err hidden" id="lerr"></div>
    <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-k="${n}">${n}</button>`).join("")}
      ${bio ? `<button type="button" class="bio" id="bioBtn" aria-label="Odomknúť cez ${esc(bioLabel())}">${ICON.face}</button>` : "<span></span>"}
      <button type="button" data-k="0">0</button><button type="button" data-k="del" aria-label="Zmazať">⌫</button></div>
    ${links}</div>`);
  if (bio) document.getElementById("bioBtn").onclick = onBio;
}
function readPin(onFull) {
  let pin = "";
  const dots = () => document.querySelectorAll(".dots4 i").forEach((d, i) => d.classList.toggle("on", i < pin.length));
  const press = (k) => {
    if (k === "del") pin = pin.slice(0, -1); else if (pin.length < 4 && /^\d$/.test(k)) pin += k;
    dots();
    if (pin.length === 4) { const p = pin; pin = ""; setTimeout(() => { dots(); onFull(p); }, 120); }
  };
  document.querySelectorAll("[data-k]").forEach((b) => b.addEventListener("click", () => press(b.dataset.k)));
  const kb = (e) => { if (!document.querySelector(".dots4")) return document.removeEventListener("keydown", kb); if (/^\d$/.test(e.key)) press(e.key); if (e.key === "Backspace") press("del"); };
  document.addEventListener("keydown", kb);
}
const lockErr = (m) => { const e = document.getElementById("lerr"); e.textContent = m; e.classList.remove("hidden"); document.querySelector(".dots4")?.classList.add("shake"); setTimeout(() => document.querySelector(".dots4")?.classList.remove("shake"), 400); };

/** Prvé nastavenie zámku na tomto zariadení: kód (vždy, ako záloha) + Face ID, ak ho zariadenie má. */
function setupLock() {
  return new Promise((resolve) => {
    pinPad("Zabezpečte aplikáciu", "Zvoľte 4-miestny kód na odomykanie na tomto zariadení.");
    let first = null;
    readPin(async (p) => {
      if (!first) { first = p; document.getElementById("lsub").textContent = "Zadajte kód ešte raz pre kontrolu."; document.getElementById("lerr").classList.add("hidden"); return; }
      if (p !== first) { first = null; document.getElementById("lsub").textContent = "Zvoľte 4-miestny kód."; return lockErr("Kódy sa nezhodujú, skúste znova."); }
      const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
      const lock = { salt, hash: await hashPin(p, salt), tries: 0 };
      setLock(lock);
      if (await bioAvailable()) {
        authShell(`<div class="lock"><h2>Odomykať cez ${esc(bioLabel())}?</h2>
          <p class="mut">Aplikácia sa otvorí rýchlo a bezpečne. Kód zostane ako záloha.</p>
          <div class="err hidden" id="lerr"></div>
          <button class="btn wide" id="bioYes">Zapnúť ${esc(bioLabel())}</button>
          <div class="switch"><button class="linkbtn" id="bioNo">Stačí mi kód</button></div></div>`);
        document.getElementById("bioNo").onclick = () => { S.unlocked = true; resolve(); };
        document.getElementById("bioYes").onclick = async () => {
          try { lock.cred = await bioEnroll(); setLock(lock); toast(`${bioLabel()} zapnuté`); S.unlocked = true; resolve(); }
          catch (e) { const x = document.getElementById("lerr"); x.textContent = `${bioLabel()} sa nepodarilo zapnúť. Skúste znova alebo použite kód.`; x.classList.remove("hidden"); }
        };
      } else { S.unlocked = true; toast("Kód nastavený"); resolve(); }
    });
  });
}
/** Zamknutá obrazovka – Face ID alebo kód. */
function lockScreen() {
  return new Promise((resolve) => {
    const lock = getLock();
    const done = () => { lock.tries = 0; setLock(lock); S.unlocked = true; resolve(); };
    const tryBio = async () => { try { if (await bioVerify(lock.cred)) done(); } catch { /* zrušené – zostáva kód */ } };
    pinPad("Rodina je zamknutá", lock.cred ? `Odomknite cez ${bioLabel()} alebo zadajte kód.` : "Zadajte 4-miestny kód.", {
      bio: !!lock.cred, onBio: tryBio,
      links: `<div class="switch"><button class="linkbtn" id="forgot">Zabudol som kód – prihlásiť sa heslom</button></div>`,
    });
    document.getElementById("forgot").onclick = async () => { setLock(null); try { await disablePush(); } catch {} await sb.auth.signOut(); };
    readPin(async (p) => {
      if ((await hashPin(p, lock.salt)) === lock.hash) return done();
      lock.tries = (lock.tries || 0) + 1; setLock(lock);
      const left = MAX_PIN_TRIES - lock.tries;
      if (left <= 0) { setLock(null); toast("Príliš veľa pokusov – prihláste sa heslom"); try { await disablePush(); } catch {} await sb.auth.signOut(); return; }
      lockErr(`Nesprávny kód. ${left === 1 ? "Ostáva posledný pokus." : `Ostávajú ${left} pokusy.`}`);
    });
    if (lock.cred) tryBio();
  });
}
let hiddenAt = 0;
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (S.user && S.unlocked && getLock() && hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) {
    S.unlocked = false; closeSheet(); await lockScreen(); route();
  }
});
function lockSettings(box) {
  if (!box) return;
  const lock = getLock();
  box.innerHTML = `<b>${lock?.cred ? `Odomykanie cez ${esc(bioLabel())} a kód` : "Odomykanie 4-miestnym kódom"}</b>
    <p class="mut sm">Aplikácia sa zamkne pri otvorení a po minúte v pozadí. Nastavenie platí iba pre toto zariadenie.</p>
    <div class="row" style="border:0;padding:0;gap:8px;flex-wrap:wrap">
      <button class="btn ghost sm" id="lPin">Zmeniť kód</button>
      <span id="lBioWrap"></span></div>`;
  box.querySelector("#lPin").onclick = async () => { setLock(null); await setupLock(); route(); };
  bioAvailable().then((ok) => {
    if (!ok || !lock) return;
    const w = box.querySelector("#lBioWrap");
    w.innerHTML = lock.cred ? `<button class="btn ghost sm" id="lBio">Vypnúť ${esc(bioLabel())}</button>` : `<button class="btn sm" id="lBio">Zapnúť ${esc(bioLabel())}</button>`;
    w.querySelector("#lBio").onclick = async () => {
      if (lock.cred) { delete lock.cred; setLock(lock); toast(`${bioLabel()} vypnuté`); }
      else { try { lock.cred = await bioEnroll(); setLock(lock); toast(`${bioLabel()} zapnuté`); } catch { toast(`${bioLabel()} sa nepodarilo zapnúť`); } }
      lockSettings(box);
    };
  });
}

/* ================= prihlásenie ================= */
function authShell(inner) {
  $app.innerHTML = `<div class="auth"><div class="box">
    <div class="logo"><img class="mark" src="logo.png" alt="" width="64" height="64"><div><h1>Rodina</h1><div class="mut sm">Spoločný prehľad celej domácnosti</div></div></div>
    ${inner}</div></div>`;
}
async function viewAuth(mode = "login") {
  const token = store.get("rodina_invite");
  let inviteNote = "";
  if (token) {
    const { data } = await sb.rpc("invitation_info", { p_token: token });
    const i = data?.[0];
    inviteNote = i ? (i.valid ? `<div class="note">Boli ste pozvaný do rodiny <b>${esc(i.household_name)}</b>. Zaregistrujte sa alebo sa prihláste a pripojíte sa.</div>` : `<div class="err">Táto pozvánka už nie je platná. Požiadajte o novú.</div>`) : "";
  }
  const forms = {
    login: `<h2 style="margin-bottom:14px">Prihlásenie</h2>
      <label class="f">E-mail<input name="email" type="email" autocomplete="email" required></label>
      <label class="f">Heslo<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn wide">Prihlásiť sa</button>
      <div class="switch"><button type="button" class="linkbtn" data-mode="signup">Nemám účet – registrovať sa</button><br><button type="button" class="linkbtn" data-mode="reset">Zabudol som heslo</button></div>`,
    signup: `<h2 style="margin-bottom:14px">Registrácia</h2>
      <label class="f">Meno a priezvisko<input name="name" autocomplete="name" required></label>
      <label class="f">E-mail<input name="email" type="email" autocomplete="email" required></label>
      <label class="f">Heslo (aspoň 8 znakov)<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <button class="btn wide">Zaregistrovať sa</button>
      <div class="switch"><button type="button" class="linkbtn" data-mode="login">Už mám účet – prihlásiť sa</button></div>`,
    reset: `<h2 style="margin-bottom:6px">Obnova hesla</h2><p class="mut">Pošleme vám e-mail s odkazom na nastavenie nového hesla.</p>
      <label class="f">E-mail<input name="email" type="email" autocomplete="email" required></label>
      <button class="btn wide">Poslať odkaz</button>
      <div class="switch"><button type="button" class="linkbtn" data-mode="login">Späť na prihlásenie</button></div>`,
    newpass: `<h2 style="margin-bottom:14px">Nové heslo</h2>
      <label class="f">Nové heslo (aspoň 8 znakov)<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <button class="btn wide">Uložiť heslo</button>`,
  };
  const linkNote = AUTH_LINK_ERROR && mode === "login" ? `<div class="note">${esc(AUTH_LINK_ERROR)}</div>` : "";
  authShell(`${linkNote}${inviteNote}<form id="af" novalidate><div class="err hidden"></div><div class="note hidden" id="ok"></div>${forms[mode]}</form>`);
  const form = document.getElementById("af"), err = form.querySelector(".err"), ok = form.querySelector("#ok");
  form.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => viewAuth(b.dataset.mode)));
  form.querySelector("input")?.focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); err.classList.add("hidden");
    const v = Object.fromEntries(new FormData(form));
    const fail = (m) => { err.textContent = m; err.classList.remove("hidden"); btn.disabled = false; };
    const btn = form.querySelector(".btn"); btn.disabled = true;
    const redirect = location.origin + location.pathname;
    if (mode !== "newpass" && !/^\S+@\S+\.\S+$/.test(v.email || "")) return fail("Zadajte platný e-mail.");
    if ((mode === "signup" || mode === "newpass") && (v.password || "").length < 8) return fail("Heslo musí mať aspoň 8 znakov.");
    if (mode === "signup" && !v.name.trim()) return fail("Zadajte svoje meno.");
    try {
      if (mode === "login") {
        S.unlocked = true; // práve zadal heslo – netreba hneď aj kód
        const { error } = await sb.auth.signInWithPassword({ email: v.email, password: v.password }); if (error) throw error;
      } else if (mode === "signup") {
        const { data, error } = await sb.auth.signUp({ email: v.email, password: v.password, options: { data: { full_name: v.name.trim() }, emailRedirectTo: redirect } });
        if (error) throw error;
        if (!data.session) { ok.innerHTML = `Takmer hotovo. Na <b>${esc(v.email)}</b> sme poslali e-mail. Otvorte v ňom odkaz na potvrdenie – aplikácia sa potom otvorí už prihlásená. Ak e-mail neprišiel, pozrite aj priečinok Spam.`; ok.classList.remove("hidden"); btn.disabled = false; }
      } else if (mode === "reset") {
        const { error } = await sb.auth.resetPasswordForEmail(v.email, { redirectTo: redirect }); if (error) throw error;
        ok.textContent = "Ak je e-mail zaregistrovaný, poslali sme naň odkaz na nové heslo."; ok.classList.remove("hidden"); btn.disabled = false;
      } else if (mode === "newpass") {
        const { error } = await sb.auth.updateUser({ password: v.password }); if (error) throw error;
        S.recovery = false; toast("Heslo zmenené"); start();
      }
    } catch (er) { fail(errText(er)); }
  });
}

/* ================= prvé spustenie / pozvánka ================= */
function viewOnboarding() {
  authShell(`<h2 style="margin-bottom:6px">Vitajte, ${esc(myName().split(" ")[0])}</h2>
    <p class="mut">Založte svoju rodinu. Členov pozvete hneď potom.</p>
    <form id="of"><div class="err hidden"></div>
      <label class="f">Názov rodiny<input name="name" placeholder="napr. Rodina Kunkovci" required></label>
      <button class="btn wide">Založiť rodinu</button></form>
    <p class="mut sm" style="margin-top:14px">Dostali ste pozvánku? Otvorte odkaz z pozvánky.</p>
    <div class="switch"><button class="linkbtn" id="out">Odhlásiť sa</button></div>`);
  document.getElementById("out").onclick = () => sb.auth.signOut();
  const form = document.getElementById("of");
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); const name = form.name.value.trim(); if (!name) return;
    const { data, error } = await sb.rpc("create_household", { p_name: name, p_my_name: myName() });
    if (error) { const x = form.querySelector(".err"); x.textContent = errText(error); x.classList.remove("hidden"); return; }
    S.hid = data; store.set("rodina_hid", data); location.hash = "#/rodina"; start();
  });
}
async function acceptInvite(token) {
  const { data: info } = await sb.rpc("invitation_info", { p_token: token });
  const i = info?.[0];
  if (!i) { store.set("rodina_invite", null); toast("Pozvánka neexistuje"); return false; }
  return new Promise((resolve) => {
    authShell(`<h2 style="margin-bottom:6px">Pozvánka do rodiny</h2>
      <p>Pripojiť sa k rodine <b>${esc(i.household_name)}</b>?</p>
      <form id="ia"><div class="err hidden"></div>
        <label class="f">Vaše meno v rodine<input name="name" value="${esc(myName())}" required></label>
        <button class="btn wide">Pripojiť sa</button></form>
      <div class="switch"><button class="linkbtn" id="no">Teraz nie</button></div>`);
    document.getElementById("no").onclick = () => { store.set("rodina_invite", null); resolve(false); };
    const form = document.getElementById("ia");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const { data, error } = await sb.rpc("accept_invitation", { p_token: token, p_my_name: form.name.value.trim() });
      if (error) { const x = form.querySelector(".err"); x.textContent = errText(error); x.classList.remove("hidden"); return; }
      store.set("rodina_invite", null); S.hid = data; store.set("rodina_hid", data); toast(`Vitajte v rodine ${i.household_name}`); resolve(true);
    });
  });
}

/* ================= načítanie údajov ================= */
async function loadHouseholds() {
  const { data, error } = await sb.from("households").select("*").order("created_at");
  if (error) throw error;
  S.households = data;
}
async function loadContext() {
  const [m, p] = await Promise.all([
    sb.from("members").select("user_id,role,joined_at").eq("household_id", S.hid),
    sb.from("persons").select("*").eq("household_id", S.hid).order("created_at"),
  ]);
  if (m.error) throw m.error;
  const ids = m.data.map((x) => x.user_id);
  const { data: profs } = await sb.from("profiles").select("id,full_name,email").in("id", ids);
  S.members = m.data.map((x) => ({ ...x, ...(profs || []).find((pr) => pr.id === x.user_id) }));
  S.role = m.data.find((x) => x.user_id === S.user.id)?.role || null;
  S.persons = p.data || [];
  subscribeShopping();
}

/* ================= smerovanie ================= */
const currentView = () => (location.hash.replace(/^#\/?/, "").split("/")[0] || "prehlad");
const currentSub = () => location.hash.replace(/^#\/?/, "").split("/")[1] || "";
const VIEWS = { prehlad: viewPrehlad, kalendar: viewKalendar, nakup: viewNakup, domacnost: viewDomacnost, zdravie: viewZdravie, rodina: viewRodina };
function route() {
  if (!S.user || !S.hid || !S.unlocked) return;
  closeSheet();
  const v = currentView();
  if (v === "domacnost" && currentSub()) S.homeTab = currentSub();
  (VIEWS[v] || viewPrehlad)();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", () => {
  const m = location.hash.match(/^#\/pozvanka\/([a-f0-9]+)/);
  if (m) { store.set("rodina_invite", m[1]); start(); return; }
  route();
});

let starting = false;
async function start() {
  if (starting) return; starting = true;
  try {
    const m = location.hash.match(/^#\/pozvanka\/([a-f0-9]+)/);
    if (m) { store.set("rodina_invite", m[1]); history.replaceState(null, "", location.pathname + "#/prehlad"); }
    const { data: { session } } = await sb.auth.getSession();
    S.session = session; S.user = session?.user || null;
    if (S.recovery && S.user) return viewAuth("newpass");
    if (!S.user) { S.unlocked = false; if (S.channel) { sb.removeChannel(S.channel); S.channel = null; } return viewAuth(store.get("rodina_invite") && !AUTH_LINK_ERROR ? "signup" : "login"); }
    const { data: prof } = await sb.from("profiles").select("*").eq("id", S.user.id).maybeSingle();
    S.profile = prof || { full_name: S.user.user_metadata?.full_name || "" };
    if (!getLock()) { starting = false; await setupLock(); starting = true; }
    else if (!S.unlocked) { starting = false; await lockScreen(); starting = true; }
    const token = store.get("rodina_invite");
    if (token) { starting = false; await acceptInvite(token); starting = true; }
    await loadHouseholds();
    if (!S.households.length) return viewOnboarding();
    const saved = store.get("rodina_hid");
    S.hid = S.households.some((x) => x.id === S.hid) ? S.hid : S.households.some((x) => x.id === saved) ? saved : S.households[0].id;
    store.set("rodina_hid", S.hid);
    await loadContext();
    route();
  } catch (e) {
    $app.innerHTML = `<div class="auth"><div class="box"><h2>Niečo sa pokazilo</h2><p class="err">${esc(errText(e))}</p><button class="btn" onclick="location.reload()">Skúsiť znova</button></div></div>`;
  } finally { starting = false; }
}

sb.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") S.recovery = true;
  if (["SIGNED_IN", "SIGNED_OUT", "PASSWORD_RECOVERY"].includes(event)) setTimeout(() => { if (event !== "SIGNED_IN" || !S.user) start(); }, 0);
});
start();
