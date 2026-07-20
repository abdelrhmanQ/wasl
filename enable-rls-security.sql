-- ====================================================================
-- تأمين قاعدة البيانات: تفعيل Row-Level Security (RLS) على كل الجداول
-- --------------------------------------------------------------------
-- ⚠️ مهم جداً: المفتاح "anon" الموجود في server.supabase.js عام (public)
-- وأي حد يفتح صفحة الموقع يقدر يقراه. من غير RLS، المفتاح ده لوحده يسمح
-- بقراءة وتعديل وحذف كل البيانات (لاعبين، مدفوعات، رواتب) بدون تسجيل دخول.
-- الملف ده بيقفل الثغرة دي: لا وصول إطلاقاً إلا لمستخدم مسجّل دخوله
-- (authenticated)، وتعديل/حذف المدفوعات والمصروفات للمدير فقط.
--
-- طريقة التشغيل (مرة واحدة):
--   1) Supabase Dashboard -> SQL Editor -> New query
--   2) الصق الملف ده كله -> Run
--   3) شغّل استعلامات التحقق في آخر الملف
--
-- للتراجع (لو حصلت مشكلة) شوف قسم "التراجع" في آخر الملف.
-- ====================================================================

-- ---- (1) قائمة المديرين + دالة is_admin() ----
-- نفس الإيميلات الموجودة في ADMIN_EMAILS داخل main.js. عدّلها هنا لو أضفت
-- مديراً جديداً (وأضفه في main.js كمان عشان الواجهة تفتح له الأقسام).
create table if not exists admins (email text primary key);
insert into admins (email) values
  ('abdrhmanq5005@gmail.com'),
  ('ahmed@elwasl.com'),
  ('hesham@elwasl.com')
on conflict (email) do nothing;

-- يرجّع true لو إيميل المستخدم الحالي (من التوكن) موجود في جدول المديرين.
create or replace function is_admin()
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- المديرون فقط يقدروا يعدّلوا قائمة المديرين نفسها.
alter table admins enable row level security;
drop policy if exists admins_select on admins;
create policy admins_select on admins for select to authenticated using (true);
drop policy if exists admins_write on admins;
create policy admins_write on admins for all to authenticated
  using (is_admin()) with check (is_admin());

-- ---- (2) الجداول التشغيلية: وصول كامل لأي مستخدم مسجّل دخوله فقط ----
-- الموظف بيسجّل لاعبين وحضور ومدفوعات، فمحتاج قراءة/إضافة/تعديل هنا.
-- الحماية الأساسية: الدور "anon" (بدون تسجيل دخول) ممنوع تماماً — لأننا
-- بنمنح الصلاحيات للدور "authenticated" بس.
do $$
declare
  t text;
  operational text[] := array[
    'trainees', 'attendance', 'employees', 'groups',
    'sessions', 'staff_attendance', 'feedback', 'meta', 'card_serials'
  ];
begin
  foreach t in array operational loop
    -- تجاهل أي جدول غير موجود (اختلاف تسمية بسيط) بدل ما يقف السكربت.
    if to_regclass(t) is null then
      raise notice 'skipping missing table: %', t;
      continue;
    end if;
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists %I on %I;', t || '_rw', t);
    execute format(
      'create policy %I on %I for all to authenticated using (true) with check (true);',
      t || '_rw', t
    );
  end loop;
end $$;

-- ---- (3) الجداول المالية: قراءة/إضافة لأي مستخدم، تعديل/حذف للمدير فقط ----
-- ده بيطابق قيود الواجهة (deletePayment/editPayment/deleteExpense كلها
-- للمدير فقط). الموظف لسه يقدر يضيف مدفوعات (تسجيل/تجديد/أقساط) عادي.
do $$
declare
  t text;
  financial text[] := array['payments', 'expenses'];
begin
  foreach t in array financial loop
    if to_regclass(t) is null then
      raise notice 'skipping missing table: %', t;
      continue;
    end if;
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists %I on %I;', t || '_select', t);
    execute format('drop policy if exists %I on %I;', t || '_insert', t);
    execute format('drop policy if exists %I on %I;', t || '_update', t);
    execute format('drop policy if exists %I on %I;', t || '_delete', t);
    execute format('create policy %I on %I for select to authenticated using (true);', t || '_select', t);
    execute format('create policy %I on %I for insert to authenticated with check (true);', t || '_insert', t);
    execute format('create policy %I on %I for update to authenticated using (is_admin()) with check (is_admin());', t || '_update', t);
    execute format('create policy %I on %I for delete to authenticated using (is_admin());', t || '_delete', t);
  end loop;
end $$;

-- ====================================================================
-- التحقق بعد التشغيل
-- ====================================================================
-- (أ) كل الجداول لازم تبقى rowsecurity = true:
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' order by tablename;
--
-- (ب) عرض كل السياسات المطبّقة:
--   select tablename, policyname, cmd, roles from pg_policies
--   where schemaname = 'public' order by tablename, policyname;
--
-- (ج) اختبار سريع إنك مدير (بعد تسجيل الدخول من التطبيق، من console المتصفح):
--   const { data } = await sb.rpc('is_admin'); console.log('is_admin =', data);
--   -- المفروض true لحسابك كمدير، false للموظف.
--
-- ====================================================================
-- التراجع (Rollback) — يرجّع كل حاجة لحالتها المفتوحة السابقة
-- ====================================================================
-- do $$
-- declare t text;
--   all_tables text[] := array['trainees','attendance','employees','groups',
--     'sessions','staff_attendance','feedback','meta','card_serials','payments','expenses','admins'];
-- begin
--   foreach t in array all_tables loop
--     if to_regclass(t) is not null then
--       execute format('alter table %I disable row level security;', t);
--     end if;
--   end loop;
-- end $$;
