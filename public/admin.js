'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = p => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
$('#refBtn').innerHTML = svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>');
$('#outBtn').innerHTML = svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>');

let token = localStorage.getItem('atok');
let agentFilter = 'all';
let tab = 'overview', day = null, stats = null, data = null, users = [], subFilter = 'all', busy = false;
const CUR = () => (stats && stats.currency) || '';
const fmt = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + (CUR() ? ' ' + CUR() : '');
const ST = { pending: 'بانتظار التحصيل', partial: 'دفع جزئي', paid: 'تم الدفع', unpaid: 'لم يسدد' };
const TABS = [['overview', 'نظرة عامة'], ['subs', 'المشتركون'], ['agents', 'المندوبون'], ['upload', 'رفع الإكسل']];

async function api(path, opts = {}) {
  const h = { Authorization: 'Bearer ' + token };
  if (!(opts.body instanceof FormData)) h['Content-Type'] = 'application/json';
  const r = await fetch(path, { ...opts, headers: h });
  if (r.status === 401) { logout(); throw new Error('انتهت الجلسة'); }
  const ct = r.headers.get('content-type') || '';
  if (!r.ok) { const d = ct.includes('json') ? await r.json().catch(() => ({})) : {}; throw new Error(d.error || 'حدث خطأ'); }
  return ct.includes('json') ? r.json() : r.blob();
}
let tt;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2800); }
const guard = async fn => { try { await fn(); } catch (e) { toast(e.message); } };

// ---------- الدخول ----------
async function login() {
  $('#lerr').textContent = '';
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'admin', password: $('#pw').value }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'خطأ');
    token = d.token; localStorage.setItem('atok', token); $('#pw').value = ''; start();
  } catch (e) { $('#lerr').textContent = e.message; }
}
function logout() { localStorage.removeItem('atok'); token = null; $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
function start() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); loadAll(); }

async function loadAll(manual) {
  await guard(async () => {
    const [s, d, u] = await Promise.all([api('/api/stats' + (day ? '?day=' + day : '')), api('/api/subs'), api('/api/users')]);
    stats = s; day = s.day; data = d; users = u; render();
    if (manual === true) toast('تم التحديث');
  });
}
function setTab(t) { tab = t; render(); window.scrollTo(0, 0); }
function setDay(v) { if (v) { day = v; loadAll(); } }

function render() {
  if (!stats) return;
  $('#nav').innerHTML = TABS.map(([k, t]) => `<button class="${tab === k ? 'on' : ''}" onclick="setTab('${k}')">${t}</button>`).join('');
  $('#view').innerHTML = { overview: vOverview, subs: vSubs, agents: vAgents, upload: vUpload }[tab]();
}

// ---------- نظرة عامة ----------
function vOverview() {
  const s = stats, pct = s.due > 0 ? Math.min(100, Math.round(s.paidTotal / s.due * 100)) : 0;
  const tgTxt = !s.tgConfigured ? 'تليجرام غير مضبوط (BOT_TOKEN / CHAT_ID)'
    : s.tg.fail && s.tg.last ? `تليجرام: تعذّر إرسال ${s.tg.fail} رسالة — ${esc(s.tg.last)}` : `تليجرام يعمل (${s.tg.ok} رسالة منذ آخر تشغيل)`;
  const tgCls = !s.tgConfigured || s.tg.fail ? 'no' : 'ok';
  return `
  <div class="card" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <b>تاريخ التقرير</b><input type="date" value="${s.day}" onchange="setDay(this.value)" style="width:auto;flex:1;min-width:150px">
  </div>
  <div class="stat-grid">
    <div class="stat g"><small>المستلم في هذا اليوم</small><b>${fmt(s.collectedDay)}</b></div>
    <div class="stat b"><small>عدد الدفعات</small><b>${s.countDay}</b></div>
    <div class="stat r"><small>المتبقي للتحصيل</small><b>${fmt(s.leftAmt)}</b></div>
    <div class="stat"><small>مشتركو القائمة</small><b>${s.total}</b></div>
  </div>
  <div class="card"><h3>حالة القائمة الحالية ${s.uploadedAt ? `<small style="color:var(--muted);font-weight:400">— رُفعت: ${esc(s.uploadedAt)}</small>` : ''}</h3>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <small style="color:var(--muted)">تم تحصيل ${fmt(s.paidTotal)} من ${fmt(s.due)} (${pct}%)</small>
    <div class="legend" style="margin-top:12px">${['paid', 'partial', 'unpaid', 'pending'].map(k => `<span class="pill ${k}">${ST[k]}: ${s.by[k] || 0}</span>`).join('')}</div>
  </div>
  ${s.unassigned ? `<div class="banner off">يوجد ${s.unassigned} مشترك من قائمة قديمة بلا مندوب. صفّرها من تبويب "رفع الإكسل" ثم ارفع القوائم لكل مندوب.</div>` : ''}
  <div class="card"><h3>حساب المندوبين</h3>
    ${s.agents.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>المندوب</th><th>قائمته</th><th>الدفعات</th><th>المستلم</th><th>لم يسدد</th></tr></thead><tbody>
    ${s.agents.map(a => `<tr><td>${esc(a.name)}${a.active ? '' : ' <small style="color:var(--muted)">(موقوف)</small>'}</td><td>${a.subs}</td><td>${a.count}</td><td><b>${fmt(a.collected)}</b></td><td>${a.unpaid}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty" style="padding:16px">لا يوجد مندوبون بعد. أضفهم من تبويب "المندوبون".</div>'}
  </div>
  <div class="card"><h3>دفعات اليوم (${s.payments.length})</h3>
    ${s.payments.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>الوقت</th><th>المندوب</th><th>المشترك</th><th>المبلغ</th></tr></thead><tbody>
    ${s.payments.map(p => `<tr><td><small>${esc(p.time)}</small></td><td>${esc(p.agent)}</td><td>${esc(p.sub)}</td><td><b>${fmt(p.amount)}</b></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty" style="padding:16px">لا توجد دفعات في هذا اليوم</div>'}
  </div>
  <div class="card"><h3>التقارير</h3>
    <div class="row" style="flex-wrap:wrap;margin-bottom:10px">
      <button class="btn ok sm" onclick="dl('paid')">الذين دفعوا</button>
      <button class="btn bad sm" onclick="dl('unpaid')">الذين لم يدفعوا</button>
      <button class="btn ghost sm" onclick="dl('agents')">حساب المندوبين</button>
    </div>
    <button class="btn block" id="sendBtn" onclick="sendReports()">إرسال ملخص اليوم والملفات إلى تليجرام</button>
    <button class="btn ghost block" style="margin-top:8px" onclick="testTg()">اختبار اتصال تليجرام</button>
    <div class="tg"><span class="d ${tgCls}"></span><span>${tgTxt}</span></div>
  </div>`;
}
async function dl(kind) {
  await guard(async () => {
    const blob = await api(`/api/export/${kind}?day=${day}`);
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `${kind}-${day}.xlsx`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}
async function sendReports() {
  const b = $('#sendBtn'); b.disabled = true;
  await guard(async () => { await api('/api/send-reports', { method: 'POST', body: JSON.stringify({ day }) }); toast('تم الإرسال إلى تليجرام ✓'); });
  b.disabled = false; loadAll();
}
async function testTg() { await guard(async () => { await api('/api/test-telegram', { method: 'POST' }); toast('وصلت رسالة الاختبار ✓'); }); loadAll(); }

// ---------- المشتركون ----------
const agentName = id => (users.find(u => u.id === id) || {}).name || 'بلا مندوب';
function vSubs() {
  const q = ($('#sq') && $('#sq').value || '').trim().toLowerCase();
  const list = data.subs.filter(s => agentFilter === 'all' || (s.agentId || '') === agentFilter);
  const cnt = k => k === 'all' ? list.length : list.filter(s => s.status === k).length;
  const rows = list.filter(s => (subFilter === 'all' || s.status === subFilter) && (!q || [s.name, s.phone, s.address, s.region, s.by].join(' ').toLowerCase().includes(q)));
  return `<div class="field"><select onchange="agentFilter=this.value;render()" style="width:100%;padding:13px 14px;border:1.5px solid var(--line);border-radius:14px;background:var(--soft);color:var(--ink);font:inherit">
      <option value="all">كل المندوبين</option>
      ${users.map(u => `<option value="${u.id}" ${agentFilter === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
      <option value="" ${agentFilter === '' ? 'selected' : ''}>بلا مندوب</option></select></div>
    <div class="search"><span>${svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>')}</span>
    <input id="sq" type="search" placeholder="بحث" value="${esc(q)}" oninput="keepSearch()"></div>
    <div class="tabs">${[['all', 'الكل'], ['pending', 'بانتظار'], ['partial', 'جزئي'], ['paid', 'مسدد'], ['unpaid', 'لم يسدد']]
      .map(([k, t]) => `<button class="tab ${subFilter === k ? 'on' : ''}" onclick="subFilter='${k}';render()">${t}<b>${cnt(k)}</b></button>`).join('')}</div>
    <div>${rows.length ? rows.map(s => `
      <div class="sub" style="cursor:default">
        <div class="avatar av-${s.status}">${esc((s.name || '?').charAt(0))}</div>
        <div class="mid"><b>${esc(s.name)}</b><small>${esc([s.region, s.address].filter(Boolean).join(' • '))}</small>
          <small>المندوب: ${esc(agentName(s.agentId))}${s.amount > 0 || s.paidAmount > 0 ? ` • المستحق ${fmt(s.amount)} • المدفوع ${fmt(s.paidAmount)}` : ''}</small>
          ${s.reason ? `<small style="color:var(--bad)">السبب: ${esc(s.reason)}</small>` : ''}</div>
        <div class="end"><span class="pill ${s.status}">${ST[s.status]}</span>
          ${s.status !== 'pending' ? `<br><button class="btn ghost sm" style="margin-top:6px;padding:5px 10px" onclick="resetSub(${s.id},'${esc(s.name).replace(/'/g, '')}')">إلغاء</button>` : ''}</div>
      </div>`).join('') : '<div class="empty">لا توجد نتائج</div>'}</div>`;
}
function keepSearch() {
  const el = $('#sq'), v = el.value, pos = el.selectionStart;
  render(); const n = $('#sq'); n.value = v; n.focus(); try { n.setSelectionRange(pos, pos); } catch {}
}
async function resetSub(id, name) {
  if (!confirm(`إلغاء تسجيل ${name} وإرجاعه لحالة "بانتظار التحصيل"؟ إذا كان عليه دفعات فستُلغى من الحساب.`)) return;
  await guard(async () => { await api(`/api/subs/${id}/reset`, { method: 'POST' }); toast('تم الإلغاء'); await loadAll(); });
}

// ---------- المندوبون ----------
function vAgents() {
  const cnt = id => ((stats.agents.find(a => a.id === id) || {}).subs) || 0;
  return `<div style="margin-bottom:12px"><button class="btn block" onclick="openUser()">+ إضافة مندوب</button></div>
  <div class="card">${users.length ? users.map(u => `
    <div class="agent">
      <div class="avatar av-${u.active ? 'pending' : 'unpaid'}">${esc(u.name.charAt(0))}</div>
      <div class="mid"><b>${esc(u.name)}</b><small dir="ltr" style="text-align:right">@${esc(u.username)}</small>
        <small>${cnt(u.id)} مشترك في قائمته</small></div>
      <button class="btn ghost sm" onclick="openUser('${u.id}')">تعديل</button>
      <label class="switch"><input type="checkbox" ${u.active ? 'checked' : ''} onchange="toggleUser('${u.id}',this.checked)"><span></span></label>
    </div>`).join('') : '<div class="empty">لا يوجد مندوبون. اضغط "إضافة مندوب".</div>'}
    <div class="note">المفتاح الأخضر يعني الحساب فعّال. إيقافه يمنع المندوب من الدخول فوراً. كل مندوب يرى القائمة التي رفعتها له فقط.</div></div>`;
}
async function toggleUser(id, on) {
  await guard(async () => { await api('/api/users/' + id, { method: 'PUT', body: JSON.stringify({ active: on }) }); toast(on ? 'تم تفعيل الحساب' : 'تم إيقاف الحساب'); });
  loadAll();
}
function openUser(id) {
  const u = users.find(x => x.id === id) || null;
  $('#sheet').innerHTML = `<div class="grab"></div><h2>${u ? 'تعديل مندوب' : 'مندوب جديد'}</h2>
    <div class="field"><label>الاسم</label><input id="fName" value="${esc(u ? u.name : '')}"></div>
    <div class="field"><label>اسم المستخدم (للدخول)</label><input id="fUser" dir="ltr" style="text-align:right" autocapitalize="none" value="${esc(u ? u.username : '')}" ${u ? 'disabled' : ''}></div>
    <div class="field"><label>${u ? 'كلمة سر جديدة (اتركها فارغة إن لم ترد التغيير)' : 'كلمة السر'}</label><input id="fPass" type="text" dir="ltr" style="text-align:right" autocomplete="off"></div>
    <div class="err" id="ferr"></div>
    <div class="row"><button class="btn" onclick="saveUser('${u ? u.id : ''}')">حفظ</button><button class="btn ghost" onclick="closeSheet()">إلغاء</button></div>`;
  $('#bg').classList.add('show');
}
function closeSheet() { $('#bg').classList.remove('show'); }
async function saveUser(id) {
  const body = { name: $('#fName').value };
  if ($('#fPass').value) body.password = $('#fPass').value;
  if (!id) { body.username = $('#fUser').value; if (!body.password) return $('#ferr').textContent = 'اكتب كلمة السر'; }
  try {
    await api(id ? '/api/users/' + id : '/api/users', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    closeSheet(); toast('تم الحفظ ✓'); loadAll();
  } catch (e) { $('#ferr').textContent = e.message; }
}

// ---------- رفع الإكسل ----------
function vUpload() {
  const opts = users.map(u => `<option value="${u.id}">${esc(u.name)}${u.active ? '' : ' (موقوف)'}</option>`).join('');
  const clr = users.map(u => `<option value="${u.id}">قائمة ${esc(u.name)} فقط</option>`).join('');
  return (users.length ? `<div class="card"><h3>رفع قائمة لمندوب</h3>
    <div class="field"><label>المندوب صاحب القائمة</label>
      <select id="upAgent" style="width:100%;padding:13px 14px;border:1.5px solid var(--line);border-radius:14px;background:var(--soft);color:var(--ink);font:inherit"><option value="">— اختر المندوب —</option>${opts}</select></div>
    <div class="field"><label>طريقة الرفع</label>
      <select id="upMode" style="width:100%;padding:13px 14px;border:1.5px solid var(--line);border-radius:14px;background:var(--soft);color:var(--ink);font:inherit"><option value="replace">استبدال قائمته الحالية</option><option value="append">إضافة إلى قائمته الحالية</option></select></div>
    <div class="file">اختر ملف Excel (.xlsx)<input id="file" type="file" accept=".xlsx,.xls,.csv"></div>
    <div class="err" id="uerr"></div>
    <button class="btn block" id="upBtn" onclick="upload()">رفع الملف</button>
    <button class="btn ghost block" style="margin-top:8px" onclick="tpl()">تنزيل نموذج جاهز</button></div>`
  : `<div class="card"><div class="empty">أضف مندوباً أولاً من تبويب "المندوبون"، ثم ارفع له القائمة.</div></div>`) + `
  <div class="card"><h3>تصفير القائمة</h3>
    <p style="color:var(--muted);font-size:14px;margin-top:0">يحذف المشتركين من القائمة. حساب الدفعات السابقة يبقى، لكن ملفات "الذين دفعوا" و"الذين لم يدفعوا" تُبنى من القائمة الحالية، فنزّلها من تبويب "نظرة عامة" قبل التصفير.</p>
    <div class="field"><select id="clrTarget" style="width:100%;padding:13px 14px;border:1.5px solid var(--line);border-radius:14px;background:var(--soft);color:var(--ink);font:inherit"><option value="all">كل القوائم (كل المندوبين)</option>${clr}${stats.unassigned ? '<option value="unassigned">المشتركون بلا مندوب</option>' : ''}</select></div>
    <button class="btn bad block" onclick="clearList()">تصفير القائمة</button></div>
  <div class="card"><h3>الأعمدة المدعومة</h3>
    <div class="legend">${['الاسم', 'المنطقة', 'العنوان', 'الرقم', 'اليوزر', 'نوع الاشتراك', 'المبلغ', 'ملاحظات'].map(c => `<span class="pill pending">${c}</span>`).join('')}</div>
    <div class="note">عمود <b>الاسم</b> إلزامي. عمود <b>المبلغ</b> ضروري لحساب الدفع الجزئي والمتبقي. كل قائمة تُرفع تصبح لمندوب واحد يراها وحده.</div></div>`;
}
async function tpl() {
  await guard(async () => {
    const blob = await api('/api/template'), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'نموذج-المشتركين.xlsx'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}
async function upload() {
  $('#uerr').textContent = '';
  const agentId = $('#upAgent').value, mode = $('#upMode').value, f = $('#file').files[0];
  if (!agentId) return $('#uerr').textContent = 'اختر المندوب أولاً';
  if (!f) return $('#uerr').textContent = 'اختر ملفاً أولاً';
  const name = agentName(agentId);
  if (!confirm(mode === 'replace' ? `سيتم استبدال قائمة ${name} الحالية بهذا الملف. متابعة؟` : `سيتم إضافة مشتركي الملف إلى قائمة ${name}. متابعة؟`)) return;
  const fd = new FormData();
  fd.append('agentId', agentId); fd.append('mode', mode); fd.append('file', f);
  $('#upBtn').disabled = true;
  try {
    const r = await api('/api/upload', { method: 'POST', body: fd });
    toast(`تم رفع ${r.count} مشترك إلى ${r.agent} ✓`); tab = 'overview'; await loadAll();
  } catch (e) { $('#uerr').textContent = e.message; $('#upBtn').disabled = false; }
}
async function clearList() {
  const sel = $('#clrTarget'), target = sel.value, label = sel.options[sel.selectedIndex].text;
  const n = data.subs.filter(s => target === 'all' || (target === 'unassigned' ? !s.agentId : s.agentId === target)).length;
  if (!n) return toast('لا يوجد مشتركون في هذا النطاق');
  if (!confirm(`سيتم حذف ${n} مشترك (${label}) من القائمة. هل نزّلت التقارير التي تحتاجها؟ متابعة؟`)) return;
  if (target === 'all' && !confirm('تأكيد أخير: تصفير كل القوائم لكل المندوبين؟')) return;
  await guard(async () => { const r = await api('/api/subs/clear', { method: 'POST', body: JSON.stringify({ agentId: target }) }); toast(`تم حذف ${r.removed} مشترك ✓`); await loadAll(); });
}

if (token) start(); else $('#login').classList.remove('hidden');
