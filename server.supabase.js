// ====================================================================
// server.supabase.js  —  Supabase data layer (replaces server.js)
// --------------------------------------------------------------------
// Same public interface as the old Firebase server.js (data, loadData,
// dbSetDoc, dbAddDoc, dbDeleteDoc, nextCounterValue, the `auth` object...),
// so main.js keeps working with almost no changes.
//
// Each Firestore "document" is stored as a row: { id, branch, ts, data(jsonb) }.
// We read `row.data` back as the record (identical shape to before).
//
// Load order in index.html must be:
//   Supabase SDK (CDN)  ->  server.supabase.js  ->  main.js
// ====================================================================

// ==================== SUPABASE SETUP ====================
// The anon key is PUBLIC (like Firebase apiKey). Paste yours from
// Supabase Dashboard -> Project Settings -> API -> "anon public".
const SUPABASE_URL = 'https://yhzpbjijnrobdecekmgg.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InloenBiamlqbnJvYmRlY2VrbWdnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MjkwMDUsImV4cCI6MjA5ODMwNTAwNX0.N_j42fKjePPfCSvXgG1hoHaVZ62KtOyt5dX1PdFUe7w';

// The UMD global from the CDN is named `supabase`; our client is `sb`.
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- Firebase-compatible auth shim, so main.js's login code is unchanged ----
const auth = {
  currentUser: null,
  async signInWithEmailAndPassword(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      // Map to a Firebase-like code so loginErrorMessage() still works.
      const e = new Error(error.message);
      e.code = /invalid login|credential/i.test(error.message)
        ? 'auth/invalid-credential'
        : /network/i.test(error.message)
          ? 'auth/network-request-failed'
          : 'auth/unknown';
      throw e;
    }
  },
  signOut() {
    return sb.auth.signOut();
  },
  onAuthStateChanged(cb) {
    // Fires immediately with the current session, then on every change.
    sb.auth.onAuthStateChange((_event, session) => {
      auth.currentUser = session && session.user ? { email: session.user.email } : null;
      cb(auth.currentUser);
    });
  },
};

// Table names (used as the "collection refs" main.js passes around).
const traineesCol = 'trainees';
const attendanceCol = 'attendance';
const paymentsCol = 'payments';
const employeesCol = 'employees';
const expensesCol = 'expenses';
const groupsCol = 'groups';
const sessionsCol = 'sessions';
const staffAttendanceCol = 'staff_attendance';
const feedbackCol = 'feedback';

// Map of in-memory data key -> table name for the five history collections.
const historyTables = {
  attendance: 'attendance',
  payments: 'payments',
  expenses: 'expenses',
  staffAttendance: 'staff_attendance',
  feedback: 'feedback',
};

// ---- Branch merge: "فرع المريوطيه 1/2" were merged into one branch. Old DB
// rows still carry the legacy names, so normalize them on read (display,
// filters and reports all see the merged branch) and expand them in queries.
const LEGACY_BRANCHES = { 'فرع المريوطيه 1': 'فرع المريوطيه', 'فرع المريوطيه 2': 'فرع المريوطيه' };
const normalizeBranch = b => LEGACY_BRANCHES[b] || b;
// All DB column values that mean one (merged) branch.
function branchAliases(b) {
  return [b].concat(Object.keys(LEGACY_BRANCHES).filter(k => LEGACY_BRANCHES[k] === b));
}

// Turn a DB row { id, branch, ts, data } back into the original record,
// carrying its row id under _docId (so edit/delete still work).
const rowToRecord = r => {
  const rec = Object.assign({}, r.data, { _docId: r.id });
  if (rec.branch) rec.branch = normalizeBranch(rec.branch);
  return rec;
};

// ==================== READ WINDOWS ====================
const HISTORY_DAYS = 30;
const ATTENDANCE_DAYS = 14;
const REPORTS_DAYS = 30;
const HISTORY_COLLECTIONS = ['attendance', 'payments', 'expenses', 'staffAttendance', 'feedback'];
let historyFullyLoaded = false;
let defaultHistoryLoaded = false;
let loadedSections = { attendance: false, payments: false, expenses: false, staffAttendance: false, feedback: false };

// ---- Overlapping-load guard: each load takes a generation number; a section
// is only written if no NEWER load already wrote it. Otherwise a slow, older
// response (e.g. a 14-day window) could clobber data a newer one (e.g. the
// full history) had just applied. ----
let loadGen = 0;
const sectionGen = {};
function applySection(name, gen, rows) {
  if (gen < (sectionGen[name] || 0)) return false; // stale response — discard
  sectionGen[name] = gen;
  data[name] = rows.map(rowToRecord);
  loadedSections[name] = true;
  // Queued offline writes for this section must survive the reload.
  applyOutboxLocally(name);
  markSynced();
  return true;
}

// Per-device branch scope. '' = all branches (admin). A legacy stored value
// (pre-merge branch name) is normalized to the merged branch.
let currentBranch = normalizeBranch(localStorage.getItem('device-branch') || '');
function setDeviceBranch(b) {
  currentBranch = b && b !== 'الكل' ? normalizeBranch(b) : '';
  if (currentBranch) localStorage.setItem('device-branch', currentBranch);
  else localStorage.removeItem('device-branch');
}
function getDeviceBranch() {
  return currentBranch;
}
// Apply the branch filter to a Supabase query only when a branch is selected.
// Uses .in() so a merged branch also matches rows stored under legacy names.
function branchSel(q) {
  return currentBranch ? q.in('branch', branchAliases(currentBranch)) : q;
}

// Running totals shown on the dashboard (recomputed from the DB on each load).
let stats = { revenue: 0, expenses: 0 };
// Per-branch totals: { 'فرع ...': { revenue, expenses } } — lets the dashboard
// show each branch's own figures, and the sum when "كل الفروع" is selected.
let statsByBranch = {};

// ==================== DATA STORE ====================
let data = {
  trainees: [],
  attendance: [],
  payments: [],
  employees: [],
  expenses: [],
  groups: [],
  sessions: [],
  staffAttendance: [],
  feedback: [],
  counter: 1,
};

// ---- Paginated fetch: Supabase caps rows per request, so page through them
// in blocks of 1000 until a short page signals the end (works for any size). ----
async function fetchRows(table, build) {
  const PAGE = 1000;
  let from = 0,
    all = [];
  while (true) {
    let q = sb
      .from(table)
      .select('*')
      .range(from, from + PAGE - 1);
    if (build) q = build(q);
    const { data: rows, error } = await q;
    if (error) throw error;
    all = all.concat(rows || []);
    if (!rows || rows.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Keep a slimmed local copy so the app still opens read-only if offline.
function cacheLocally() {
  const KEEP = 800;
  const slim = {
    trainees: data.trainees,
    employees: data.employees,
    groups: data.groups,
    sessions: data.sessions,
    counter: data.counter,
    payments: (data.payments || []).slice(-KEEP),
    attendance: (data.attendance || []).slice(-KEEP),
    expenses: (data.expenses || []).slice(-KEEP),
    staffAttendance: (data.staffAttendance || []).slice(-KEEP),
    feedback: (data.feedback || []).slice(-KEEP),
  };
  try {
    localStorage.setItem('racer-data', JSON.stringify(slim));
  } catch (e) {
    try {
      localStorage.setItem(
        'racer-data',
        JSON.stringify({
          trainees: data.trainees,
          employees: data.employees,
          groups: data.groups,
          sessions: data.sessions,
          counter: data.counter,
          payments: [],
          attendance: [],
          expenses: [],
          staffAttendance: [],
          feedback: [],
        }),
      );
    } catch (e2) {
      /* storage full - not critical */
    }
  }
}

// Recompute revenue/expenses per branch via a SQL aggregate (reads are free).
// The global `stats` is the sum across branches; `statsByBranch` holds each.
async function recomputeStats() {
  try {
    const { data: rows, error } = await sb.rpc('branch_totals');
    if (error) throw error;
    statsByBranch = {};
    let rev = 0,
      exp = 0;
    (rows || []).forEach(r => {
      // Legacy branch names (pre-merge) fold into the merged branch's totals.
      const b = normalizeBranch(r.branch || 'غير محدد');
      if (!statsByBranch[b]) statsByBranch[b] = { revenue: 0, expenses: 0 };
      statsByBranch[b].revenue += num(r.revenue);
      statsByBranch[b].expenses += num(r.expenses);
      rev += num(r.revenue);
      exp += num(r.expenses);
    });
    stats.revenue = rev;
    stats.expenses = exp;
  } catch (e) {
    console.error('recomputeStats error:', e);
  }
}

// ==================== LOAD ====================
// Full-reload generation: if a NEWER loadData starts (e.g. the device branch
// is switched while the first load is still in flight), the older load's
// responses are discarded instead of overwriting the newer branch's data.
let fullLoadGen = 0;
async function loadData() {
  const gen = ++fullLoadGen;
  // Upload any queued offline writes FIRST, so the reload below reads them
  // back from the server instead of overwriting them.
  try {
    await flushOutbox();
  } catch (e) {
    /* still offline — the catch below serves the local cache */
  }
  try {
    // Current-state collections (small) load in full, branch-scoped.
    const [trainees, employees, groups, sessions] = await Promise.all([
      fetchRows(traineesCol, branchSel),
      fetchRows(employeesCol),
      fetchRows(groupsCol, branchSel),
      fetchRows(sessionsCol, branchSel),
    ]);
    if (gen !== fullLoadGen) return; // superseded by a newer reload
    data.trainees = trainees.map(rowToRecord);
    data.employees = employees.map(rowToRecord);
    data.groups = groups.map(rowToRecord);
    data.sessions = sessions.map(rowToRecord);

    // Counter (atomic value lives in meta).
    const { data: cRow } = await sb.from('meta').select('data').eq('id', 'counter').maybeSingle();
    if (gen !== fullLoadGen) return;
    data.counter = cRow && cRow.data ? cRow.data.value : data.trainees.length + 1;

    await recomputeStats();
    if (gen !== fullLoadGen) return;

    historyFullyLoaded = false;
    defaultHistoryLoaded = false;
    loadedSections = { attendance: false, payments: false, expenses: false, staffAttendance: false, feedback: false };

    // Today's attendance window is needed on first paint.
    await loadSection('attendance');
    // Anything still queued (e.g. flaky connection) stays visible in the UI.
    applyOutboxLocally();
    markSynced();
    cacheLocally();
  } catch (err) {
    if (gen !== fullLoadGen) return; // a newer reload owns the data now
    console.error('Supabase load error:', err);
    const saved = localStorage.getItem('racer-data');
    if (saved) data = JSON.parse(saved);
    // The local snapshot already contains the queued (offline) work, but
    // re-apply on top to be safe if the snapshot predates some queued ops.
    applyOutboxLocally();
    showNotification('تعذر الاتصال بقاعدة البيانات، يتم عرض آخر نسخة محفوظة محلياً', 'danger');
  }
  renderOutboxStatus();
}

// Load ONE history collection: branch-scoped + time-windowed.
async function loadSection(name) {
  const table = historyTables[name];
  if (!table) return;
  const days = name === 'attendance' ? ATTENDANCE_DAYS : HISTORY_DAYS;
  const cutoff = Date.now() - days * 86400000;
  const gen = ++loadGen;
  try {
    const rows = await fetchRows(table, q => branchSel(q).gte('ts', cutoff));
    if (!applySection(name, gen, rows)) return;
    cacheLocally();
  } catch (err) {
    console.error(`loadSection(${name}) error:`, err);
    showNotification('تعذر تحميل بيانات هذا القسم', 'danger');
  }
}

// Lazy-load a section then render it.
async function ensureSection(name, renderFn) {
  if (!loadedSections[name]) await loadSection(name);
  if (typeof renderFn === 'function') {
    try {
      renderFn();
    } catch (e) {
      console.error(e);
    }
  }
}

// Load history for a chosen date range (reports / financial dashboard).
async function loadHistoryRange(fromTs, toTs) {
  const gen = ++loadGen;
  let allApplied = true;
  try {
    showNotification('جارٍ تحميل بيانات الفترة المحددة...');
    await Promise.all(
      Object.keys(historyTables).map(async name => {
        const rows = await fetchRows(historyTables[name], q => {
          let qq = branchSel(q).gte('ts', fromTs);
          if (toTs) qq = qq.lte('ts', toTs);
          return qq;
        });
        if (!applySection(name, gen, rows)) allApplied = false;
      }),
    );
    // A newer load overwrote part of this one — its own flags win.
    if (!allApplied) return;
    historyFullyLoaded = false;
    defaultHistoryLoaded = true;
    cacheLocally();
    refreshHistoryViews();
    showNotification('تم تحميل بيانات الفترة المحددة');
  } catch (err) {
    console.error('loadHistoryRange error:', err);
    showNotification('تعذر تحميل بيانات الفترة', 'danger');
  }
}

// Default recent window for reports / financial dashboard (bounded read).
async function ensureRecentHistory(days = REPORTS_DAYS) {
  if (historyFullyLoaded || defaultHistoryLoaded) return;
  await loadHistoryRange(Date.now() - days * 86400000, 0);
}

// Load the FULL history (all dates), branch-scoped.
async function loadAllHistory() {
  if (historyFullyLoaded) {
    showNotification('السجل الكامل محمّل بالفعل');
    return;
  }
  const gen = ++loadGen;
  let allApplied = true;
  try {
    showNotification('جارٍ تحميل السجل الكامل...');
    await Promise.all(
      Object.keys(historyTables).map(async name => {
        const rows = await fetchRows(historyTables[name], branchSel);
        if (!applySection(name, gen, rows)) allApplied = false;
      }),
    );
    // A newer, narrower load overwrote part of this one — don't claim "full".
    if (!allApplied) return;
    historyFullyLoaded = true;
    defaultHistoryLoaded = true;
    await recomputeStats();
    cacheLocally();
    refreshHistoryViews();
    showNotification('تم تحميل السجل الكامل لكل الفترة');
  } catch (err) {
    console.error('loadAllHistory error:', err);
    showNotification('تعذر تحميل السجل الكامل', 'danger');
  }
}

// Re-window every already-loaded section.
async function reloadHistoryWindow() {
  for (const name of HISTORY_COLLECTIONS) {
    if (loadedSections[name]) {
      loadedSections[name] = false;
      await loadSection(name);
    }
  }
  refreshHistoryViews();
}

// Local-only running total bump (dashboard updates instantly; DB is the
// source of truth, recomputed via branch_totals() on the next load).
function bumpStat(field, delta, branch) {
  if (!delta) return;
  stats[field] = (stats[field] || 0) + delta;
  if (branch) {
    if (!statsByBranch[branch]) statsByBranch[branch] = { revenue: 0, expenses: 0 };
    statsByBranch[branch][field] = (statsByBranch[branch][field] || 0) + delta;
  }
}

// Re-render every view that depends on history data.
function refreshHistoryViews() {
  const fns = [
    'updateDashboard',
    'updateAttendanceLog',
    'updateFinancial',
    'updateSalaries',
    'updateReports',
    'renderFinancialDashboard',
    'renderStaffAttendance',
    'updateBadge',
  ];
  fns.forEach(fn => {
    try {
      if (typeof window[fn] === 'function') window[fn]();
    } catch (e) {
      /* ignore */
    }
  });
}

// ==================== OFFLINE OUTBOX ====================
// Every write goes to the DB immediately when possible. When the network is
// down (or writes are already queued, to preserve order) the operation is
// stored in a persistent queue and replayed automatically once the connection
// returns. This is what makes the app safe to use fully offline: nothing that
// was recorded (payments, players, attendance...) is ever lost.
const OUTBOX_KEY = 'racer-outbox';
let outbox = [];
try {
  outbox = JSON.parse(localStorage.getItem(OUTBOX_KEY)) || [];
} catch (e) {
  outbox = [];
}

function saveOutbox() {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
  } catch (e) {
    /* storage full — the in-memory queue still works for this session */
  }
  renderOutboxStatus();
}

// Network failures (offline, DNS, timeouts) are retryable; PostgREST errors
// (RLS denial, constraint...) carry a `code` and are NOT retryable forever.
function isNetworkError(err) {
  if (!navigator.onLine) return true;
  if (!err) return false;
  if (err.code && /^[0-9A-Z]{5}$/.test(String(err.code))) return false;
  const msg = String((err && err.message) || err);
  return /fetch|network|failed to|load failed|timeout/i.test(msg);
}

function enqueueOp(op) {
  op.opId = 'OP-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  op.tries = 0;
  outbox.push(op);
  saveOutbox();
}

// Refunds one session to a session-based subscriber whose offline check-in was
// later rejected as a cross-device duplicate. Without this, the session spent
// optimistically at check-in time would be lost even though the visit never
// counted. Re-activates the player if the refund lifts them off zero.
function restoreConsumedSession(traineeId) {
  const t = (data.trainees || []).find(x => x.id === traineeId);
  if (!t || t.subType !== 'sessions') return;
  t.sessionsRemaining = num(t.sessionsRemaining) + 1;
  if (t.status === 'منتهي' && t.sessionsRemaining > 0) t.status = 'نشط';
  dbSetDoc(traineesCol, t.id, t);
  if (typeof updateTraineesTable === 'function') updateTraineesTable();
  if (typeof updateDashboard === 'function') updateDashboard();
}

// Sends ONE queued op to Supabase. Throws on failure (caller decides retry).
async function sendOp(op) {
  if (op.kind === 'upsert') {
    const { error } = await sb.from(op.table).upsert(toRow(op.rowId, op.obj));
    if (error) throw error;
  } else if (op.kind === 'insert') {
    const row = { branch: op.obj.branch || null, ts: op.obj.ts || null, data: op.obj };
    if (op.table === attendanceCol) row.trainee_id = op.obj.id || null;
    const { error } = await sb.from(op.table).insert(row);
    // Unique-index rejection = another device already recorded it — drop ours.
    if (error && error.code === '23505') {
      // This queued check-in was a cross-device duplicate. If we optimistically
      // spent a session for it offline, refund that session — the check-in
      // never actually counted.
      if (op.table === attendanceCol && op.obj.sessionConsumed) restoreConsumedSession(op.obj.id);
      return;
    }
    if (error) throw error;
  } else if (op.kind === 'delete') {
    const { error } = await sb.from(op.table).delete().eq('id', String(op.rowId));
    if (error) throw error;
  } else if (op.kind === 'deleteWhere') {
    const { error } = await sb.from(op.table).delete().eq(op.column, op.value);
    if (error) throw error;
  } else if (op.kind === 'counter') {
    const { error } = await sb.from('meta').upsert({ id: 'counter', data: { value: op.value } });
    if (error) throw error;
  }
}

// Replays the queue in order. Stops on the first network failure (still
// offline — retried on the next 'online' event / timer). A non-network error
// is retried up to 5 flushes, then dropped so it can't block the queue.
// Concurrent callers share the SAME in-flight promise, so `await flushOutbox()`
// really waits for the upload to finish (loadData depends on this).
let flushPromise = null;
function flushOutbox() {
  if (flushPromise) return flushPromise;
  if (outbox.length === 0) {
    renderOutboxStatus();
    return Promise.resolve();
  }
  flushPromise = doFlushOutbox().finally(() => {
    flushPromise = null;
  });
  return flushPromise;
}
async function doFlushOutbox() {
  const had = outbox.length;
  renderOutboxStatus('sending');
  try {
    while (outbox.length) {
      const op = outbox[0];
      try {
        await sendOp(op);
        outbox.shift();
        saveOutbox();
      } catch (err) {
        if (isNetworkError(err)) break; // still offline — try again later
        // Auth problems (expired session, RLS refusal) must NEVER drop the
        // queued work — it uploads after the next sign-in. Keep and retry.
        const authErr =
          err &&
          (err.status === 401 ||
            err.status === 403 ||
            String(err.code) === '42501' ||
            /jwt|token|auth|api key/i.test(String(err.message || '')));
        if (authErr) {
          if (typeof showNotification === 'function')
            showNotification('توجد عمليات معلّقة بحاجة لتسجيل الدخول لرفعها', 'warning');
          break;
        }
        op.tries = (op.tries || 0) + 1;
        console.error('Outbox op failed (try ' + op.tries + '):', op, err);
        if (op.tries >= 5) {
          outbox.shift(); // drop permanently-failing op so the rest can flow
          if (typeof showNotification === 'function')
            showNotification('تعذر رفع إحدى العمليات نهائياً — راجع سجل الأخطاء', 'danger');
        }
        saveOutbox();
        break; // don't hot-loop on a failing op; retry on the next flush
      }
    }
  } finally {
    renderOutboxStatus();
    if (had > 0 && outbox.length === 0 && typeof showNotification === 'function') {
      showNotification('تم رفع كل العمليات المعلّقة بنجاح ✅');
    }
  }
}

// Re-applies queued (not-yet-uploaded) ops on top of freshly loaded data, so
// a reload from the server can never make offline work disappear from the UI.
const TABLE_TO_KEY = {
  trainees: 'trainees',
  employees: 'employees',
  groups: 'groups',
  sessions: 'sessions',
  attendance: 'attendance',
  payments: 'payments',
  expenses: 'expenses',
  staff_attendance: 'staffAttendance',
  feedback: 'feedback',
};
function applyOutboxLocally(onlyKey) {
  outbox.forEach(op => {
    const key = TABLE_TO_KEY[op.table];
    if (!key || !Array.isArray(data[key])) return;
    if (onlyKey && key !== onlyKey) return;
    if (op.kind === 'upsert') {
      const rec = Object.assign({}, op.obj, { _docId: op.rowId });
      // Match by the ROW id only (falling back to .id for records that never
      // got a _docId locally, like trainees). Never match payments by their
      // .id field — that's the PLAYER id and collides ('—' for manual ones).
      const i = data[key].findIndex(r => String(r._docId != null ? r._docId : r.id) === String(op.rowId));
      if (i >= 0) data[key][i] = rec;
      else data[key].push(rec);
    } else if (op.kind === 'insert') {
      const dup = data[key].some(r => r.ts === op.obj.ts && r.id === op.obj.id);
      if (!dup) data[key].push(Object.assign({}, op.obj));
    } else if (op.kind === 'delete') {
      data[key] = data[key].filter(r => String(r._docId) !== String(op.rowId) && String(r.id) !== String(op.rowId));
    } else if (op.kind === 'deleteWhere') {
      const field = op.column === 'trainee_id' ? 'id' : op.column;
      data[key] = data[key].filter(r => r[field] !== op.value);
    }
  });
}

// ==================== LAST-SYNC INDICATOR ====================
// Timestamp of the last successful read from the server, shown in the header
// so staff can tell at a glance whether the data on screen is fresh.
let lastSyncAt = 0;
function markSynced() {
  lastSyncAt = Date.now();
  renderLastSync();
}
function renderLastSync() {
  const el = document.getElementById('last-sync');
  if (!el) return;
  if (!lastSyncAt) {
    el.textContent = '';
    return;
  }
  const mins = Math.floor((Date.now() - lastSyncAt) / 60000);
  let txt;
  if (mins < 1) txt = 'الآن';
  else if (mins < 60) txt = `منذ ${mins} دقيقة`;
  else txt = new Date(lastSyncAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  el.textContent = '🔄 آخر تحديث: ' + txt;
}
// Refresh the relative label every minute.
setInterval(renderLastSync, 60000);

// Header chip showing the offline/pending state. Hidden when all is well.
function renderOutboxStatus(state) {
  const el = document.getElementById('outbox-status');
  if (!el) return;
  const n = outbox.length;
  if (state === 'sending' && n > 0) {
    el.style.display = '';
    el.className = 'outbox-chip sending';
    el.textContent = `⏫ جارٍ رفع ${n} عملية...`;
    return;
  }
  if (n > 0) {
    el.style.display = '';
    el.className = 'outbox-chip pending';
    el.textContent = navigator.onLine ? `⏳ ${n} عملية بانتظار الرفع` : `📴 أوفلاين — ${n} عملية بانتظار الرفع`;
  } else if (!navigator.onLine) {
    el.style.display = '';
    el.className = 'outbox-chip offline';
    el.textContent = '📴 أوفلاين — يعمل محلياً';
  } else {
    el.style.display = 'none';
  }
}

// Flush triggers: connection returns, and a safety timer while ops are queued.
window.addEventListener('online', () => {
  renderOutboxStatus();
  flushOutbox();
});
window.addEventListener('offline', () => renderOutboxStatus());
setInterval(() => {
  if (navigator.onLine && outbox.length) flushOutbox();
}, 30000);

// ==================== WRITE HELPERS ====================
// Build the row stored for a record: scalar branch/ts columns + the full
// object as JSONB (so the record shape main.js expects is preserved).
function toRow(id, obj) {
  return { id: String(id), branch: obj.branch || null, ts: obj.ts || null, data: obj };
}

// True when a write must be queued instead of sent directly: we're offline,
// or older ops are already queued (sending now would break write order).
function mustQueue() {
  return !navigator.onLine || outbox.length > 0;
}

// ---- Per-row write chains: two quick saves of the SAME record fire two HTTP
// requests that can reach the server in REVERSE order, making the older state
// win (e.g. registerTrainee saves the player, then saves again with add-ons —
// the add-ons could be lost). Chaining runs each row's writes sequentially in
// call order; different rows still write in parallel. ----
const writeChains = {};
function chainWrite(key, fn) {
  const prev = writeChains[key] || Promise.resolve();
  const run = prev.then(fn, fn); // run regardless of the previous write's fate
  const tail = run.then(
    () => {
      if (writeChains[key] === tail) delete writeChains[key];
    },
    () => {
      if (writeChains[key] === tail) delete writeChains[key];
    },
  );
  writeChains[key] = tail;
  return run;
}

function dbSetDoc(table, id, obj) {
  const isNew = obj && obj.ts == null;
  if (isNew) {
    obj.ts = Date.now();
    // Audit: stamp who created this record (the logged-in user's email).
    if (auth.currentUser && obj.createdBy == null) obj.createdBy = auth.currentUser.email;
  }
  cacheLocally();
  // Only payments that count as revenue (subscriptions + sales — see
  // countsAsRevenue in main.js) bump the live revenue total; tournaments,
  // medical check-ups and "أخرى" are recorded but excluded from totals.
  if (isNew && table === paymentsCol && (typeof countsAsRevenue !== 'function' || countsAsRevenue(obj)))
    bumpStat('revenue', num(obj.amount), obj.branch);
  if (isNew && table === expensesCol) bumpStat('expenses', num(obj.amount), obj.branch);
  // Snapshot NOW: the caller may keep mutating the object after this call —
  // this write must carry the state as of this exact moment.
  const snapshot = JSON.parse(JSON.stringify(obj));
  return chainWrite(`${table}/${id}`, async () => {
    if (mustQueue()) {
      enqueueOp({ kind: 'upsert', table, rowId: String(id), obj: snapshot });
      flushOutbox();
      return;
    }
    try {
      const { error } = await sb.from(table).upsert(toRow(id, snapshot));
      if (error) throw error;
    } catch (err) {
      if (isNetworkError(err)) {
        enqueueOp({ kind: 'upsert', table, rowId: String(id), obj: snapshot });
        showNotification('لا يوجد اتصال — ستُرفع العملية تلقائياً عند عودة النت', 'warning');
        return;
      }
      console.error('Supabase set error:', err);
      showNotification('تعذر الحفظ في قاعدة البيانات', 'danger');
    }
  });
}

// Used for attendance (auto-generated id). trainee_id is extracted so a
// player's attendance can be deleted when the player is removed.
// Returns { ok, duplicate }: `duplicate` is true when the DB's unique index
// rejected the row (another device already inserted the same attendance) —
// callers undo their local copy instead of showing a scary error. Offline,
// the row is queued ({ok:true, queued:true}) and a same-day duplicate from
// another device is resolved by the DB constraint at upload time.
async function dbAddDoc(table, obj) {
  if (obj && obj.ts == null) obj.ts = Date.now();
  if (obj && obj.createdBy == null && auth.currentUser) obj.createdBy = auth.currentUser.email;
  cacheLocally();
  if (mustQueue()) {
    enqueueOp({ kind: 'insert', table, obj: JSON.parse(JSON.stringify(obj)) });
    flushOutbox();
    return { ok: true, duplicate: false, queued: true };
  }
  const row = { branch: obj.branch || null, ts: obj.ts || null, data: obj };
  if (table === attendanceCol) row.trainee_id = obj.id || null;
  try {
    const { error } = await sb.from(table).insert(row);
    if (error) throw error;
    return { ok: true, duplicate: false };
  } catch (err) {
    if (err && err.code === '23505') return { ok: false, duplicate: true };
    if (isNetworkError(err)) {
      enqueueOp({ kind: 'insert', table, obj: JSON.parse(JSON.stringify(obj)) });
      showNotification('لا يوجد اتصال — ستُرفع العملية تلقائياً عند عودة النت', 'warning');
      return { ok: true, duplicate: false, queued: true };
    }
    console.error('Supabase add error:', err);
    showNotification('تعذر الحفظ في قاعدة البيانات', 'danger');
    return { ok: false, duplicate: false };
  }
}

function dbDeleteDoc(table, id) {
  cacheLocally();
  // Chained on the same per-row key as dbSetDoc, so an edit followed by a
  // quick delete can never arrive reversed (which would resurrect the row).
  return chainWrite(`${table}/${id}`, async () => {
    if (mustQueue()) {
      enqueueOp({ kind: 'delete', table, rowId: String(id) });
      flushOutbox();
      return;
    }
    try {
      // count:'exact' exposes silent RLS refusals: a delete the policy blocks
      // returns no error but affects 0 rows — surface that instead of hiding it.
      const { error, count } = await sb.from(table).delete({ count: 'exact' }).eq('id', String(id));
      if (error) throw error;
      if (count === 0) {
        showNotification(
          'لم يُحذف السجل من قاعدة البيانات — غالباً لا تملك صلاحية الحذف (سيعود بعد التحديث)',
          'danger',
        );
      }
    } catch (err) {
      if (isNetworkError(err)) {
        enqueueOp({ kind: 'delete', table, rowId: String(id) });
        showNotification('لا يوجد اتصال — سيُحذف من قاعدة البيانات عند عودة النت', 'warning');
        return;
      }
      console.error('Supabase delete error:', err);
      showNotification('تعذر الحذف من قاعدة البيانات السحابية', 'danger');
    }
  });
}

// Delete every row where a field equals a value (used to remove a deleted
// player's attendance — stored under the trainee_id column).
async function dbDeleteWhere(table, field, value) {
  cacheLocally();
  const column = table === attendanceCol && field === 'id' ? 'trainee_id' : field;
  if (mustQueue()) {
    enqueueOp({ kind: 'deleteWhere', table, column, value });
    flushOutbox();
    return;
  }
  try {
    const { error } = await sb.from(table).delete().eq(column, value);
    if (error) throw error;
  } catch (err) {
    if (isNetworkError(err)) {
      enqueueOp({ kind: 'deleteWhere', table, column, value });
      return;
    }
    console.error('Supabase delete-where error:', err);
    showNotification('تعذر حذف بعض السجلات المرتبطة من قاعدة البيانات', 'danger');
  }
}

async function dbSaveCounter() {
  cacheLocally();
  if (mustQueue()) {
    // Only the LATEST counter value matters — replace any queued one.
    const existing = outbox.find(op => op.kind === 'counter');
    if (existing) {
      existing.value = data.counter;
      saveOutbox();
    } else {
      enqueueOp({ kind: 'counter', value: data.counter });
    }
    flushOutbox();
    return;
  }
  try {
    const { error } = await sb.from('meta').upsert({ id: 'counter', data: { value: data.counter } });
    if (error) throw error;
  } catch (err) {
    if (isNetworkError(err)) {
      enqueueOp({ kind: 'counter', value: data.counter });
      return;
    }
    console.error('Supabase counter error:', err);
  }
}

// Checks the WHOLE table (not this device's branch-filtered copy) for an id.
// Used when generating a new player id: another branch's player is invisible
// locally, so only the DB can say the id is really free.
async function dbIdExists(table, id) {
  const { data: row, error } = await sb.from(table).select('id').eq('id', String(id)).maybeSingle();
  if (error) throw error;
  return !!row;
}

// Atomically reserve the next trainee number via the next_counter() SQL
// function, so two devices can never get the same code. Falls back locally.
async function nextCounterValue() {
  try {
    const { data: v, error } = await sb.rpc('next_counter');
    if (error) throw error;
    data.counter = v + 1;
    cacheLocally();
    return v;
  } catch (err) {
    console.error('Counter RPC error (using local fallback):', err);
    const fallback = data.counter++;
    dbSaveCounter();
    return fallback;
  }
}
