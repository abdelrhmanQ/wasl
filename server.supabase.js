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
async function loadData() {
  try {
    // Current-state collections (small) load in full, branch-scoped.
    const [trainees, employees, groups, sessions] = await Promise.all([
      fetchRows(traineesCol, branchSel),
      fetchRows(employeesCol),
      fetchRows(groupsCol, branchSel),
      fetchRows(sessionsCol, branchSel),
    ]);
    data.trainees = trainees.map(rowToRecord);
    data.employees = employees.map(rowToRecord);
    data.groups = groups.map(rowToRecord);
    data.sessions = sessions.map(rowToRecord);

    // Counter (atomic value lives in meta).
    const { data: cRow } = await sb.from('meta').select('data').eq('id', 'counter').maybeSingle();
    data.counter = cRow && cRow.data ? cRow.data.value : data.trainees.length + 1;

    await recomputeStats();

    historyFullyLoaded = false;
    defaultHistoryLoaded = false;
    loadedSections = { attendance: false, payments: false, expenses: false, staffAttendance: false, feedback: false };

    // Today's attendance window is needed on first paint.
    await loadSection('attendance');
    cacheLocally();
  } catch (err) {
    console.error('Supabase load error:', err);
    const saved = localStorage.getItem('racer-data');
    if (saved) data = JSON.parse(saved);
    showNotification('تعذر الاتصال بقاعدة البيانات، يتم عرض آخر نسخة محفوظة محلياً', 'danger');
  }
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

// ==================== WRITE HELPERS ====================
// Build the row stored for a record: scalar branch/ts columns + the full
// object as JSONB (so the record shape main.js expects is preserved).
function toRow(id, obj) {
  return { id: String(id), branch: obj.branch || null, ts: obj.ts || null, data: obj };
}

async function dbSetDoc(table, id, obj) {
  const isNew = obj && obj.ts == null;
  if (isNew) {
    obj.ts = Date.now();
    // Audit: stamp who created this record (the logged-in user's email).
    if (auth.currentUser && obj.createdBy == null) obj.createdBy = auth.currentUser.email;
  }
  cacheLocally();
  if (isNew && table === paymentsCol) bumpStat('revenue', num(obj.amount), obj.branch);
  if (isNew && table === expensesCol) bumpStat('expenses', num(obj.amount), obj.branch);
  try {
    const { error } = await sb.from(table).upsert(toRow(id, obj));
    if (error) throw error;
  } catch (err) {
    console.error('Supabase set error:', err);
    showNotification('تم الحفظ محلياً، لكن تعذر رفعه لقاعدة البيانات. تحقق من الاتصال', 'danger');
  }
}

// Used for attendance (auto-generated id). trainee_id is extracted so a
// player's attendance can be deleted when the player is removed.
// Returns { ok, duplicate }: `duplicate` is true when the DB's unique index
// rejected the row (another device already inserted the same attendance) —
// callers undo their local copy instead of showing a scary error.
async function dbAddDoc(table, obj) {
  if (obj && obj.ts == null) obj.ts = Date.now();
  if (obj && obj.createdBy == null && auth.currentUser) obj.createdBy = auth.currentUser.email;
  cacheLocally();
  const row = { branch: obj.branch || null, ts: obj.ts || null, data: obj };
  if (table === attendanceCol) row.trainee_id = obj.id || null;
  try {
    const { error } = await sb.from(table).insert(row);
    if (error) throw error;
    return { ok: true, duplicate: false };
  } catch (err) {
    if (err && err.code === '23505') return { ok: false, duplicate: true };
    console.error('Supabase add error:', err);
    showNotification('تم الحفظ محلياً، لكن تعذر رفعه لقاعدة البيانات. تحقق من الاتصال', 'danger');
    return { ok: false, duplicate: false };
  }
}

async function dbDeleteDoc(table, id) {
  cacheLocally();
  try {
    // count:'exact' exposes silent RLS refusals: a delete the policy blocks
    // returns no error but affects 0 rows — surface that instead of hiding it.
    const { error, count } = await sb.from(table).delete({ count: 'exact' }).eq('id', String(id));
    if (error) throw error;
    if (count === 0) {
      showNotification('لم يُحذف السجل من قاعدة البيانات — غالباً لا تملك صلاحية الحذف (سيعود بعد التحديث)', 'danger');
    }
  } catch (err) {
    console.error('Supabase delete error:', err);
    showNotification('تعذر الحذف من قاعدة البيانات السحابية', 'danger');
  }
}

// Delete every row where a field equals a value (used to remove a deleted
// player's attendance — stored under the trainee_id column).
async function dbDeleteWhere(table, field, value) {
  cacheLocally();
  const column = table === attendanceCol && field === 'id' ? 'trainee_id' : field;
  try {
    const { error } = await sb.from(table).delete().eq(column, value);
    if (error) throw error;
  } catch (err) {
    console.error('Supabase delete-where error:', err);
    showNotification('تعذر حذف بعض السجلات المرتبطة من قاعدة البيانات', 'danger');
  }
}

async function dbSaveCounter() {
  cacheLocally();
  try {
    await sb.from('meta').upsert({ id: 'counter', data: { value: data.counter } });
  } catch (err) {
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
