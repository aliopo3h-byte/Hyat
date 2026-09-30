'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
const svg = p => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const IC = {
  pin: svg('<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>'),
  phone: svg('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>'),
  user: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  wifi: svg('<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>'),
  note: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
  refresh: svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  out: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
  search: svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  map: svg('<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>')
};
$('#refBtn').innerHTML = IC.refresh; $('#outBtn').innerHTML = IC.out; $('#searchIc').innerHTML = IC.search;

let CUR = (store.get('cfg') || {}).currency || '';
const fmt = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + (CUR ? ' ' + CUR : '');
const ST = { pending: 'بانتظار التحصيل', partial: 'دفع جزئي', paid: 'تم الدفع', unpaid: 'لم يسدد' };
const ORDER = { pending: 0, partial: 1, unpaid: 2, paid: 3 };

let auth = store.get('auth');            // {token,name,uid}
let server = store.get('server');        // آخر بيانات من السيرفر
let queue = store.get('queue') || [];    // عمليات لم تُرسل بعد
let fails = store.get('fails') || [];    // عمليات رفضها السيرفر
let view = null, filter = 'all', curId = null, mode = 'view', syncing = false;

// ---------- الشبكة ----------
async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (auth && auth.token) } });
  } catch { const e = new Error('لا يوجد اتصال'); e.network = true; throw e; }
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { forceLogout(d.error); const e = new Error(d.error || 'انتهت الجلسة'); e.auth = true; throw e; }
  if (!r.ok) throw new Error(d.error || 'حدث خطأ');
  return d;
}

// ---------- تطبيق العمليات محلياً ----------
function applyLocal(v, op) {
  const s = v.subs.find(x => x.id === op.subId);
  if (!s) return;
  if (op.type === 'pay') {
    const amt = Number(op.amount) || 0;
    s.paidAmount = Math.round(((s.paidAmount || 0) + amt) * 100) / 100;
    s.status = (s.amount <= 0 || s.paidAmount >= s.amount) ? 'paid' : 'partial';
    if (s.status === 'paid') s.reason = '';
    s.by = auth.name; s.at = new Date(op.ts).toLocaleString('ar-EG') + ' (محفوظ على الجهاز)';
    v.me.collected += amt; v.me.count++;
  } else if (op.type === 'unpaid') {
    s.status = s.paidAmount > 0 ? 'partial' : 'unpaid';
    s.reason = op.reason; s.by = auth.name; s.at = new Date(op.ts).toLocaleString('ar-EG') + ' (محفوظ على الجهاز)';
  } else if (op.type === 'undo' && s.status === 'unpaid') {
    Object.assign(s, { status: 'pending', reason: '', by: '', at: '' });
  }
}
function rebuild() {
  if (!server) { view = null; return; }
  view = JSON.parse(JSON.stringify(server));
  queue.forEach(op => applyLocal(view, op));
}
function enqueue(op) {
  op.opId = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  op.ts = Date.now();
  queue.push(op); store.set('queue', queue);
  applyLocal(view, op); render(); banner();
  toast(navigator.onLine ? 'تم التسجيل ✓' : 'حُفظ على جهازك وسيُرسل عند عودة الإنترنت ✓');
  flush();
}

// ---------- المزامنة ----------
async function flush(manual) {
  if (syncing || !auth) return;
  if (!navigator.onLine) { banner(); if (manual) toast('لا يوجد اتصال بالإنترنت'); return; }
  syncing = true; banner();
  let again = false;
  try {
    const batch = queue.slice(0, 100);
    const r = await api('/api/sync', { method: 'POST', body: JSON.stringify({ ops: batch }) });
    const ids = new Set(batch.map(o => o.opId));
    r.results.forEach(x => {
      if (!x.ok) { const op = batch.find(o => o.opId === x.opId); fails.push({ msg: (op && op.subName ? op.subName + ': ' : '') + x.error }); }
    });
    queue = queue.filter(o => !ids.has(o.opId));
    store.set('queue', queue); store.set('fails', fails);
    server = r.data; store.set('server', server);
    if (server.currency !== undefined) { CUR = server.currency; store.set('cfg', { currency: CUR }); }
    rebuild(); render();
    if (manual) toast('تم التحديث');
    again = queue.length > 0;
  } catch (e) {
    if (!e.auth && manual) toast(e.network ? 'تعذّر الاتصال' : e.message);
  } finally { syncing = false; banner(); }
  if (again) setTimeout(flush, 300);
}
function banner() {
  const n = queue.length;
  let h = '';
  if (!navigator.onLine) h = `<div class="banner off"><span class="dot"></span>لا يوجد إنترنت${n ? ` — ${n} عملية محفوظة وستُرسل تلقائياً` : ' — تعمل الآن على البيانات المحفوظة'}</div>`;
  else if (syncing || n) h = `<div class="banner sync"><span class="dot"></span>جارٍ المزامنة${n ? ` (${n})` : ''}...</div>`;
  if (fails.length) h += `<div class="banner warn"><b>تعذّر تسجيل ${fails.length} عملية:</b>${fails.map(f => `<span>• ${esc(f.msg)}</span>`).join('')}<button class="btn sm ghost" onclick="fails=[];store.set('fails',fails);banner()">حسناً</button></div>`;
  $('#banner').innerHTML = h;
}

// ---------- الدخول ----------
function showLogin(msg) {
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
  $('#lerr').textContent = msg || '';
}
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); $('#who').textContent = auth.name; }
function forceLogout(msg) { auth = null; store.del('auth'); showLogin(msg); }
async function login() {
  const btn = $('#lbtn'); $('#lerr').textContent = ''; btn.disabled = true;
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'agent', username: $('#u').value, password: $('#p').value }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'خطأ');
    if (store.get('owner') !== d.uid) { queue = []; fails = []; server = null; store.set('queue', queue); store.del('server'); }
    store.set('owner', d.uid);
    auth = { token: d.token, name: d.name, uid: d.uid }; store.set('auth', auth);
    $('#p').value = ''; showApp(); rebuild(); render(); banner(); flush();
  } catch (e) { $('#lerr').textContent = e.message === 'Failed to fetch' ? 'لا يوجد اتصال بالإنترنت' : e.message; }
  finally { btn.disabled = false; }
}
function logout() {
  if (queue.length && !confirm(`توجد ${queue.length} عملية لم تُرسل بعد. إذا خرجت الآن قد تضيع. هل تريد الخروج؟`)) return;
  store.del('auth'); store.del('server'); store.del('owner'); queue = []; store.set('queue', queue); server = null; view = null; auth = null;
  showLogin();
}

// ---------- العرض ----------
function render() {
  if (!view) return;
  const subs = view.subs;
  const left = subs.reduce((a, s) => a + (s.status === 'paid' ? 0 : (s.amount > 0 ? Math.max(0, s.amount - s.paidAmount) : 0)), 0);
  $('#hCollected').textContent = fmt(view.me.collected);
  $('#hCount').textContent = view.me.count;
  $('#hLeft').textContent = fmt(left);
  const cnt = k => k === 'all' ? subs.length : subs.filter(s => s.status === k).length;
  $('#tabs').innerHTML = [['all', 'الكل'], ['pending', 'بانتظار'], ['partial', 'جزئي'], ['paid', 'مسدد'], ['unpaid', 'لم يسدد']]
    .map(([k, t]) => `<button class="tab ${filter === k ? 'on' : ''}" onclick="filter='${k}';render()">${t}<b>${cnt(k)}</b></button>`).join('');
  const q = $('#q').value.trim().toLowerCase();
  let rows = subs.filter(s => (filter === 'all' || s.status === filter) &&
    (!q || [s.name, s.phone, s.address, s.user, s.region].join(' ').toLowerCase().includes(q)));
  if (filter === 'all') rows = rows.slice().sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.id - b.id);
  $('#list').innerHTML = rows.length ? rows.map(s => {
    const rem = s.amount > 0 ? Math.max(0, s.amount - s.paidAmount) : 0;
    const amt = s.status === 'paid' ? fmt(s.paidAmount) : (s.amount > 0 ? fmt(rem) : '');
    return `<div class="sub" onclick="openSub(${s.id})">
      <div class="avatar av-${s.status}">${esc((s.name || '?').trim().charAt(0))}</div>
      <div class="mid"><b>${esc(s.name)}</b><small>${esc([s.region, s.address].filter(Boolean).join(' • '))}</small></div>
      <div class="end">${amt ? `<span class="amt">${amt}</span>` : ''}<span class="pill ${s.status}">${ST[s.status]}</span></div></div>`;
  }).join('') : `<div class="empty">${subs.length ? 'لا توجد نتائج' : 'لا توجد قائمة بعد. اسحب للتحديث أو تواصل مع الأدمن.'}</div>`;
  if (curId != null && mode === 'view' && $('#bg').classList.contains('show')) renderSheet();
}

const kv = (icon, label, val, extra = '') => val ? `<div class="kv">${icon}<div><small>${label}</small>${val}</div>${extra}</div>` : '';
function openSub(id) { curId = id; mode = 'view'; renderSheet(); $('#bg').classList.add('show'); }
function closeSheet() { $('#bg').classList.remove('show'); curId = null; }
function renderSheet() {
  const s = view.subs.find(x => x.id === curId);
  if (!s) return closeSheet();
  const rem = s.amount > 0 ? Math.max(0, s.amount - s.paidAmount) : 0;
  const maps = s.address ? `<a class="go" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((s.region ? s.region + ' ' : '') + s.address)}">خريطة</a>` : '';
  const call = s.phone ? `<a class="go" href="tel:${esc(s.phone)}">اتصال</a>` : '';
  let body = `<div class="grab"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><h2>${esc(s.name)}</h2><span class="pill ${s.status}">${ST[s.status]}</span></div>
    ${kv(IC.pin, 'العنوان' + (s.region ? ' • ' + esc(s.region) : ''), esc(s.address), maps)}
    ${kv(IC.phone, 'الرقم', esc(s.phone), call)}
    ${kv(IC.user, 'اليوزر', esc(s.user))}
    ${kv(IC.wifi, 'نوع الاشتراك', esc(s.plan))}
    ${kv(IC.note, 'ملاحظات', esc(s.notes))}`;
  if (s.amount > 0 || s.paidAmount > 0) body += `<div class="money">
      <div><small>المستحق</small><b>${fmt(s.amount)}</b></div>
      <div class="g"><small>المدفوع</small><b>${fmt(s.paidAmount)}</b></div>
      <div class="r"><small>المتبقي</small><b>${fmt(rem)}</b></div></div>`;
  if (s.reason) body += `<div class="note"><b>السبب:</b> ${esc(s.reason)}</div>`;
  if (s.by) body += `<div class="note" style="margin-top:8px"><small>آخر تسجيل: ${esc(s.by)} — ${esc(s.at)}</small></div>`;

  if (mode === 'view') {
    body += `<div style="margin-top:16px">`;
    if (s.status !== 'paid') body += `<div class="row"><button class="btn ok" onclick="mode='pay';renderSheet()">تسجيل دفعة</button>
      <button class="btn bad" onclick="mode='unpaid';renderSheet()">لم يسدد</button></div>`;
    if (s.status === 'unpaid') body += `<button class="btn ghost block" style="margin-top:10px" onclick="undo()">إلغاء التسجيل</button>`;
    body += `<button class="btn ghost block" style="margin-top:10px" onclick="closeSheet()">إغلاق</button></div>`;
  } else if (mode === 'pay') {
    body += `<div style="margin-top:16px"><div class="field"><label>المبلغ المستلم</label>
      <input id="payAmt" type="number" inputmode="decimal" value="${rem > 0 ? rem : ''}" placeholder="0"></div>
      <div class="chips">${rem > 0 ? `<button class="chip" onclick="setAmt(${rem})">كامل المتبقي (${fmt(rem)})</button>` : ''}
      ${rem > 1 ? `<button class="chip" onclick="setAmt(${Math.round(rem / 2)})">النصف (${fmt(Math.round(rem / 2))})</button>` : ''}</div>
      <div class="err" id="perr"></div>
      <div class="row"><button class="btn ok" onclick="submitPay()">تأكيد الاستلام</button><button class="btn ghost" onclick="mode='view';renderSheet()">رجوع</button></div></div>`;
  } else {
    body += `<div style="margin-top:16px"><div class="field"><label>سبب عدم الدفع</label>
      <div class="chips">${['البيت مغلق', 'لا يوجد مال حالياً', 'سيدفع لاحقاً', 'رفض الدفع', 'لم أجد الشخص'].map(t => `<button class="chip" onclick="setReason(this)">${t}</button>`).join('')}</div>
      <textarea id="reason" rows="3" placeholder="اكتب السبب"></textarea></div>
      <div class="err" id="perr"></div>
      <div class="row"><button class="btn bad" onclick="submitUnpaid()">تأكيد: لم يسدد</button><button class="btn ghost" onclick="mode='view';renderSheet()">رجوع</button></div></div>`;
  }
  $('#sheet').innerHTML = body;
}
function setAmt(v) { $('#payAmt').value = v; }
function setReason(el) { $('#reason').value = el.textContent; document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === el)); }
function submitPay() {
  const s = view.subs.find(x => x.id === curId);
  const amt = parseFloat($('#payAmt').value);
  const rem = s.amount > 0 ? s.amount - s.paidAmount : Infinity;
  if (!(amt > 0)) return $('#perr').textContent = 'اكتب مبلغاً صحيحاً';
  if (amt > rem + 0.001) return $('#perr').textContent = 'المبلغ أكبر من المتبقي (' + fmt(rem) + ')';
  const msg = (rem === Infinity || amt >= rem - 0.001) ? `تأكيد استلام ${fmt(amt)} من ${s.name}؟` : `تأكيد استلام دفعة جزئية ${fmt(amt)} من ${s.name}؟ سيبقى ${fmt(rem - amt)}.`;
  if (!confirm(msg)) return;
  enqueue({ type: 'pay', subId: s.id, subName: s.name, amount: amt });
  closeSheet();
}
function submitUnpaid() {
  const s = view.subs.find(x => x.id === curId);
  const reason = $('#reason').value.trim();
  if (!reason) return $('#perr').textContent = 'اكتب سبب عدم الدفع';
  enqueue({ type: 'unpaid', subId: s.id, subName: s.name, reason });
  closeSheet();
}
function undo() {
  const s = view.subs.find(x => x.id === curId);
  if (!confirm('إلغاء تسجيل "لم يسدد"؟')) return;
  enqueue({ type: 'undo', subId: s.id, subName: s.name });
  closeSheet();
}

let tt;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2600); }

// ---------- التشغيل ----------
window.addEventListener('online', () => { banner(); flush(); });
window.addEventListener('offline', banner);
document.addEventListener('visibilitychange', () => { if (!document.hidden) flush(); });
setInterval(() => { if (auth && !document.hidden) flush(); }, 45000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

if (auth) { showApp(); rebuild(); render(); banner(); flush(); } else showLogin();
