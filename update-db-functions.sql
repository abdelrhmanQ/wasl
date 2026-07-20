-- ====================================================================
-- تحديثات قاعدة البيانات: إجماليات موحّدة + حجز أرقام الكروت مركزياً
-- --------------------------------------------------------------------
-- الطريقة:
--   1) افتح Supabase Dashboard -> SQL Editor -> New query
--   2) الصق محتوى الملف ده كله
--   3) اضغط Run  (يُشغَّل مرة واحدة فقط)
--
-- (أ) fd_totals: إجماليات الإيرادات (اشتراكات + مبيعات فقط) والمصروفات
--     لكل فرع، بنطاق تاريخ اختياري — لوحة التحكم المالية بتستخدمها عشان
--     أرقامها تبقى دقيقة 100% مهما كانت الفترة المحمّلة في الشاشة.
-- (ب) reserve_card_serials: عدّاد مركزي ذرّي لأرقام الكروت الفاضية،
--     فجهازان يطبعوا كروت لنفس الرياضة في نفس الوقت مايكرروش أرقام.
-- ====================================================================

-- (أ) الإجماليات المصنّفة بنطاق تاريخ (نفس قاعدة countsAsRevenue في الواجهة)
create or replace function fd_totals(p_from bigint default null, p_to bigint default null)
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
      (
        (p.data ->> 'cat') in ('subscription', 'sales')
        or (
          coalesce(p.data ->> 'cat', '') = ''
          and (p.data ->> 'type') in (
            'اشتراك جديد', 'تجديد', 'قسط', 'برايفت',
            'مبيعات', 'لوكر', 'انترنت', 'إيجار لوكر', 'اشتراك انترنت'
          )
        )
      )
      and (p_from is null or p.ts >= p_from)
      and (p_to is null or p.ts <= p_to)
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
    where (p_from is null or e.ts >= p_from)
      and (p_to is null or e.ts <= p_to)
    group by e.branch
  )
  select
    coalesce(rev.branch, exp.branch) as branch,
    coalesce(rev.revenue, 0) as revenue,
    coalesce(exp.expenses, 0) as expenses
  from rev
  full outer join exp on rev.branch = exp.branch;
$$;

-- (ب) عدّاد أرقام الكروت المركزي (ذرّي — upsert واحد لا يسمح بالتكرار)
create table if not exists card_serials (
  key text primary key,
  value bigint not null
);
alter table card_serials enable row level security;
drop policy if exists card_serials_rw on card_serials;
create policy card_serials_rw on card_serials
  for all to authenticated using (true) with check (true);

-- يحجز p_count رقماً متتالياً للمفتاح p_key ويرجع أول رقم في الكتلة.
-- p_min = أعلى رقم معروف محلياً (كروت مطبوعة قبل تفعيل العدّاد المركزي)
-- عشان العدّاد يبدأ بعده ولا يكرر أرقاماً قديمة أبداً.
create or replace function reserve_card_serials(p_key text, p_count int, p_min bigint)
returns bigint
language sql
as $$
  insert into card_serials (key, value)
  values (p_key, greatest(coalesce(p_min, 0), 0) + p_count)
  on conflict (key) do update
    set value = greatest(card_serials.value, coalesce(p_min, 0)) + p_count
  returning value - p_count + 1;
$$;

-- للتحقق: المفروض يرجع 1 أول مرة ثم 6 (لو p_min = 0)
-- select reserve_card_serials('test-block', 5, 0);
-- select reserve_card_serials('test-block', 5, 0);
-- delete from card_serials where key = 'test-block';
