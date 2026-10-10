// Ghana Life server v2: accounts, presence, messages, payments and admin dashboard.
// Node 18+, no dependencies.
// Run: PAYSTACK_SECRET_KEY=sk_xxx ADMIN_KEY=a-long-secret DATA_DIR=/var/data node ghana-life-server.js
// Then open https://YOUR-SERVER/admin and enter your ADMIN_KEY.
// Put it behind HTTPS, set ALLOWED_ORIGIN to your game site, and keep DATA_DIR on a persistent disk.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000, SECRET = process.env.PAYSTACK_SECRET_KEY, ADMIN = process.env.ADMIN_KEY, ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const FILE = path.join(process.env.DATA_DIR || ".", "ghana-life-data.json");
const AD_PRICE = 200, AD_SLOTS = 30;
const BANNER_DIR = path.join(process.env.DATA_DIR || ".", "banners");
try { fs.mkdirSync(BANNER_DIR, { recursive: true }); } catch (e) {}
const BUNDLES = { starter: [10, 1000], hustler: [50, 6000], campaign: [100, 14000], kingmaker: [200, 32000] }; // [real GHS, game cedis]

let db = { users: {}, sessions: {}, messages: [], purchases: [], ads: [], reports: [], used: [], visits: 0 };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, "utf8"))); } catch (e) {}
let dirty = false;
const persist = () => { dirty = true; };
setInterval(() => { if (!dirty) return; dirty = false; const tmp = FILE + ".tmp"; fs.writeFile(tmp, JSON.stringify(db), err => { if (!err) fs.rename(tmp, FILE, () => {}); }); }, 2000);
const presence = {}; // username -> last position and look, kept in memory only

function send(res, code, obj, type) {
  res.writeHead(code, { "Content-Type": type || "application/json", "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Headers": "Content-Type,Authorization,x-admin-key", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
  res.end(type ? obj : JSON.stringify(obj));
}
function body(req) { return new Promise(r => { let d = ""; req.on("data", c => { d += c; if (d.length > 300000) req.destroy(); }); req.on("end", () => { try { r(JSON.parse(d)); } catch (e) { r({}); } }); }); }
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
function authUser(req) { const h = req.headers.authorization || ""; const t = h.startsWith("Bearer ") ? h.slice(7) : ""; const s = db.sessions[t]; return s && s.exp > Date.now() ? s.user : null; }
const rate = {};
function limited(key, max, ms) { const n = Date.now(); const a = (rate[key] = (rate[key] || []).filter(t => n - t < ms)); if (a.length >= max) return true; a.push(n); return false; }
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const isAdmin = req => ADMIN && req.headers["x-admin-key"] === ADMIN;
function newSession(user) { const t = crypto.randomBytes(24).toString("hex"); db.sessions[t] = { user, exp: Date.now() + 30 * 864e5 }; persist(); return t; }
const online = u => presence[u] && presence[u].t > Date.now() - 45000;
const pub = (u, name) => { const x = db.users[u], s = x.summary || {}; return { username: u, name: s.name || u, region: s.region, role: s.role, look: s.look, online: !!online(u) }; };
const slotBusy = (slot, n) => db.ads.some(a => a.slot === slot && (a.status === "pending" || (a.status === "live" && a.expires > n)));
function slotList() { const n = Date.now(); return Array.from({ length: AD_SLOTS }, (_, i) => { const a = db.ads.find(x => x.slot === i && (x.status === "pending" || (x.status === "live" && x.expires > n))); return { slot: i, free: !a, biz: a ? a.biz : "", until: a && a.status === "live" ? a.expires : 0 }; }); }
const blocked = (a, b) => (db.users[a].blocks || []).includes(b) || (db.users[b].blocks || []).includes(a);

async function verify(req, res) {
  const me = authUser(req), { reference, kind, payload = {} } = await body(req);
  if (!reference || db.used.includes(reference)) return send(res, 200, { ok: false });
  if (!SECRET) return send(res, 200, { ok: false });
  const r = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference), { headers: { Authorization: "Bearer " + SECRET } });
  const j = await r.json();
  if (!j.status || j.data.status !== "success" || j.data.currency !== "GHS") return send(res, 200, { ok: false });
  const paid = j.data.amount / 100, email = clean(j.data.customer && j.data.customer.email, 80);
  if (kind === "bundle") {
    const b = BUNDLES[payload.id];
    if (!me || !b || paid < b[0]) return send(res, 200, { ok: false });
    db.used.push(reference); db.purchases.push({ ref: reference, kind: "bundle", user: me, ghs: paid, cedis: b[1], email, ts: Date.now() }); persist();
    return send(res, 200, { ok: true, cedis: b[1] });
  }
  if (kind === "ad") {
    const days = Math.floor(Number(payload.days)), biz = clean(payload.biz, 28), slogan = clean(payload.slogan, 60), n = Date.now();
    if (!(days >= 1 && days <= 30) || paid < days * AD_PRICE || !biz || !slogan) return send(res, 200, { ok: false });
    const color = /^#[0-9a-fA-F]{6}$/.test(payload.color) ? payload.color : "#2f6fd0";
    const banner = /^[a-f0-9]{12}$/.test(String(payload.banner || "")) ? String(payload.banner) : "";
    let slot = Math.floor(Number(payload.slot)); if (!(slot >= 0 && slot < AD_SLOTS) || slotBusy(slot, n)) { slot = -1; for (let i = 0; i < AD_SLOTS; i++) if (!slotBusy(i, n)) { slot = i; break; } }
    db.used.push(reference); db.purchases.push({ ref: reference, kind: "ad", user: me || "", ghs: paid, days, biz, email, ts: n });
    if (slot < 0) { db.ads.push({ id: reference, biz, slogan, color, days, slot: -1, banner, status: "refund", expires: 0, paidGHS: paid, email, ts: n }); persist(); return send(res, 200, { ok: false, error: "All billboards are booked. Contact support for a refund with reference " + reference + "." }); }
    db.ads.push({ id: reference, biz, slogan, color, days, slot, banner, status: "pending", expires: 0, paidGHS: paid, email, ts: n }); persist();
    return send(res, 200, { ok: true, slot });
  }
  send(res, 200, { ok: false });
}

function stats() {
  const n = Date.now(), day = 864e5, start = new Date(); start.setHours(0, 0, 0, 0);
  const us = Object.values(db.users), sum = k => us.reduce((s, u) => s + (Number((u.summary || {})[k]) || 0), 0);
  const rev = (from, kind) => db.purchases.filter(p => p.ts >= from && (!kind || p.kind === kind)).reduce((s, p) => s + p.ghs, 0);
  return {
    totalPlayers: us.length, visits: db.visits || 0, onlineNow: Object.keys(presence).filter(online).length,
    activeToday: us.filter(u => u.lastSeen >= start.getTime()).length, active7d: us.filter(u => u.lastSeen >= n - 7 * day).length,
    newToday: us.filter(u => u.createdAt >= start.getTime()).length,
    cashCirculating: sum("cash"), netWorthTotal: sum("net"), cedisSold: db.purchases.reduce((s, p) => s + (p.cedis || 0), 0),
    revenueBundles: rev(0, "bundle"), revenueAds: rev(0, "ad"), revenueTotal: rev(0), revenueToday: rev(start.getTime()), revenue7d: rev(n - 7 * day),
    messagesSent: db.messages.length, openReports: db.reports.length,
    purchases: db.purchases.slice(-20).reverse(), ads: db.ads.slice(-60).reverse().map(a => ({ id: a.id, biz: a.biz, days: a.days, slot: a.slot, banner: a.banner, status: a.status, paidGHS: a.paidGHS, expires: a.expires })),
    reports: db.reports.slice(-20).reverse()
  };
}

const DASH = '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Ghana Life admin</title>' +
'<style>body{font-family:system-ui,sans-serif;background:#0A3D2A;color:#fff;margin:0;padding:16px}h1{color:#FCD116;margin:0 0 12px}h2{margin:18px 0 6px}.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.c{background:#fff;color:#111;border-radius:10px;padding:12px;font-size:13px}.c b{display:block;font-size:22px;margin-top:2px}table{width:100%;border-collapse:collapse;background:#fff;color:#111;font-size:13px}td,th{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left}button{padding:6px 10px}small{opacity:.7}</style>' +
'<h1>Ghana Life admin</h1><div id=o>Loading...</div><script>' +
'var key=sessionStorage.getItem("k")||prompt("Admin key");sessionStorage.setItem("k",key||"");' +
'function el(t,x){var e=document.createElement(t);if(x!=null)e.textContent=x;return e}' +
'function money(n){return "GH\\u20b5"+Number(n).toLocaleString()}function num(n){return Number(n).toLocaleString()}' +
'function card(g,l,v){var c=el("div");c.className="c";c.append(el("span",l),el("b",v));g.append(c)}' +
'function table(h,rows){var t=el("table"),r=el("tr");h.forEach(function(x){r.append(el("th",x))});t.append(r);rows.forEach(function(row){var tr=el("tr");row.forEach(function(c){var td=el("td");if(c instanceof Node)td.append(c);else td.textContent=c;tr.append(td)});t.append(tr)});return t}' +
'function act(k,id){fetch("/admin/"+k,{method:"POST",headers:{"x-admin-key":key,"Content-Type":"application/json"},body:JSON.stringify({id:id})}).then(load)}' +
'function render(s){var o=document.getElementById("o");o.textContent="";var g=el("div");g.className="g";' +
'card(g,"Players ever",num(s.totalPlayers));card(g,"Site visits",num(s.visits));card(g,"Online now",num(s.onlineNow));card(g,"Active today",num(s.activeToday));card(g,"Active 7 days",num(s.active7d));card(g,"New today",num(s.newToday));' +
'card(g,"Game cash circulating",num(s.cashCirculating));card(g,"Total net worth",num(s.netWorthTotal));card(g,"Game cedis sold",num(s.cedisSold));' +
'card(g,"Revenue today",money(s.revenueToday));card(g,"Revenue 7 days",money(s.revenue7d));card(g,"Bundle revenue",money(s.revenueBundles));card(g,"Billboard revenue",money(s.revenueAds));card(g,"Total revenue",money(s.revenueTotal));card(g,"Messages sent",num(s.messagesSent));card(g,"Reports",num(s.openReports));o.append(g);' +
'o.append(el("small","Revenue is before Paystack fees. Game cash and net worth are reported by players\' browsers."));' +
'o.append(el("h2","Recent purchases"));o.append(table(["When","Type","Player","Paid","Detail"],s.purchases.map(function(p){return [new Date(p.ts).toLocaleString(),p.kind,p.user||"-",money(p.ghs),p.kind=="bundle"?num(p.cedis)+" cedis":(p.biz+" ("+p.days+" days)")]})));' +
'o.append(el("h2","Billboard ads (30 slots)"));o.append(table(["Slot","Banner","Business","Days","Paid","Status",""],s.ads.map(function(a){var im="";if(a.banner){im=el("img");im.src="/banner/"+a.banner;im.style.width="90px"}var b=el("span");if(a.status=="pending"){var y=el("button","Approve");y.onclick=function(){act("approve",a.id)};var r=el("button","Reject");r.onclick=function(){act("reject",a.id)};b.append(y,r)}return [a.slot>=0?"#"+(a.slot+1):"-",im,a.biz,a.days,money(a.paidGHS),a.status+(a.expires?" until "+new Date(a.expires).toLocaleDateString():""),b]})));' +
'o.append(el("h2","Reports"));o.append(table(["When","From","Player","Reason"],s.reports.map(function(r){return [new Date(r.ts).toLocaleString(),r.from,r.user,r.reason]})))}' +
'function load(){fetch("/admin/stats",{headers:{"x-admin-key":key}}).then(function(r){return r.json()}).then(function(s){if(s.error){document.getElementById("o").textContent="Wrong key. Reload to try again.";sessionStorage.removeItem("k");return}render(s)})}' +
'load();setInterval(load,15000)</script>';

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"), p = url.pathname, ip = req.socket.remoteAddress || "";
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (req.method === "GET" && p === "/public-stats") {
      if (url.searchParams.get("visit")) { db.visits = (db.visits || 0) + 1; persist(); }
      return send(res, 200, { online: Object.keys(presence).filter(online).length, players: Object.keys(db.users).length, visits: db.visits || 0 });
    }
    if (req.method === "GET" && p === "/admin") return send(res, 200, DASH, "text/html; charset=utf-8");
    if (req.method === "GET" && p === "/admin/stats") return isAdmin(req) ? send(res, 200, stats()) : send(res, 401, { error: "no" });
    if (req.method === "POST" && p === "/admin/reject") {
      if (!isAdmin(req)) return send(res, 401, { error: "no" });
      const rid = (await body(req)).id, a = db.ads.find(x => x.id === rid); if (!a) return send(res, 404, { ok: false });
      a.status = "rejected"; persist(); return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/admin/approve") {
      if (!isAdmin(req)) return send(res, 401, { error: "no" });
      const aid = (await body(req)).id, a = db.ads.find(x => x.id === aid); if (!a) return send(res, 404, { ok: false });
      a.status = "live"; a.expires = Date.now() + a.days * 864e5; persist(); return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && p === "/slots") return send(res, 200, { slots: slotList() });
    if (req.method === "POST" && p === "/banners") {
      if (limited("bn" + ip, 12, 3600000)) return send(res, 429, { error: "Too many uploads. Try again later." });
      const d = String((await body(req)).data || "");
      if (!/^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(d) || d.length > 260000) return send(res, 400, { error: "Banner must be a JPEG under 190 KB." });
      const id = crypto.randomBytes(6).toString("hex"); fs.writeFileSync(path.join(BANNER_DIR, id + ".jpg"), Buffer.from(d.split(",")[1], "base64")); return send(res, 200, { id });
    }
    if (req.method === "GET" && p.startsWith("/banner/")) {
      const id = p.slice(8); if (!/^[a-f0-9]{12}$/.test(id)) return send(res, 404, { error: "no" });
      try { const buf = fs.readFileSync(path.join(BANNER_DIR, id + ".jpg")); res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": ORIGIN }); return res.end(buf); } catch (e) { return send(res, 404, { error: "no" }); }
    }
    if (req.method === "GET" && p === "/ads") { const n = Date.now(); return send(res, 200, db.ads.filter(a => a.status === "live" && a.expires > n).map(a => ({ id: a.id, biz: a.biz, slogan: a.slogan, color: a.color, slot: a.slot, expires: a.expires, banner: a.banner ? "/banner/" + a.banner : "" }))); }
    if (req.method === "POST" && (p === "/signup" || p === "/login")) {
      if (limited("auth" + ip, 12, 60000)) return send(res, 429, { error: "Too many tries. Wait a minute." });
      const b = await body(req), u = clean(b.username, 16).toLowerCase(), pw = String(b.password || "");
      if (p === "/signup") {
        if (!/^[a-z0-9_]{3,16}$/.test(u)) return send(res, 400, { error: "Username must be 3 to 16 letters, numbers or underscores." });
        if (pw.length < 6 || pw.length > 100) return send(res, 400, { error: "Password must be at least 6 characters." });
        if (db.users[u]) return send(res, 409, { error: "That username is taken." });
        const salt = crypto.randomBytes(16).toString("hex");
        db.users[u] = { salt, hash: hashPw(pw, salt), createdAt: Date.now(), lastSeen: Date.now(), summary: {}, blocks: [] };
        return send(res, 200, { token: newSession(u), username: u });
      }
      const x = db.users[u];
      if (!x || hashPw(pw, x.salt) !== x.hash) return send(res, 401, { error: "Wrong username or password." });
      x.lastSeen = Date.now(); return send(res, 200, { token: newSession(u), username: u });
    }
    if (req.method === "POST" && p === "/verify") return await verify(req, res);

    const me = authUser(req);
    if (!me) return send(res, 401, { error: "Please log in." });
    const U = db.users[me];
    if (req.method === "GET" && p === "/me") return send(res, 200, { username: me, name: (U.summary || {}).name || me, state: U.state || null });
    if (req.method === "POST" && p === "/save") {
      const b = await body(req), s = b.summary || {};
      if (b.state && JSON.stringify(b.state).length < 200000) U.state = b.state;
      U.summary = { name: clean(s.name, 14) || me, look: s.look && typeof s.look === "object" ? { skin: Number(s.look.skin) | 0, outfit: Number(s.look.outfit) | 0, hair: Number(s.look.hair) | 0, gender: Number(s.look.gender) === 1 ? 1 : 0 } : {},
        region: Number(s.region) | 0, role: clean(s.role, 12), cash: Math.max(0, Number(s.cash) || 0), net: Math.max(0, Number(s.net) || 0), day: Number(s.day) | 0 };
      U.lastSeen = Date.now(); persist(); return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/ping") {
      const b = await body(req); U.lastSeen = Date.now();
      presence[me] = { x: Number(b.x) || 0, y: Number(b.y) || 0, dir: clean(b.dir, 6), region: Number(b.region) | 0, inside: !!b.inside, name: clean(b.name, 14) || me,
        look: b.look && typeof b.look === "object" ? { skin: Number(b.look.skin) | 0, outfit: Number(b.look.outfit) | 0, hair: Number(b.look.hair) | 0, gender: Number(b.look.gender) === 1 ? 1 : 0 } : {}, role: clean(b.role, 12), t: Date.now() };
      const mine = presence[me], nearby = Object.keys(presence).filter(u => u !== me && presence[u].t > Date.now() - 15000 && presence[u].region === mine.region && !presence[u].inside && db.users[u] && !blocked(me, u))
        .slice(0, 25).map(u => ({ username: u, name: presence[u].name, x: presence[u].x, y: presence[u].y, dir: presence[u].dir, look: presence[u].look, role: presence[u].role }));
      return send(res, 200, { nearby });
    }
    if (req.method === "GET" && p === "/players") {
      const q = clean(url.searchParams.get("q"), 20).toLowerCase(), onlyOnline = url.searchParams.get("online");
      let list = Object.keys(db.users).filter(u => u !== me && !blocked(me, u));
      if (onlyOnline) list = list.filter(online); else if (q) list = list.filter(u => u.includes(q) || String((db.users[u].summary || {}).name || "").toLowerCase().includes(q)); else list = [];
      return send(res, 200, { players: list.slice(0, 30).map(u => pub(u)) });
    }
    if (req.method === "GET" && p === "/inbox") {
      const chats = {}; let unread = 0;
      for (let i = db.messages.length - 1; i >= 0; i--) {
        const m = db.messages[i]; if (m.from !== me && m.to !== me) continue;
        const other = m.from === me ? m.to : m.from; if (!db.users[other]) continue;
        const c = chats[other] || (chats[other] = { with: other, name: (db.users[other].summary || {}).name || other, last: m.text, ts: m.ts, unread: 0 });
        if (m.to === me && !m.read) { c.unread++; unread++; }
      }
      return send(res, 200, { chats: Object.values(chats).sort((a, b) => b.ts - a.ts).slice(0, 30), unread });
    }
    if (req.method === "GET" && p === "/thread") {
      const w = clean(url.searchParams.get("with"), 16).toLowerCase(); if (!db.users[w]) return send(res, 404, { error: "No such player." });
      const since = Number(url.searchParams.get("since")) || 0, out = [];
      db.messages.forEach(m => { if ((m.from === me && m.to === w) || (m.from === w && m.to === me)) { if (m.to === me) m.read = true; if (m.ts > since) out.push({ id: m.id, from: m.from, text: m.text, ts: m.ts }); } });
      persist(); return send(res, 200, { messages: out.slice(-100), name: (db.users[w].summary || {}).name || w, online: !!online(w) });
    }
    if (req.method === "POST" && p === "/dm") {
      const b = await body(req), to = clean(b.to, 16).toLowerCase(), text = clean(b.text, 300);
      if (!db.users[to] || to === me || !text) return send(res, 400, { error: "Cannot send that message." });
      if (limited("dm" + me, 20, 60000)) return send(res, 429, { error: "Slow down a little." });
      if (blocked(me, to)) return send(res, 403, { error: "You cannot message this player." });
      db.messages.push({ id: crypto.randomBytes(6).toString("hex"), from: me, to, text, ts: Date.now(), read: false });
      if (db.messages.length > 50000) db.messages = db.messages.slice(-40000);
      persist(); return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/block") {
      const u = clean((await body(req)).user, 16).toLowerCase(); if (!db.users[u] || u === me) return send(res, 400, { ok: false });
      U.blocks = U.blocks || []; if (!U.blocks.includes(u)) U.blocks.push(u); persist(); return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/report") {
      const b = await body(req), u = clean(b.user, 16).toLowerCase(); if (!db.users[u]) return send(res, 400, { ok: false });
      db.reports.push({ from: me, user: u, reason: clean(b.reason, 200) || "No reason given", ts: Date.now(), msgs: db.messages.filter(m => (m.from === u && m.to === me) || (m.from === me && m.to === u)).slice(-10) });
      persist(); return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "Not found" });
  } catch (e) { send(res, 500, { error: "Server error" }); }
}).listen(PORT, () => console.log("Ghana Life server on " + PORT));
