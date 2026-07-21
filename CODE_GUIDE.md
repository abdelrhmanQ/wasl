# دليل الكود — El Wasl Academy System

مرجع عملي تفتحه وأنت بتعدّل بنفسك. منظّم بحيث تلاقي بسرعة: **أنا عايز أغيّر كذا → روح لفين**.

> الأسماء بالإنجليزي هي أسماء الدوال/الثوابت الفعلية في الكود. دوّر عليها بـ Ctrl+F داخل `main.js`.

---

## 1) نظرة عامة على البنية

الموقع **static** (مفيش سيرفر backend) — HTML + JavaScript عادي + قاعدة بيانات Supabase.

| الملف | مسؤول عن |
|---|---|
| `index.html` | كل واجهة المستخدم (الأقسام، الجداول، النماذج، الأزرار). |
| `main.js` | كل منطق التطبيق (التسجيل، الحضور، المالية، الطباعة، التقارير...). **~7000 سطر — أكبر ملف.** |
| `server.supabase.js` | طبقة البيانات: الحفظ/التحميل من Supabase، الأوفلاين، العدّادات. |
| `sw.js` | Service Worker — بيخلّي الموقع يفتح ويشتغل بدون نت. |
| `style.css` | كل التنسيق. |
| `manifest.json` | إعدادات تثبيت التطبيق (PWA). |
| `vendor/` | مكتبات خارجية (Supabase، الباركود، الـ QR). |

**ترتيب التحميل مهم** (في `index.html`): مكتبة Supabase → `server.supabase.js` → `main.js`. يعني `main.js` بيعتمد على دوال متعرّفة في `server.supabase.js`.

**تدفّق البيانات:**
```
المستخدم يعمل حاجة → دالة في main.js → بتعدّل الكائن العام `data`
                                     → بتنادي dbSetDoc/dbAddDoc/... (في server.supabase.js)
                                     → دي بتحفظ في Supabase (أو تحطها في طابور الأوفلاين)
                                     → بتنادي دوال الرندر (updateX) لتحديث الشاشة
```

---

## 2) نموذج البيانات

الكائن العام `data` (متعرّف في `server.supabase.js`) بيحتوي كل بيانات التطبيق في الذاكرة:

```js
data = {
  trainees: [],       // اللاعبون
  attendance: [],     // سجلات الحضور
  payments: [],       // المدفوعات (الإيرادات)
  employees: [],      // الموظفون/المدربون
  expenses: [],       // المصروفات (مرتبات، إيجار، استردادات...)
  groups: [],         // الجروبات
  sessions: [],       // الحصص
  staffAttendance: [],// حضور الموظفين
  feedback: [],       // الشكاوى/الملاحظات
  counter: 1,         // عدّاد أكواد اللاعبين
}
```

### شكل أهم السجلات (الحقول الأساسية)

**اللاعب (trainee):**
```
id            كود اللاعب الأساسي (المفتاح) — مثال "Wasl-0001" أو "MR-0001"
name, phone
type          'subscription' (مشترك) أو 'test' (تجريبي)
sports[]      قائمة الرياضات (متعدد)  |  sport, plan  (نسخ قديمة برياضة واحدة)
level, stage  المستوى/القطاع
trainer       المدرب المسؤول
branch        الفرع
subType       'days' (بالأيام) أو 'sessions' (بالحصص)
startDate, durationDays, expiryDate     (للأيام)
sessionsTotal, sessionsRemaining        (للحصص)
amount        إجمالي المدفوع  |  subTotal السعر الكامل  |  subPaid المدفوع فعلاً
status        'نشط' / 'منتهي' / 'تجريبي' / 'مجمد'
frozen        مجمّد مؤقتاً؟  |  freezeReason
codes[]       أكواد الكروت للمسح (مختلفة عن id)
addons{}      الخدمات الإضافية
notes
refundRequest طلب استرداد إن وُجد
```

**الدفعة (payment):** `id` (= id اللاعب أو '—' للمبيعات)، `name`، `type`، `amount`، `method`، `date`، `branch`، `trainer`، `_docId` (معرّف فريد للسجل).

**الموظف (employee):** `id`، `name`، `role`، `branch`، `branches[]` (فروع الكرت)، `code`، `salary`، `payType` ('percentage'/'monthly')، `percentageRate`، `status`.

> ⚠️ **قاعدة ذهبية:** الحضور والمدفوعات مربوطين بـ **`trainee.id`** — مش بكود الكرت. عشان كده تقدر تغيّر `codes[]` بأمان من غير ما يضيع حضور أو فلوس.

---

## 3) الثوابت المهمة — "عايز أغيّر إعداد ثابت"

كلها في `main.js`. غيّر القيمة في مكان واحد وهي بتتطبّق في كل التطبيق.

| عايز تغيّر | الثابت | مثال |
|---|---|---|
| **الرياضات** | `SPORTS` | ضيف/شيل رياضة من القائمة |
| **الفروع** | `BRANCHES` | `['فرع المريوطيه', 'فرع الحدايق', 'فرع الهرم']` |
| **حروف الفروع في الكود** | `BRANCH_CODES` | `{ 'فرع المريوطيه': 'A', ... }` |
| **اختصار الرياضة في الكود** | `SPORT_CODES` | `{ 'جمباز فني': 'WAG', ... }` |
| **قطاعات الجمباز** | `GYM_SECTOR_CODES` | `{ فريق: 'T', تجهيزي: 'P', مدارس: 'S' }` |
| **إيه رياضات الجمباز** | `GYM_SPORTS` | `['جمباز فني', 'جمباز ايروبك']` |
| **الخدمات الإضافية وأسعارها** | `ADDON_DEFS` | لوكر (150)، انترنت (100)، اختبارات، بطولات... |
| **طرق الدفع** | `PAYMENT_METHODS` | نقداً، تحويل، فودافون كاش، انستا باي |
| **وظائف الموظفين** | `EMPLOYEE_ROLES` | موظف استقبال، اداري، عامل نظافة |
| **أنواع المصروفات = مرتبات** | `SALARY_TYPES` | مرتب، سلفة، نسبة، خصم |
| **إيه اللي بيتحسب إيراد** | `COUNTABLE_REVENUE_CATS` | `['subscription', 'sales']` |
| **أقسام الموظف المسموح بيها** | `EMPLOYEE_SECTIONS` | الأقسام اللي غير الأدمن بيشوفها |
| **مقاسات طباعة الكرت** | `CARD_PRINT_SIZES` | ميدالية / 8.5×5.5 / 6×4 |
| **ألوان الكرت حسب الفرع** | `BRANCH_COLORS` | جولد/أخضر/أزرق |
| **حدّ الانقطاع للتنبيه** | `ABSENCE_ALERT_DAYS` | 7 أيام |
| **أرقام هواتف الأكاديمية على الكرت** | `ACADEMY_PHONES` | تظهر خلف كل كرت |

---

## 4) خريطة الأقسام والدوال

كل قسم في الواجهة له `id` (زي `section-registration`)، ودالة رندر بتتنادى لما تفتحه (شوف دالة `showSection`).

### التنقّل والصلاحيات
- `showSection(name)` — يفتح قسم. بيمنع الموظف من الأقسام الإدارية.
- `applyRolePermissions(role)` — يخفي/يظهر حسب الدور (`admin` / `employee`).
- `roleForEmail(email)` — يحدّد دور المستخدم من إيميله.

### التسجيل واللاعبون (قسم `registration`)
- `registerTrainee()` — تسجيل لاعب مشترك جديد.
- `updateTraineesTable()` / `filterTrainees()` — جدول اللاعبين + الفلترة.
- `traineeRowHtml(t)` — يبني صف اللاعب (وفيه أزرار عرض/تعديل/طباعة).
- `viewTrainee(i)` / `editTrainee(i)` / `saveTraineeEdit(i)` — عرض/تعديل/حفظ.
- `deleteTrainee(i)` — حذف لاعب (**بيسيب مدفوعاته**، يمسح حضوره).
- `subInfo(t)` — الحقيقة الوحيدة لـ "المتبقي" (أيام/حصص، منتهي؟، قارب؟).
- `freezeTrainee` / `unfreezeTrainee` — تجميد/فك تجميد الاشتراك.

### الحضور (قسم `attendance`)
- `recordAttendance()` — تسجيل الحضور بالكود (auto-submit عند المطابقة).
- `renderAttendanceCard(t, info, opts)` — كارت نتيجة السكان.
- `attendanceSummary(t)` — آخر حضور + عدد المرات (استعلام دقيق من DB).
- `updateAttendanceLog()` — جدول حضور اليوم.

### التجريبيون (قسم `trials`)
- `registerTrial()` / `acceptTrial()` / `rejectTrial()` — تسجيل/قبول/رفض تجريبي.
- المرفوض بيتحذف تلقائياً بعد أسبوع (`purgeOldRejectedTrials`).

### المالية (قسم `financial`)
- `addPayment(fields)` — **المكان الوحيد لإضافة دفعة**. بيحفظ ويبصم المدرب.
- `saveExpense(expense)` — **المكان الوحيد لإضافة مصروف**.
- `payInstallment(i)` / `confirmInstallment(i)` — دفع قسط.
- `renewSubscription()` — تجديد اشتراك.
- `requestRefund(i)` / `submitRefundRequest(i)` — طلب استرداد (يفضل معلّق).
- `approveRefund(id)` / `rejectRefund(id)` — الأدمن يوافق/يرفض. الموافقة **بتسجّل الاسترداد كمصروف** (مش خصم من الإيراد).
- `deletePayment(docId)` — حذف دفعة (أدمن فقط) — **دي الوحيدة اللي بتنقص الإيراد**.
- `revenueCategory(p)` / `countsAsRevenue(p)` / `revenueSum(payments)` — تصنيف وحساب الإيراد.

### المرتبات والمدربون (أقسام `salaries` / `coaches`)
- `paySalary(i)` — صرف مرتب/نسبة لموظف.
- `recordCoachTransfer(t, oldCoach, newCoach)` — تحويل عمولة الجزء غير المستهلك عند تغيير المدرب.
- `openStaffAdvance(id)` / `openStaffDeduction(id)` — سلفة/خصم.

### الموظفون وحضورهم (أقسام `employees` / `staff-attendance`)
- `addEmployee()` / `editEmployee(id)` / `saveEmployeeEdit(id)` — إضافة/تعديل موظف (وفيها فروع الكرت).
- `printStaffCard(id)` / `printStaffCardsSheet()` — طباعة كروت الموظفين (نفس تصميم اللاعب).
- `staffCardFrontHTML(e, code, logo)` / `staffBranches(e)` — وش كارت الموظف + فروعه.
- حضور الموظفين: `checkInStaff` / `checkOutStaff`.

### الجروبات والحصص (أقسام `groups` / `sessions`)
- `renderGroups()` / `openGroup(id)` — الجروبات.
- `renderSessionsSection()` / `openSession(id)` — الحصص.

### الداشبورد والتقارير (أقسام `dashboard` / `financial-dashboard` / `reports`)
- `updateDashboard()` — إحصائيات الصفحة الرئيسية.
- `renderFinancialDashboard()` — لوحة المالية التفصيلية.
- `printReport()` / `printMonthlyReport()` / `printDailyReport()` / `printFeedback()` — طباعة PDF.
- `reportDoc(title, body)` — **دالة مشتركة تفتح نافذة تقرير** (كل التقارير بتستخدمها).
- بناة التقارير: `buildMembersReport` / `buildFinancialReport` / `buildAttendanceReport`.

### طباعة الكروت (مشترحة بالتفصيل تحت في قسم 6)
- `openCardSheet(title, slots)` — **الدالة الوحيدة لطباعة كل الكروت الطولية** (لاعبين/موظفين/جاهزة/فردي).
- `cardFaceHTML(rows, code, logo)` — وش الكارت العام.
- `cardFrontHTML` (لاعب) / `staffCardFrontHTML` (موظف) / `cardBackHTML` (الظهر بالباركود).
- `printTraineeCardsSheet(branch, activeOnly)` — كروت اللاعبين.
- `printBlankCards()` — كروت جاهزة بأكواد متسلسلة.
- `generateStructuredCodes` / `generateSportCodes` — توليد أكواد الكروت.

### أدوات مساعدة (Helpers) بتستخدمها في كل حتة
- `esc(v)` — **لازم** حوالين أي بيانات مستخدم داخل HTML (يمنع XSS/كسر التصميم).
- `num(v)` — يحوّل لأرقام بأمان (يرجّع 0 لو مش رقم).
- `val(id)` / `setVal(id, v)` — قراءة/كتابة قيمة عنصر.
- `todayAr()` / `todayISO()` / `parseDate()` / `addDays()` / `dateKey()` — التواريخ.
- `chipsHTML(items, removeFn)` — شرائح (chips) قابلة للحذف.
- `showNotification(msg, type)` — إشعار (`type`: success/warning/danger).
- `openModal(title, html)` / `closeModal()` — النوافذ المنبثقة.

---

## 5) طبقة البيانات والمزامنة (`server.supabase.js`)

**كل تعديل بيتحفظ فوراً في Supabase، ولو مفيش نت بيتحط في طابور (outbox) وبيترفع تلقائياً لما النت يرجع.** مفيش أي عملية بتضيع.

- `loadData()` — يحمّل كل البيانات من Supabase (بيتنادى عند الدخول وتغيير الفرع).
- `dbSetDoc(table, id, obj)` — يحفظ/يحدّث سجل بمعرّف معروف (لاعب/موظف/مصروف).
- `dbAddDoc(table, obj)` — يضيف سجل بمعرّف تلقائي (حضور).
- `dbDeleteDoc(table, id)` / `dbDeleteWhere(table, field, value)` — حذف.
- `nextCounterValue()` — يحجز رقم لاعب جديد **ذرّياً** (جهازين ما ياخدوش نفس الرقم).
- `flushOutbox()` — يرفع الطابور المعلّق.
- `recomputeStats()` — يعيد حساب الإيرادات/المصروفات من DB عبر دالة `branch_totals()`.
- `setDeviceBranch` / `getDeviceBranch` — نطاق الجهاز (فرع معيّن أو الكل).

**ملفات SQL (تتشغّل في Supabase → SQL Editor):** `update-branch-totals-countable.sql` (تعريف حساب الإيراد)، `supabase-race-fixes.sql` (منع تكرار الحضور)، وملفات التشخيص/التنظيف.

---

## 6) وصفات: "عايز أعمل كذا" 🔧

### أضيف رياضة جديدة
1. ضيفها في `SPORTS`.
2. ضيف اختصارها في `SPORT_CODES` (عشان الكروت).
3. لو ليها حصص شهرية ثابتة، شوف `COMBAT_MONTHLY_SESSIONS` / `GYM_SECTOR_SESSIONS`.
4. لو ليها اسم إنجليزي على الكرت، ضيفه في `SPORT_NAMES_EN`.

### أضيف فرع جديد
1. ضيفه في `BRANCHES`.
2. ضيف حرفه في `BRANCH_CODES` ولونه في `BRANCH_COLORS` واسمه الإنجليزي في `BRANCH_NAMES_EN`.

### أغيّر سعر خدمة إضافية (لوكر/انترنت...)
- في `ADDON_DEFS` غيّر قيمة `def`.

### أغيّر قاعدة "إيه اللي بيتحسب إيراد"
- في `COUNTABLE_REVENUE_CATS` و `revenueCategory()` (في main.js).
- **مهم:** لازم تحدّث كمان دالة `branch_totals()` في Supabase (شغّل `update-branch-totals-countable.sql` بعد التعديل) عشان الإجماليات على السيرفر تتطابق.

### أعدّل تصميم الكرت
- تصميم الكرت الطولي كله في ثابت `PORTRAIT_CARD_CSS` (ألوان، خطوط، مقاسات العناصر).
- محتوى وش اللاعب: `cardFrontHTML` → بيستخدم `cardFaceHTML(rows, ...)`. الصفوف (Sport/Branch) بتتحدد هنا.
- محتوى وش الموظف: `staffCardFrontHTML` (Role + الفروع).
- الظهر (الباركود): `cardBackHTML`.

### أعدّل مقاسات أو تخطيط الطباعة
- المقاسات: ثابت `CARD_PRINT_SIZES` (ضيف/عدّل مقاس بالـ w/h بالمليمتر).
- تخطيط الشيت (المسافات، خطوط القص، حجم الخانة): في دالة `openCardSheet` — المتغيّر `sheetCss`. حالياً: شبكة متمركزة، مسافة 2.5مم بين الكروت، خط قص رفيع، حواف مربعة.

### أضيف حقل جديد للاعب
1. أضف الحقل في نموذج التسجيل (`index.html` قسم registration) وفي `registerTrainee()`.
2. أضف نفس الحقل في نموذج التعديل (`editTrainee`) وحفظه (`saveTraineeEdit`).
3. لو عايزه يظهر في الجدول، عدّل `traineeRowHtml`.

### أعدّل صلاحيات دور معيّن
- الأقسام المسموحة للموظف: `EMPLOYEE_SECTIONS`.
- منطق الإظهار/الإخفاء: `applyRolePermissions`.
- عمليات الأدمن فقط بتبدأ بـ `if (currentRole !== 'admin') return;` (زي `approveRefund`, `deletePayment`).

---

## 7) محاذير — متلمسش الحاجات دي من غير انتباه ⚠️

1. **`trainee.id` = المفتاح الأساسي.** الحضور والمدفوعات مربوطين بيه. **متغيّروش أبداً** للاعب موجود، وإلا هيضيع تاريخه. (كود الكرت `codes[]` تقدر تغيّره براحتك.)

2. **حذف اللاعب بيسيب مدفوعاته عن قصد** — عشان الإيراد التاريخي يفضل صح. متضفش كود يمسح المدفوعات مع اللاعب.

3. **الاسترداد = مصروف، مش خصم من الإيراد.** لو غيّرت ده، هتبوّظ التقارير المالية.

4. **دايماً استخدم `esc()`** حوالين أي نص من المستخدم داخل `innerHTML`. من غيرها اسم فيه رموز ممكن يكسر الصفحة أو يعمل XSS.

5. **دايماً احفظ عن طريق `dbSetDoc`/`dbAddDoc`** — متكتبش لـ Supabase مباشرة. الدوال دي بتتكفّل بالأوفلاين والطابور والكاش.

6. **الفهرس (index) في الأزرار لازم ييجي من `data.trainees.indexOf(t)`** — مش من فهرس الحلقة بعد الفلترة. النمط الحالي صح؛ حافظ عليه لو أضفت أزرار.

7. **العدّاد ذرّي عبر `nextCounterValue()`** — متولّدش أكواد لاعبين يدوياً بطريقة تانية.

8. **⚠️ تعارض أرقام الكروت عبر الفروع:** توليد رقم الكرت الجاي بيعتمد على `localStorage` + لاعيبة الفرع اللي الجهاز شايفه. **اطبع كروت من جهاز أدمن (كل الفروع)** عشان الأرقام ما تتعارضش بين الفروع. (الحل الجذري = عدّاد ذرّي في DB، لسه مؤجّل.)

9. **ترتيب التحميل في `index.html`** (Supabase → server → main) لازم يفضل زي ما هو.

10. **`sw.js` فيه رقم نسخة الكاش** (`CACHE = 'wasl-app-vX'`). لو غيّرت ملفات وعايز المستخدمين ياخدوا التحديث أوفلاين فوراً، زوّد الرقم.

---

## 8) إزاي تختبر تعديلك بأمان

1. `node --check main.js` — يتأكد مفيش خطأ تركيبي.
2. `npx prettier --write "*.{js,css,html}"` — يوحّد التنسيق.
3. افتح الموقع محلياً (`npx serve .`) وجرّب التعديل، وبُصّ على الـ Console (F12) لأي أخطاء.
4. **قبل أي تعديل كبير على البيانات:** خُد Backup من Supabase → Database → Backups.

---

*آخر تحديث: يوليو 2026. لو أضفت ميزة كبيرة، حدّث الدليل ده.*
