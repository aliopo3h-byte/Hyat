'use strict';
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { BOT_TOKEN, CHAT_ID, ADMIN_PASSWORD } = process.env;
const TZ = process.env.TIMEZONE || 'Asia/Baghdad';
const CURRENCY = process.env.CURRENCY || '';

if (!ADMIN_PASSWORD) {
  console.error('يجب ضبط المتغير ADMIN_PASSWORD (كلمة سر الأدمن)');
  process.exit(1);
}
const SECRET = crypto.createHash('sha256').update((process.env.TOKEN_SECRET || '') + '|' + ADMIN_PASSWORD).digest();

// ============ أدوات ============
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const toNum = v => {
  let s = String(v == null ? '' : v).replace(/[٠-٩]/g, d => AR_DIGITS.indexOf(d)).replace(/[,،\s]/g, '').replace(/[^\d.]/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
};
const r2 = n => Math.round(n * 100) / 100;
const money = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + (CURRENCY ? ' ' + CURRENCY : '');
const dayOf = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
const timeStr = ts => new Date(ts).toLocaleString('ar-EG', { timeZone: TZ });
const normR = s => String(s || '').trim().toLowerCase();
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ============ التخزين ============
const DB_FILE = process.env.DATA_FILE || 'data.json';
let db = { batchId: 0, uploadedAt: null, users: [], subs: [], ledger: [], ops: {}, opOrder: [] };
try {
  if (fs.existsSync(DB_FILE)) db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
} catch (e) {
  console.error('تعذّرت قراءة ملف البيانات:', e.message);
  try { fs.copyFileSync(DB_FILE, DB_FILE + '.corrupt-' + Date.now()); } catch {}
}
db.nextId = Math.max(Number(db.nextId) || 0, 0, ...db.subs.map(s => s.id || 0));
db.subs.forEach(s => {
  s.agentId = s.agentId || '';
  s.uid = s.uid || ('L' + s.id + '-' + db.batchId);
  s.amount = toNum(s.amount);
  s.paidAmount = Number(s.paidAmount) || 0;
  s.region = s.region || '';
  if (s.status === 'paid' && !s.paidAmount) s.paidAmount = s.amount;
});
function save() {
  try { fs.mkdirSync(path.dirname(path.resolve(DB_FILE)), { recursive: true }); } catch {}
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

// ============ المصادقة ============
function sign(p) {
  const b = Buffer.from(JSON.stringify(p)).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
}
function verify(t) {
  try {
    const [b, s] = (t || '').split('.');
    const e = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
    if (!s || s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') });
const checkPw = (pw, u) => {
  const h = crypto.scryptSync(pw, u.salt, 32), e = Buffer.from(u.hash, 'hex');
  return h.length === e.length && crypto.timingSafeEqual(h, e);
};

const auth = roles => (req, res, next) => {
  const p = verify((req.headers.authorization || '').replace('Bearer ', ''));
  if (!p || !roles.includes(p.role)) return res.status(401).json({ error: 'انتهت الجلسة، سجّل الدخول من جديد' });
  if (p.role === 'admin') { req.user = { role: 'admin', id: 'admin', name: 'الأدمن', regions: [] }; return next(); }
  const u = db.users.find(x => x.id === p.uid);
  if (!u) return res.status(401).json({ error: 'الحساب غير موجود' });
  if (!u.active) return res.status(401).json({ error: 'تم إيقاف حسابك، تواصل مع الإدارة' });
  req.user = { role: 'agent', id: u.id, name: u.name, regions: u.regions || [] };
  next();
};

const fails = new Map();
const limited = ip => { const f = fails.get(ip); return f && f.n >= 8 && Date.now() - f.t < 10 * 60 * 1000; };
const fail = ip => {
  const f = fails.get(ip);
  fails.set(ip, f && Date.now() - f.t < 10 * 60 * 1000 ? { n: f.n + 1, t: Date.now() } : { n: 1, t: Date.now() });
};

// ============ تليجرام ============
const tgStats = { ok: 0, fail: 0, last: '' };
async function tg(text) {
  if (!BOT_TOKEN || !CHAT_ID) { tgStats.fail++; tgStats.last = 'BOT_TOKEN أو CHAT_ID غير مضبوط'; return false; }
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, text }), signal: AbortSignal.timeout(10000)
      });
      if (r.ok) { tgStats.ok++; return true; }
      const j = await r.json().catch(() => ({}));
      tgStats.last = j.description || 'HTTP ' + r.status;
    } catch (e) { tgStats.last = e.message; }
  }
  tgStats.fail++;
  return false;
}
async function tgDoc(buf, filename, caption) {
  if (!BOT_TOKEN || !CHAT_ID) return false;
  try {
    const fd = new FormData();
    fd.append('chat_id', CHAT_ID);
    fd.append('caption', caption);
    fd.append('document', new Blob([buf]), filename);
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
    return r.ok;
  } catch { return false; }
}
let tgChain = Promise.resolve();
const sendTg = text => { tgChain = tgChain.then(() => tg(text)).catch(() => {}); };

const subInfo = s =>
  `الاسم: ${s.name}` + (s.region ? `\nالمنطقة: ${s.region}` : '') + `\nالرقم: ${s.phone}\nالعنوان: ${s.address}` +
  `\nاليوزر: ${s.user}\nنوع الاشتراك: ${s.plan}`;

// ============ المشتركون والصلاحيات ============
const visible = (u, s) => {
  if (u.role === 'admin') return true;
  if (s.agentId) return s.agentId === u.id;
  return !u.regions.length || u.regions.map(normR).includes(normR(s.region)); // قوائم قديمة بلا مندوب
};
const pub = s => ({
  id: s.id, name: s.name, address: s.address, phone: s.phone, user: s.user, plan: s.plan, notes: s.notes,
  region: s.region, agentId: s.agentId, amount: s.amount, paidAmount: s.paidAmount, status: s.status, reason: s.reason, by: s.by, at: s.at
});
function payload(user) {
  const day = dayOf(Date.now());
  let collected = 0, count = 0;
  if (user.role === 'agent') {
    for (const l of db.ledger) if (!l.void && l.byId === user.id && l.day === day) { collected += l.amount; count++; }
  }
  return {
    batchId: db.batchId, uploadedAt: db.uploadedAt, subs: db.subs.filter(s => visible(user, s)).map(pub),
    me: { collected: r2(collected), count }, serverTime: Date.now(), name: user.name, currency: CURRENCY
  };
}

// ============ تنفيذ العمليات (يدعم العمل بدون إنترنت) ============
function remember(id, r) {
  db.ops[id] = { ok: r.ok, error: r.error, dup: true };
  db.opOrder.push(id);
  if (db.opOrder.length > 6000) db.opOrder.splice(0, 1000).forEach(k => delete db.ops[k]);
}
function applyOp(user, op) {
  if (!op || typeof op.opId !== 'string' || op.opId.length > 80) return { ok: false, error: 'عملية غير صالحة' };
  if (db.ops[op.opId]) return db.ops[op.opId];
  const done = r => { remember(op.opId, r); return r; };
  const bad = error => done({ ok: false, error });

  if (!['pay', 'unpaid', 'undo'].includes(op.type)) return bad('نوع العملية غير معروف');
  const s = db.subs.find(x => x.id === op.subId);
  if (!s) return bad('المشترك غير موجود (ربما تغيّرت القائمة)');
  if (!visible(user, s)) return bad('هذا المشترك ليس ضمن منطقتك');

  const n = Date.now();
  let ts = Number(op.ts);
  if (!isFinite(ts) || ts > n + 300000 || ts < n - 7 * 86400000) ts = n;
  const late = n - ts > 120000 ? '\n(سُجّلت بدون إنترنت وتمت مزامنتها لاحقاً)' : '';

  if (op.type === 'pay') {
    const amt = r2(toNum(op.amount));
    if (!(amt > 0)) return bad('اكتب مبلغاً صحيحاً');
    const due = s.amount, paid = s.paidAmount || 0;
    if (due > 0 && paid >= due) return bad('تم تسديد كامل المبلغ مسبقاً');
    if (due > 0 && paid + amt > due + 0.001) return bad('المبلغ أكبر من المتبقي (' + money(due - paid) + ')');
    s.paidAmount = r2(paid + amt);
    s.status = (due <= 0 || s.paidAmount >= due) ? 'paid' : 'partial';
    if (s.status === 'paid') s.reason = '';
    Object.assign(s, { by: user.name, byId: user.id, at: timeStr(ts) });
    db.ledger.push({ id: op.opId, batchId: db.batchId, subId: s.id, subUid: s.uid, subName: s.name, region: s.region, amount: amt,
      byId: user.id, byName: user.name, ts, day: dayOf(ts), void: false });
    const rem = due > 0 ? Math.max(0, due - s.paidAmount) : 0;
    const head = s.status === 'paid' ? '✅ تم الدفع' : '🟡 دفعة جزئية';
    const tail = s.status === 'paid'
      ? `المبلغ المستلم: ${money(amt)}` + (due > 0 && s.paidAmount !== amt ? `\nإجمالي المدفوع: ${money(s.paidAmount)}` : '')
      : `المبلغ المستلم: ${money(amt)}\nإجمالي المدفوع: ${money(s.paidAmount)} من ${money(due)}\nالمتبقي: ${money(rem)}`;
    return done({ ok: true, tg: `${head}\n${subInfo(s)}\n${tail}\nالمندوب: ${user.name}\nالوقت: ${s.at}${late}` });
  }

  if (op.type === 'unpaid') {
    const reason = String(op.reason || '').trim().slice(0, 300);
    if (!reason) return bad('اكتب سبب عدم الدفع');
    if (s.status === 'paid') return bad('هذا المشترك مسجّل كمسدد بالكامل');
    const partial = (s.paidAmount || 0) > 0;
    s.status = partial ? 'partial' : 'unpaid';
    s.reason = reason;
    Object.assign(s, { by: user.name, byId: user.id, at: timeStr(ts) });
    const head = partial ? '⚠️ لم يسدد المتبقي' : '❌ لم يسدد';
    const extra = partial ? `\nالمدفوع: ${money(s.paidAmount)} من ${money(s.amount)}` : (s.amount ? `\nالمبلغ: ${money(s.amount)}` : '');
    return done({ ok: true, tg: `${head}\n${subInfo(s)}${extra}\nالسبب: ${reason}\nالمندوب: ${user.name}\nالوقت: ${s.at}${late}` });
  }

  // undo: يلغي تسجيل "لم يسدد" فقط
  if (s.status !== 'unpaid') return bad('لا يمكن إلغاء هذا التسجيل');
  Object.assign(s, { status: 'pending', reason: '', by: '', byId: '', at: '' });
  return done({ ok: true });
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, p) { if (p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); }
}));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.get('/api/config', (req, res) => res.json({ currency: CURRENCY }));

app.post('/api/login', async (req, res) => {
  const ip = req.ip;
  if (limited(ip)) return res.status(429).json({ error: 'محاولات كثيرة، انتظر 10 دقائق' });
  const { role, username, password } = req.body || {};
  let user = null;
  if (role === 'admin' && password && same(password, ADMIN_PASSWORD)) user = { role: 'admin', id: 'admin', name: 'الأدمن' };
  if (role === 'agent') {
    const u = db.users.find(x => x.username === String(username || '').trim().toLowerCase());
    if (u && password && checkPw(String(password), u)) {
      if (!u.active) return res.status(403).json({ error: 'تم إيقاف حسابك، تواصل مع الإدارة' });
      user = { role: 'agent', id: u.id, name: u.name };
    }
  }
  if (!user) { fail(ip); await new Promise(r => setTimeout(r, 800)); return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' }); }
  fails.delete(ip);
  const exp = Date.now() + (user.role === 'admin' ? 3 : 30) * 24 * 3600 * 1000;
  res.json({ token: sign({ role: user.role, uid: user.id, exp }), role: user.role, name: user.name, uid: user.id });
});

app.get('/api/subs', auth(['admin', 'agent']), (req, res) => res.json(payload(req.user)));

app.post('/api/sync', auth(['admin', 'agent']), (req, res) => {
  const ops = Array.isArray(req.body && req.body.ops) ? req.body.ops.slice(0, 200) : [];
  const results = [];
  let changed = false;
  for (const op of ops) {
    const r = applyOp(req.user, op);
    results.push({ opId: op && op.opId, ok: r.ok, error: r.error });
    if (!r.dup) { changed = true; if (r.ok && r.tg) sendTg(r.tg); }
  }
  if (changed) save();
  res.json({ results, data: payload(req.user) });
});

app.post('/api/subs/:id/reset', auth(['admin']), (req, res) => {
  const s = db.subs.find(x => x.id === Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'غير موجود' });
  const voided = db.ledger.filter(l => !l.void && (l.subUid || ('L' + l.subId + '-' + l.batchId)) === s.uid);
  const total = voided.reduce((a, l) => a + l.amount, 0);
  voided.forEach(l => { l.void = true; });
  Object.assign(s, { status: 'pending', paidAmount: 0, reason: '', by: '', byId: '', at: '' });
  save();
  if (total > 0) sendTg(`↩️ تم إلغاء تسجيل الدفع من الأدمن\nالاسم: ${s.name}\nالمبلغ الملغى: ${money(total)}`);
  res.json({ ok: true });
});

// ============ رفع الإكسل ============
const HEADERS = {
  name: ['الاسم', 'اسم المشترك', 'اسم', 'name'],
  address: ['العنوان', 'address'],
  phone: ['الرقم', 'رقم', 'رقم الهاتف', 'الهاتف', 'phone'],
  user: ['اليوزر', 'يوزر', 'اسم المستخدم', 'user', 'username'],
  plan: ['نوع الاشتراك', 'الاشتراك', 'الباقة', 'plan'],
  notes: ['ملاحظات', 'ملاحظة', 'notes'],
  amount: ['المبلغ', 'مبلغ', 'المبلغ المستحق', 'amount'],
  region: ['المنطقة', 'منطقة', 'region', 'area']
};
const norm = k => String(k).trim().toLowerCase();
const pick = (row, names) => {
  const key = Object.keys(row).find(k => names.map(norm).includes(norm(k)));
  return key ? String(row[key]).trim() : '';
};

app.post('/api/upload', auth(['admin']), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم اختيار ملف' });
  const body = req.body || {};
  const agent = db.users.find(u => u.id === body.agentId);
  if (!agent) return res.status(400).json({ error: 'اختر المندوب الذي ستُرفع القائمة له' });
  const append = body.mode === 'append';
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
    const fresh = [];
    rows.forEach(r => {
      const s = {};
      for (const f in HEADERS) s[f] = pick(r, HEADERS[f]);
      if (!s.name) return;
      s.amount = toNum(s.amount);
      const id = ++db.nextId;
      fresh.push({ id, uid: 'S' + id, agentId: agent.id, ...s, status: 'pending', paidAmount: 0, reason: '', by: '', byId: '', at: '' });
    });
    if (!fresh.length) return res.status(400).json({ error: 'لم أجد أسماء. تأكد أن أحد الأعمدة عنوانه "الاسم"' });
    let removed = 0;
    if (!append) {
      const keep = db.subs.filter(s => s.agentId !== agent.id);
      removed = db.subs.length - keep.length;
      db.subs = keep;
    }
    db.subs.push(...fresh);
    db.batchId = Date.now();
    db.uploadedAt = timeStr(Date.now());
    save();
    res.json({ count: fresh.length, agent: agent.name, removed });
  } catch (e) {
    res.status(400).json({ error: 'تعذّرت قراءة الملف. تأكد أنه Excel (.xlsx)' });
  }
});

app.post('/api/subs/clear', auth(['admin']), (req, res) => {
  const target = (req.body || {}).agentId || 'all';
  let label, keep;
  if (target === 'all') { label = 'كل المندوبين'; keep = []; }
  else if (target === 'unassigned') { label = 'المشتركين بلا مندوب'; keep = db.subs.filter(s => s.agentId); }
  else {
    const u = db.users.find(x => x.id === target);
    if (!u) return res.status(404).json({ error: 'المندوب غير موجود' });
    label = 'قائمة ' + u.name; keep = db.subs.filter(s => s.agentId !== target);
  }
  const removed = db.subs.length - keep.length;
  db.subs = keep;
  if (!db.subs.length) db.uploadedAt = null;
  save();
  sendTg(`🧹 تم تصفير القائمة من الأدمن\nالنطاق: ${label}\nعدد المحذوفين: ${removed}`);
  res.json({ removed });
});

// ============ التقارير ============
function sheetsBuf(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    const data = rows.length ? rows : [{ '—': 'لا توجد بيانات' }];
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = Object.keys(data[0]).map(k => ({ wch: Math.min(40, Math.max(String(k).length, ...data.map(r => String(r[k] == null ? '' : r[k]).length)) + 2) }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  wb.Workbook = { Views: [{ RTL: true }] };
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const stLabel = { pending: 'لم تتم زيارته', partial: 'دفع جزئي', paid: 'مدفوع كامل', unpaid: 'لم يسدد' };
const remOf = s => s.amount > 0 ? Math.max(0, s.amount - (s.paidAmount || 0)) : 0;

function agentDay(day) {
  const map = new Map();
  for (const l of db.ledger) {
    if (l.void || l.day !== day) continue;
    const a = map.get(l.byId) || { id: l.byId, name: l.byName, count: 0, collected: 0 };
    a.count++; a.collected = r2(a.collected + l.amount);
    map.set(l.byId, a);
  }
  return [...map.values()].sort((a, b) => b.collected - a.collected);
}
function buildReport(kind, day) {
  if (kind === 'paid') {
    const list = db.subs.filter(s => (s.paidAmount || 0) > 0);
    return { count: list.length, buf: sheetsBuf([['الذين دفعوا', list.map(s => ({
      'الاسم': s.name, 'المنطقة': s.region, 'العنوان': s.address, 'الرقم': s.phone, 'اليوزر': s.user, 'نوع الاشتراك': s.plan,
      'المبلغ المستحق': s.amount, 'المدفوع': s.paidAmount, 'المتبقي': remOf(s), 'الحالة': stLabel[s.status],
      'المندوب': s.by, 'الوقت': s.at
    }))]]) };
  }
  if (kind === 'unpaid') {
    const list = db.subs.filter(s => s.status !== 'paid');
    return { count: list.length, buf: sheetsBuf([['الذين لم يدفعوا', list.map(s => ({
      'الاسم': s.name, 'المنطقة': s.region, 'العنوان': s.address, 'الرقم': s.phone, 'اليوزر': s.user, 'نوع الاشتراك': s.plan,
      'المبلغ المستحق': s.amount, 'المدفوع': s.paidAmount, 'المتبقي': remOf(s), 'الحالة': stLabel[s.status],
      'سبب عدم الدفع': s.reason, 'المندوب': s.by, 'الوقت': s.at
    }))]]) };
  }
  const ag = agentDay(day);
  const total = ag.reduce((a, x) => a + x.collected, 0);
  const rows = ag.map(a => ({ 'المندوب': a.name, 'عدد الدفعات': a.count, 'إجمالي المستلم': a.collected }));
  if (rows.length) rows.push({ 'المندوب': 'الإجمالي', 'عدد الدفعات': ag.reduce((a, x) => a + x.count, 0), 'إجمالي المستلم': r2(total) });
  const det = db.ledger.filter(l => !l.void && l.day === day).sort((a, b) => a.ts - b.ts).map(l => ({
    'الوقت': timeStr(l.ts), 'المندوب': l.byName, 'المشترك': l.subName, 'المنطقة': l.region, 'المبلغ': l.amount
  }));
  return { count: ag.length, buf: sheetsBuf([['ملخص المندوبين', rows], ['تفاصيل الدفعات', det]]) };
}
const validDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : dayOf(Date.now());

app.get('/api/export/:kind', auth(['admin']), (req, res) => {
  if (!['paid', 'unpaid', 'agents'].includes(req.params.kind)) return res.status(404).end();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buildReport(req.params.kind, validDay(req.query.day)).buf);
});

app.get('/api/template', auth(['admin']), (req, res) => {
  const buf = sheetsBuf([['المشتركون', [{
    'الاسم': 'مثال (احذف هذا الصف)', 'المنطقة': 'حي الجامعة', 'العنوان': 'شارع 5 - بيت 12', 'الرقم': '07701234567',
    'اليوزر': 'user01', 'نوع الاشتراك': '10 ميغا', 'المبلغ': 25000, 'ملاحظات': ''
  }]]]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.post('/api/send-reports', auth(['admin']), async (req, res) => {
  const day = validDay(req.body && req.body.day);
  const ag = agentDay(day);
  const total = ag.reduce((a, x) => a + x.collected, 0), cnt = ag.reduce((a, x) => a + x.count, 0);
  const left = db.subs.filter(s => s.status !== 'paid');
  const leftAmt = left.reduce((a, s) => a + remOf(s), 0);
  let text = `📊 ملخص يوم ${day}\nإجمالي المستلم: ${money(total)}\nعدد الدفعات: ${cnt}\n`;
  if (ag.length) text += '\n' + ag.map(a => `👤 ${a.name}: ${money(a.collected)} (${a.count} دفعة)`).join('\n') + '\n';
  text += `\nالمتبقي للتحصيل: ${money(leftAmt)} (${left.length} مشترك)`;
  const p = buildReport('paid', day), u = buildReport('unpaid', day), a = buildReport('agents', day);
  const r = [await tg(text),
    await tgDoc(p.buf, `paid-${day}.xlsx`, `✅ الذين دفعوا (${p.count})`),
    await tgDoc(u.buf, `unpaid-${day}.xlsx`, `❌ الذين لم يدفعوا (${u.count})`),
    await tgDoc(a.buf, `agents-${day}.xlsx`, `👤 حساب المندوبين - ${day}`)];
  if (r.some(x => !x)) return res.status(502).json({ error: 'تعذّر إرسال بعض الرسائل إلى تليجرام. ' + (tgStats.last || 'تأكد من BOT_TOKEN و CHAT_ID') });
  res.json({ ok: true });
});

app.post('/api/test-telegram', auth(['admin']), async (req, res) => {
  const ok = await tg('✅ اختبار: الاتصال بتليجرام يعمل بشكل صحيح');
  if (!ok) return res.status(502).json({ error: tgStats.last || 'فشل الإرسال' });
  res.json({ ok: true });
});

// ============ الإحصائيات ============
app.get('/api/stats', auth(['admin']), (req, res) => {
  const day = validDay(req.query.day);
  const by = { pending: 0, partial: 0, paid: 0, unpaid: 0 };
  let due = 0, paidTotal = 0;
  db.subs.forEach(s => { by[s.status] = (by[s.status] || 0) + 1; due += s.amount; paidTotal += s.paidAmount || 0; });
  const leftAmt = db.subs.reduce((a, s) => a + (s.status === 'paid' ? 0 : remOf(s)), 0);
  const agents = db.users.map(u => {
    const d = agentDay(day).find(x => x.id === u.id) || { count: 0, collected: 0 };
    return { id: u.id, name: u.name, active: u.active, count: d.count, collected: d.collected,
      unpaid: db.subs.filter(s => s.byId === u.id && s.status === 'unpaid').length,
      subs: db.subs.filter(s => s.agentId === u.id).length };
  });
  agentDay(day).filter(x => !db.users.find(u => u.id === x.id)).forEach(x => agents.push({ ...x, active: false, unpaid: 0, subs: 0 }));
  const payments = db.ledger.filter(l => !l.void && l.day === day).sort((a, b) => b.ts - a.ts).slice(0, 200)
    .map(l => ({ time: timeStr(l.ts), agent: l.byName, sub: l.subName, region: l.region, amount: l.amount }));
  const collectedDay = agentDay(day).reduce((a, x) => a + x.collected, 0);
  res.json({
    day, uploadedAt: db.uploadedAt, total: db.subs.length, unassigned: db.subs.filter(s => !s.agentId).length, by, due: r2(due), paidTotal: r2(paidTotal), leftAmt: r2(leftAmt),
    collectedDay: r2(collectedDay), countDay: agentDay(day).reduce((a, x) => a + x.count, 0), agents, payments,
    regions: [...new Set(db.subs.map(s => s.region).filter(Boolean))], tg: tgStats,
    tgConfigured: !!(BOT_TOKEN && CHAT_ID), currency: CURRENCY
  });
});

// ============ المندوبون ============
const parseRegions = v => (Array.isArray(v) ? v : String(v || '').split(/[,،;\n]/)).map(x => String(x).trim()).filter(Boolean);
const pubUser = u => ({ id: u.id, name: u.name, username: u.username, regions: u.regions || [], active: u.active });

app.get('/api/users', auth(['admin']), (req, res) => res.json(db.users.map(pubUser)));

app.post('/api/users', auth(['admin']), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 40);
  const username = String(b.username || '').trim().toLowerCase().replace(/\s+/g, '');
  const password = String(b.password || '');
  if (!name) return res.status(400).json({ error: 'اكتب اسم المندوب' });
  if (username.length < 3) return res.status(400).json({ error: 'اسم المستخدم 3 أحرف على الأقل' });
  if (password.length < 4) return res.status(400).json({ error: 'كلمة السر 4 أحرف على الأقل' });
  if (db.users.some(u => u.username === username)) return res.status(409).json({ error: 'اسم المستخدم مستخدم مسبقاً' });
  const u = { id: crypto.randomBytes(6).toString('hex'), name, username, ...hashPw(password), regions: parseRegions(b.regions), active: true };
  db.users.push(u);
  save();
  res.json(pubUser(u));
});

app.put('/api/users/:id', auth(['admin']), (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'غير موجود' });
  const b = req.body || {};
  if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 40); if (!n) return res.status(400).json({ error: 'الاسم مطلوب' }); u.name = n; }
  if (b.regions !== undefined) u.regions = parseRegions(b.regions);
  if (b.active !== undefined) u.active = !!b.active;
  if (b.password) {
    if (String(b.password).length < 4) return res.status(400).json({ error: 'كلمة السر 4 أحرف على الأقل' });
    Object.assign(u, hashPw(String(b.password)));
  }
  save();
  res.json(pubUser(u));
});

app.use((err, req, res, next) => res.status(400).json({ error: err.message || 'خطأ' }));

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('Running on ' + port));
