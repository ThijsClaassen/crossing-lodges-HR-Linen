-- Run once in the Supabase SQL editor.
--
-- HR/LINEN 3c of the multi-tenant rebuild.
--
-- Drops the permissive `allow_all_hr_<table> for all using (true) with
-- check (true)` policies (same shape as Food Stock's original schema) on
-- all 11 company-scoped HR/Linen tables, replaces them with
-- has_company_access(company_id) — same pattern as Finance Dashboard and
-- Food Stock's 2c/3c.
--
-- hr_contracts gets something extra: its policy requires has_company_access
-- AND is_hr_admin(company_id), not just company membership. This is the
-- fix the app's own README asked for — contracts hold salary/medical
-- aid/pension, and previously had zero DB-level protection (`using (true)`,
-- same as everything else). Now only company admins granted HR Admin
-- status (via the hr_admins table, 3a) can read or write it — a Staff or
-- plain Admin session in the app already doesn't fetch this table (see
-- loadAll()'s role === 'hradmin' guard), but RLS is what makes that
-- actually enforced rather than just client-side politeness.
--
-- hr_access (the old shared-password table) is left exactly as it is —
-- still has its original select-only `allow_read_hr_access` policy. It's
-- unused now that 3b ships real Supabase Auth, but touching its RLS isn't
-- necessary and cleanup is a later decision (same as food_access).
--
-- Safe to re-run: every create policy is preceded by drop policy if exists.

-- 1. The 10 tables that just need company scoping -------------------------

drop policy if exists "allow_all_hr_employees" on hr_employees;
create policy "allow_all_hr_employees" on hr_employees
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists "allow_all_hr_suppliers" on hr_suppliers;
create policy "allow_all_hr_suppliers" on hr_suppliers
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists "allow_all_hr_uniform_items" on hr_uniform_items;
create policy "allow_all_hr_uniform_items" on hr_uniform_items
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists "allow_all_hr_uniform_stock" on hr_uniform_stock;
create policy "allow_all_hr_uniform_stock" on hr_uniform_stock
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists "allow_all_hr_uniform_issues" on hr_uniform_issues;
create policy "allow_all_hr_uniform_issues" on hr_uniform_issues
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists "allow_all_hr_linen_items" on hr_linen_items;
create policy "allow_all_hr_linen_items" on hr_linen_items
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists "allow_all_hr_linen_stock" on hr_linen_stock;
create policy "allow_all_hr_linen_stock" on hr_linen_stock
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists "allow_all_hr_linen_movements" on hr_linen_movements;
create policy "allow_all_hr_linen_movements" on hr_linen_movements
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists "allow_all_hr_schedule_locations" on hr_schedule_locations;
create policy "allow_all_hr_schedule_locations" on hr_schedule_locations
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

drop policy if exists "allow_all_hr_leave" on hr_leave;
create policy "allow_all_hr_leave" on hr_leave
  for all using (has_company_access(company_id)) with check (has_company_access(company_id));

-- 2. hr_contracts — company access AND HR Admin status ---------------------

drop policy if exists "allow_all_hr_contracts" on hr_contracts;
create policy "allow_all_hr_contracts" on hr_contracts
  for all
  using (has_company_access(company_id) and is_hr_admin(company_id))
  with check (has_company_access(company_id) and is_hr_admin(company_id));

-- =========================================================================
-- VERIFICATION — confirm every policy above now exists and reads the
-- expected condition.
-- =========================================================================

select tablename, policyname, cmd, qual, with_check
from pg_policies
where tablename in (
  'hr_employees', 'hr_suppliers', 'hr_uniform_items', 'hr_uniform_stock',
  'hr_uniform_issues', 'hr_linen_items', 'hr_linen_stock',
  'hr_linen_movements', 'hr_contracts', 'hr_schedule_locations', 'hr_leave'
)
order by tablename;

-- After running, the real isolation test (3d) is logging into the app as
-- the Crossing Lodges admin and confirming everything still loads exactly
-- as before, then as the Demo test user and confirming Contracts is
-- invisible/empty (since Demo has no hr_admins row) while everything else
-- is scoped correctly.
