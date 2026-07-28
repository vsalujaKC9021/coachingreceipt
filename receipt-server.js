/*
 * Receipt Management System — server
 * Pure Node.js (no external dependencies). Run:  node receipt-server.js
 * Data is stored centrally in data.json next to this file and shared by everyone
 * who connects to this server. Logins and access rights are enforced here on the server.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const PUBLIC = path.join(ROOT, 'public');

/* ---------------- Data store ---------------- */
let db = null;
function freshDb() {
  return {
    org: { name: 'Your Organization', gst: '', state: 'Maharashtra', phone: '', email: '',
           address: '', prefix: 'RCPT', footer: 'This is a computer generated receipt.', logo: '', additionalFields: [] },
    partners: [], services: [], transactions: [], users: [], seq: 0
  };
}
function hashPw(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
const TAB_KEYS = ['receipt', 'transactions', 'partners', 'services', 'settings', 'reconciliation', 'users'];
function normalizeRights(rights) {
  const r = Object.assign({ admin: false, edit: false, export: false }, rights || {});
  const legacyTabs = {}; TAB_KEYS.forEach(k => legacyTabs[k] = true);
  r.tabs = Object.assign(legacyTabs, r.tabs || {});
  if (r.admin) TAB_KEYS.forEach(k => r.tabs[k] = true);
  return r;
}
function makeUser(username, name, password, rights, email) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: uid(), username, name: name || username, email: (email || '').trim(), salt, hash: hashPw(password, salt), rights: normalizeRights(rights) };
}
function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!db.users) db.users = [];
    if (!db.org) db.org = freshDb().org;
    db.org = Object.assign(freshDb().org, db.org);
    if (!Array.isArray(db.org.additionalFields)) db.org.additionalFields = [];
    db.users.forEach(u => u.rights = normalizeRights(u.rights));
  } catch (e) {
    db = freshDb();
  }
  // ensure at least one admin exists
  if (!db.users.length) {
    db.users.push(makeUser('admin', 'Administrator', 'admin', { edit: true, export: true, admin: true }));
    saveDb();
    console.log('>> Created default admin account:  username "admin"  password "admin"  (change it after first login)');
  }
}
let saveQueued = false;
function saveDb() {
  // simple debounced synchronous write; fine for a small team
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) { console.error('Failed to write data.json:', e.message); }
}
function uid() { return Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }

/* ---------------- Sessions ---------------- */
const sessions = new Map(); // token -> { userId, expires }
const SESSION_MS = 1000 * 60 * 60 * 12; // 12 hours
function newSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId, expires: Date.now() + SESSION_MS });
  return token;
}
function getSessionUser(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)sid=([a-f0-9]+)/);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.expires < Date.now()) { if (s) sessions.delete(m[1]); return null; }
  s.expires = Date.now() + SESSION_MS; // sliding expiry
  return db.users.find(u => u.id === s.userId) || null;
}
function sessionTokenFrom(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([a-f0-9]+)/);
  return m ? m[1] : null;
}

/* ---------------- Helpers ---------------- */
function sanitizeUser(u) { return { id: u.id, username: u.username, name: u.name, email: u.email || '', rights: normalizeRights(u.rights) }; }
function can(user, perm) {
  if (!user) return false;
  user.rights = normalizeRights(user.rights);
  if (perm.startsWith('tab:')) return !!(user.rights.admin || user.rights.tabs[perm.slice(4)]);
  if (perm === 'view') return true;
  return !!(user.rights && user.rights[perm]);
}
function send(res, code, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 8e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}
const CT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon' };

/* ---------------- API ---------------- */
async function api(req, res, url) {
  const p = url.pathname;

  // ---- Auth ----
  if (p === '/api/login' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    const key = String(username || '').trim().toLowerCase();
    const u = db.users.find(x => x.username.toLowerCase() === key || ((x.email || '').toLowerCase() === key && key !== ''));
    const ok = u && crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), Buffer.from(hashPw(String(password || ''), u.salt), 'hex'));
    if (!ok) return send(res, 401, { error: 'Incorrect username or password.' });
    const token = newSession(u.id);
    return send(res, 200, { user: sanitizeUser(u) },
      { 'Set-Cookie': `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1000}` });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    const t = sessionTokenFrom(req); if (t) sessions.delete(t);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
  }

  const user = getSessionUser(req);
  if (p === '/api/session') {
    if (!user) return send(res, 401, { error: 'not signed in' });
    const defaultAdmin = db.users.find(x => x.username === 'admin' &&
      crypto.timingSafeEqual(Buffer.from(x.hash, 'hex'), Buffer.from(hashPw('admin', x.salt), 'hex')));
    return send(res, 200, { user: sanitizeUser(user), defaultAdmin: !!defaultAdmin });
  }

  // everything below requires a session
  if (!user) return send(res, 401, { error: 'not signed in' });

  if (p === '/api/state' && req.method === 'GET') {
    return send(res, 200, {
      org: db.org, partners: db.partners, services: db.services,
      transactions: db.transactions, users: db.users.map(sanitizeUser),
      me: sanitizeUser(user)
    });
  }

  // ---- Mutations (rights enforced) ----
  const body = (req.method === 'POST') ? await readBody(req) : {};
  const needEdit = () => { if (!can(user, 'edit')) { send(res, 403, { error: 'You do not have edit rights.' }); return false; } return true; };
  const needAdmin = () => { if (!can(user, 'admin')) { send(res, 403, { error: 'You do not have admin rights.' }); return false; } return true; };
  const needTab = (tab) => { if (!can(user, 'tab:' + tab)) { send(res, 403, { error: 'You do not have access to this tab.' }); return false; } return true; };

  if (p === '/api/org/save' && req.method === 'POST') {
    if (!needTab('settings') || !needEdit()) return;
    const seq = db.org.seq; // preserve nothing; seq lives at db level
    db.org = Object.assign({}, db.org, body.org || {});
    saveDb(); return send(res, 200, { org: db.org });
  }

  if (p === '/api/partners/save' && req.method === 'POST') {
    if (!needTab('partners') || !needEdit()) return;
    const pt = body.partner || {};
    if (!pt.name) return send(res, 400, { error: 'Name required' });
    if (pt.id) { db.partners = db.partners.map(x => x.id === pt.id ? Object.assign(x, pt) : x); }
    else { pt.id = uid(); db.partners.push(pt); }
    saveDb(); return send(res, 200, { partners: db.partners });
  }
  if (p === '/api/partners/delete' && req.method === 'POST') {
    if (!needTab('partners') || !needEdit()) return;
    db.partners = db.partners.filter(x => x.id !== body.id); saveDb();
    return send(res, 200, { partners: db.partners });
  }

  if (p === '/api/services/save' && req.method === 'POST') {
    if (!needTab('services') || !needEdit()) return;
    const s = body.service || {};
    if (!s.name) return send(res, 400, { error: 'Name required' });
    if (s.id) { db.services = db.services.map(x => x.id === s.id ? Object.assign(x, s) : x); }
    else { s.id = uid(); db.services.push(s); }
    saveDb(); return send(res, 200, { services: db.services });
  }
  if (p === '/api/services/delete' && req.method === 'POST') {
    if (!needTab('services') || !needEdit()) return;
    db.services = db.services.filter(x => x.id !== body.id); saveDb();
    return send(res, 200, { services: db.services });
  }

  if (p === '/api/import' && req.method === 'POST') {
    const importTab = body.kind === 'partners' ? 'partners' : body.kind === 'services' ? 'services' : '';
    if (!importTab || !needTab(importTab) || !needEdit()) return;
    let n = 0;
    if (body.kind === 'partners' && Array.isArray(body.rows)) {
      body.rows.forEach(r => { if (r.name) { r.id = uid(); db.partners.push(r); n++; } });
    } else if (body.kind === 'services' && Array.isArray(body.rows)) {
      body.rows.forEach(r => { if (r.name) { r.id = uid(); db.services.push(r); n++; } });
    }
    saveDb(); return send(res, 200, { imported: n, partners: db.partners, services: db.services });
  }

  if (p === '/api/transactions/create' && req.method === 'POST') {
    if (!needTab('receipt') || !needEdit()) return;
    const r = body.receipt || {};
    db.seq = (db.seq || 0) + 1;                      // server assigns the receipt number
    r.seq = db.seq;
    r.no = `${(db.org.prefix || 'RCPT')}-${String(db.seq).padStart(4, '0')}`;
    r.id = uid();
    r.createdAt = new Date().toISOString();
    r.createdBy = user.name || user.username;
    db.transactions.unshift(r);
    saveDb(); return send(res, 200, { receipt: r, transactions: db.transactions });
  }
  if (p === '/api/transactions/delete' && req.method === 'POST') {
    if (!needTab('transactions') || !needEdit()) return;
    db.transactions = db.transactions.filter(x => x.id !== body.id); saveDb();
    return send(res, 200, { transactions: db.transactions });
  }
  if (p === '/api/nextno' && req.method === 'GET') {
    if (!needTab('receipt')) return;
    const seq = (db.seq || 0) + 1;
    return send(res, 200, { no: `${(db.org.prefix || 'RCPT')}-${String(seq).padStart(4, '0')}` });
  }

  // ---- Users (admin only) ----
  if (p === '/api/users/save' && req.method === 'POST') {
    if (!needAdmin()) return;
    const uIn = body.user || {};
    const rights = normalizeRights({ admin: !!uIn.admin, edit: uIn.admin ? true : !!uIn.edit, export: uIn.admin ? true : !!uIn.export, tabs: uIn.tabs || {} });
    const email = (uIn.email || '').trim();
    if (uIn.id) {
      const ex = db.users.find(x => x.id === uIn.id);
      if (!ex) return send(res, 404, { error: 'not found' });
      if (ex.rights.admin && !rights.admin && db.users.filter(x => x.rights.admin).length <= 1)
        return send(res, 400, { error: 'At least one admin is required.' });
      if (email && db.users.some(x => x.id !== ex.id &&
          ((x.email || '').toLowerCase() === email.toLowerCase() || x.username.toLowerCase() === email.toLowerCase())))
        return send(res, 400, { error: 'That email is already used as a login by another user.' });
      ex.name = uIn.name || ex.name; ex.email = email; ex.rights = rights;
      if (uIn.password) { ex.salt = crypto.randomBytes(16).toString('hex'); ex.hash = hashPw(uIn.password, ex.salt); }
    } else {
      if (!uIn.username) return send(res, 400, { error: 'Username required' });
      if (db.users.some(x => x.username.toLowerCase() === uIn.username.toLowerCase()))
        return send(res, 400, { error: 'Username already exists.' });
      if (email && db.users.some(x => (x.email || '').toLowerCase() === email.toLowerCase() || x.username.toLowerCase() === email.toLowerCase()))
        return send(res, 400, { error: 'That email is already used as a login by another user.' });
      if (!uIn.password) return send(res, 400, { error: 'Password required for new user.' });
      db.users.push(makeUser(uIn.username.trim(), uIn.name, uIn.password, rights, email));
    }
    saveDb(); return send(res, 200, { users: db.users.map(sanitizeUser) });
  }
  if (p === '/api/users/delete' && req.method === 'POST') {
    if (!needAdmin()) return;
    const target = db.users.find(x => x.id === body.id);
    if (!target) return send(res, 404, { error: 'not found' });
    if (target.id === user.id) return send(res, 400, { error: 'You cannot delete yourself.' });
    if (target.rights.admin && db.users.filter(x => x.rights.admin).length <= 1)
      return send(res, 400, { error: 'Cannot delete the only admin.' });
    db.users = db.users.filter(x => x.id !== body.id); saveDb();
    return send(res, 200, { users: db.users.map(sanitizeUser) });
  }

  return send(res, 404, { error: 'Unknown API endpoint' });
}

/* ---------------- Static files ---------------- */
function serveStatic(req, res, url) {
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': CT[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------------- Server ---------------- */
loadDb();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(e => { console.error(e); send(res, 500, { error: 'server error' }); });
  } else {
    serveStatic(req, res, url);
  }
});
server.listen(PORT, () => {
  console.log('================================================================');
  console.log(' Receipt Management System is running.');
  console.log(' On this machine:      http://localhost:' + PORT);
  console.log(' From other computers: http://<this-machine-ip>:' + PORT);
  console.log(' Data file:            ' + DATA_FILE);
  console.log('================================================================');
});
