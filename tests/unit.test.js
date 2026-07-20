// ====================================================================
// tests/unit.test.js — pure-logic tests for the money-critical helpers.
// Run with:  npm test   (node --test tests/)
//
// main.js is a classic browser script (no exports), so the functions under
// test are EXTRACTED from its source text and evaluated in this process.
// If a function is renamed/removed, the extraction throws and the run fails —
// which is exactly what we want.
// ====================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function fn(sig) {
  const i = src.indexOf(sig);
  if (i === -1) throw new Error('not found in main.js: ' + sig);
  let k = src.indexOf('{', i),
    d = 0;
  do {
    const c = src[k];
    if (c === '{') d++;
    else if (c === '}') d--;
    k++;
  } while (d > 0);
  return src.slice(i, k);
}
function cblock(name, end) {
  const i = src.indexOf('const ' + name);
  if (i === -1) throw new Error('not found in main.js: const ' + name);
  const e = src.indexOf(end, i) + end.length;
  return src.slice(i, e);
}

// Evaluate the helpers in one shared scope (const → var so eval exposes them).
const code = [
  fn('function normalizeDigits('),
  fn('function num('),
  fn('function parseDate('),
  fn('function addDays('),
  cblock('REVENUE_CAT_LABELS', '};'),
  fn('function revenueCategory('),
  cblock('COUNTABLE_REVENUE_CATS', '];'),
  fn('function countsAsRevenue('),
  fn('function revenueSum('),
  cblock('SPORTS =', '];'),
  cblock('SPORT_CODES', '};'),
  'var CODE_TO_SPORT = Object.fromEntries(Object.entries(SPORT_CODES).map(e => [e[1], e[0]]));',
  fn('function sportCardBase('),
  fn('function sportForCode('),
  fn('function findTraineeByCode('),
  fn('function findTraineeByNameOrCode('),
  // Shared player fixture for the lookup tests (the browser globals `data`).
  `var data = { trainees: [
    { id: 'Wasl-0001', name: 'أحمد علي', codes: ['Wasl-0001', 'FB-1001'] },
    { id: 'Wasl-0002', name: 'محمد حسن' },
    { id: 'Wasl-0003', name: 'محمد حسن' },
  ] };`,
]
  .join('\n')
  .replace(/\bconst /g, 'var ');
// eslint-disable-next-line no-eval
eval(code);

// ==================== normalizeDigits / num ====================
test('normalizeDigits converts Arabic-Indic digits and strips bidi marks', () => {
  assert.equal(normalizeDigits('٢٢‏/٦/٢٠٢٦'), '22/6/2026');
  assert.equal(normalizeDigits('01012345678'), '01012345678');
});

test('num parses numbers, Arabic digits and garbage safely', () => {
  assert.equal(num(500), 500);
  assert.equal(num('500'), 500);
  assert.equal(num('٥٠٠'), 500);
  assert.equal(num(''), 0);
  assert.equal(num(null), 0);
  assert.equal(num('abc'), 0);
});

// ==================== parseDate ====================
test('parseDate handles d/m/yyyy, Arabic dates and ISO the same day', () => {
  const a = parseDate('5/6/2026');
  const b = parseDate('٥/٦/٢٠٢٦');
  const c = parseDate('2026-06-05');
  assert.ok(a > 0);
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(parseDate(''), 0);
  assert.equal(parseDate(null), 0);
});

// ==================== revenue classification ====================
test('revenueCategory maps every payment type to its bucket', () => {
  assert.equal(revenueCategory({ type: 'اشتراك جديد' }), 'subscription');
  assert.equal(revenueCategory({ type: 'تجديد' }), 'subscription');
  assert.equal(revenueCategory({ type: 'قسط' }), 'subscription');
  assert.equal(revenueCategory({ type: 'برايفت' }), 'subscription');
  assert.equal(revenueCategory({ type: 'بطولة' }), 'tournament');
  assert.equal(revenueCategory({ type: 'كشف طبي' }), 'medical');
  assert.equal(revenueCategory({ type: 'مبيعات' }), 'sales');
  assert.equal(revenueCategory({ type: 'لوكر' }), 'sales');
  assert.equal(revenueCategory({ type: 'انترنت' }), 'sales');
  assert.equal(revenueCategory({ type: 'اختبار' }), 'other');
  assert.equal(revenueCategory({ type: 'قيد/كارنيه' }), 'other');
});

test('explicit cat wins; unknown cat falls back to other', () => {
  assert.equal(revenueCategory({ type: 'اشتراك جديد', cat: 'sales' }), 'sales');
  assert.equal(revenueCategory({ type: 'اشتراك جديد', cat: 'weird' }), 'other');
});

test('revenueSum counts ONLY subscriptions + sales', () => {
  const payments = [
    { type: 'اشتراك جديد', amount: 1000 },
    { type: 'مبيعات', cat: 'sales', amount: 125 },
    { type: 'بطولة', amount: 6000 },
    { type: 'كشف طبي', amount: 1000 },
    { type: 'قيد/كارنيه', amount: 400 },
    { type: 'تجديد', amount: '٧٠٠' }, // Arabic digits amount
  ];
  assert.equal(revenueSum(payments), 1825);
  assert.equal(revenueSum([]), 0);
  assert.equal(revenueSum(null), 0);
});

// ==================== card codes ====================
test('sportForCode reads the sport from structured codes', () => {
  assert.equal(sportForCode('A-KA-3001'), 'كاراتيه');
  assert.equal(sportForCode('B-WAG-T-1001'), 'جمباز فني');
  assert.equal(sportForCode('C-KB-5001'), 'كيك بوكس');
  assert.equal(sportForCode('A-DR-12001'), 'رسم');
  assert.equal(sportForCode('Wasl-0427'), ''); // legacy random id → no sport
  assert.equal(sportForCode(''), '');
});

// ==================== addDays ====================
test('addDays adds calendar days across month ends', () => {
  assert.equal(addDays('2026-06-01', 30), '2026-07-01');
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
});

// ==================== attendance lookup by name or code ====================
test('findTraineeByNameOrCode resolves code, extra card, datalist pick and name', () => {
  // Primary id (case-insensitive) and an extra card code both map to the player.
  assert.equal(findTraineeByNameOrCode('Wasl-0001').id, 'Wasl-0001');
  assert.equal(findTraineeByNameOrCode('wasl-0001').id, 'Wasl-0001');
  assert.equal(findTraineeByNameOrCode('FB-1001').id, 'Wasl-0001');
  // "name — code" value picked from the datalist trusts the code half.
  assert.equal(findTraineeByNameOrCode('أحمد علي — Wasl-0001').id, 'Wasl-0001');
  // Exact, unique name resolves; unknown input does not.
  assert.equal(findTraineeByNameOrCode('أحمد علي').id, 'Wasl-0001');
  assert.equal(findTraineeByNameOrCode('لا أحد'), undefined);
  assert.equal(findTraineeByNameOrCode(''), undefined);
  // Ambiguous name (two players share it) is rejected — no wrong check-in.
  assert.equal(findTraineeByNameOrCode('محمد حسن'), undefined);
});
