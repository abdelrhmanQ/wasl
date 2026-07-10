-- ====================================================================
-- تحديث دالة branch_totals: الإيرادات = اشتراكات + مبيعات فقط
-- --------------------------------------------------------------------
-- الطريقة:
--   1) افتح Supabase Dashboard -> SQL Editor -> New query
--   2) الصق محتوى الملف ده كله
--   3) اضغط Run
--
-- بيعمل إيه؟
--   إجماليات "كل الفترة" في الداشبورد بتيجي من الدالة دي. التحديث ده
--   بيخليها تحسب الإيرادات من الاشتراكات والمبيعات فقط — البطولات
--   والكشوفات الطبية والقيد/الكارنيه/الاختبارات/الإيجار بتتسجل عادي
--   لكن مش بتدخل في إجمالي الإيرادات ولا صافي الربح.
--   (نفس القاعدة المطبقة في الواجهة — دالة countsAsRevenue في main.js)
-- ====================================================================

create or replace function branch_totals()
returns table (branch text, revenue numeric, expenses numeric)
language sql
stable
as $$
  with rev as (
    select
      p.branch,
      sum(
        case
          when (p.data ->> 'amount') ~ '^-?[0-9]+(\.[0-9]+)?$'
            then (p.data ->> 'amount')::numeric
          else 0
        end
      ) as revenue
    from payments p
    where
      -- الفئة الصريحة (السجلات المستوردة): اشتراك أو مبيعات فقط
      (p.data ->> 'cat') in ('subscription', 'sales')
      or (
        -- بدون فئة صريحة: نستنتج من نوع العملية (نفس منطق الواجهة)
        coalesce(p.data ->> 'cat', '') = ''
        and (p.data ->> 'type') in (
          'اشتراك جديد', 'تجديد', 'قسط', 'برايفت',
          'مبيعات', 'لوكر', 'انترنت', 'إيجار لوكر', 'اشتراك انترنت'
        )
      )
    group by p.branch
  ),
  exp as (
    select
      e.branch,
      sum(
        case
          when (e.data ->> 'amount') ~ '^-?[0-9]+(\.[0-9]+)?$'
            then (e.data ->> 'amount')::numeric
          else 0
        end
      ) as expenses
    from expenses e
    group by e.branch
  )
  select
    coalesce(rev.branch, exp.branch) as branch,
    coalesce(rev.revenue, 0) as revenue,
    coalesce(exp.expenses, 0) as expenses
  from rev
  full outer join exp on rev.branch = exp.branch;
$$;

-- للتحقق بعد التشغيل: المفروض تشوف إيرادات كل فرع (اشتراكات+مبيعات فقط)
select * from branch_totals();
