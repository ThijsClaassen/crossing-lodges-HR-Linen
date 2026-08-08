-- Run once in the Supabase SQL editor.
--
-- HR/LINEN 3a of the multi-tenant rebuild.
--
-- This is the SAME Supabase project the Finance Dashboard and Food Stock
-- already migrated (confirmed with Thijs, 2026-08-08), so `companies`,
-- `user_companies`, `platform_admins`, `has_company_access()`,
-- `has_company_role()`, and `default_crossing_lodges_company_id()` ALL
-- ALREADY EXIST — nothing from Phase 1 needs to be recreated.
--
-- This app is different from Finance Dashboard/Food Stock in one way that
-- needs a genuine backbone addition, not just a per-app company_id column:
-- it has THREE login tiers (staff / admin / hradmin), not the two
-- (admin/staff) `user_companies.role` supports. Looking at how the app
-- actually uses 'hradmin' throughout (always `role === 'admin' || role ===
-- 'hradmin'`), HR Admin is really "admin, plus access to Contracts" — not
-- a parallel tier. Rather than widen the shared user_companies.role check
-- (which every other app's login also reads), this adds ONE new allow-list
-- table, `hr_admins`, the exact same deliberate pattern as
-- `platform_admins`: a separate table for a sensitive elevated permission,
-- not a role string that could leak into apps that shouldn't care about it.
-- Confirmed with Thijs (2026-08-08).
--
-- Also takes the opportunity the README itself invites: "Contracts...
-- worth knowing given the sensitivity of the data... ask if you want this
-- tightened with real per-user Supabase Auth instead." Phase 3c will make
-- hr_contracts' RLS require BOTH company access AND hr_admin status — not
-- just "any company member" like the other 10 tables — actually closing
-- that gap rather than carrying it forward.
--
-- Also drops the hardcoded `check (location_id in ('ZC','EC','SC'))`
-- constraint on the 3 tables that have one (hr_linen_stock,
-- hr_linen_movements, hr_schedule_locations) — same reasoning and same
-- decision Thijs already made for Food Stock: don't block a future
-- company from using its own property codes.
--
-- hr_access (the now-to-be-unused three-tier shared password table) is
-- deliberately left untouched — becomes unused once 3b ships real auth,
-- cleanup is a later decision, same as food_access.
--
-- Safe to re-run: every statement uses "if not exists" / "if exists", and
-- every backfill only touches rows where company_id is still null.

-- 1. hr_admins — per-company HR Admin allow-list ---------------------------

create table if not exists hr_admins (
  user_id     uuid not null references auth.users(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, company_id)
);

alter table hr_admins enable row level security;
drop policy if exists "read own hr admin status" on hr_admins;
create policy "read own hr admin status" on hr_admins
  for select using (user_id = auth.uid() or is_platform_admin());
-- No insert/update/delete policy for the client — granting HR Admin status
-- is a deliberate, SQL-editor-only action, same as user_companies and
-- platform_admins (see the worked example at the bottom of this file).

-- Explicit grant, belt-and-braces alongside the RLS policy above (Postgres
-- requires a table-level grant separately from RLS for anon/authenticated
-- to touch a table at all) — matching the explicit-grants style each app's
-- own schema.sql already uses, even though Phase 1's companies/
-- user_companies/platform_admins didn't need one spelled out (this
-- project's default privileges already cover it).
grant select on public.hr_admins to anon, authenticated;

create or replace function is_hr_admin(target_company_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    is_platform_admin()
    or exists (
      select 1 from hr_admins
      where user_id = auth.uid() and company_id = target_company_id
    );
$$;

-- 2. Add company_id (defaulted from the start) to every HR/Linen table ----

alter table hr_employees add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table hr_suppliers add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table hr_uniform_items add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table hr_uniform_stock add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table hr_uniform_issues add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table hr_linen_items add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table hr_linen_stock add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table hr_linen_movements add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table hr_contracts add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table hr_schedule_locations add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();
alter table hr_leave add column if not exists company_id uuid references companies(id)
  default default_crossing_lodges_company_id();

-- 3. Backfill every existing row to Crossing Lodges ------------------------

update hr_employees set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update hr_suppliers set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update hr_uniform_items set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update hr_uniform_stock set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update hr_uniform_issues set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update hr_linen_items set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update hr_linen_stock set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update hr_linen_movements set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update hr_contracts set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update hr_schedule_locations set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;
update hr_leave set company_id = (select id from companies where slug = 'crossing-lodges') where company_id is null;

-- 4. Lock it down -----------------------------------------------------------

alter table hr_employees alter column company_id set not null;
alter table hr_suppliers alter column company_id set not null;
alter table hr_uniform_items alter column company_id set not null;
alter table hr_uniform_stock alter column company_id set not null;
alter table hr_uniform_issues alter column company_id set not null;
alter table hr_linen_items alter column company_id set not null;
alter table hr_linen_stock alter column company_id set not null;
alter table hr_linen_movements alter column company_id set not null;
alter table hr_contracts alter column company_id set not null;
alter table hr_schedule_locations alter column company_id set not null;
alter table hr_leave alter column company_id set not null;

-- 5. Indexes ------------------------------------------------------------------

create index if not exists idx_hr_employees_company on hr_employees (company_id);
create index if not exists idx_hr_suppliers_company on hr_suppliers (company_id);
create index if not exists idx_hr_uniform_items_company on hr_uniform_items (company_id);
create index if not exists idx_hr_uniform_stock_company on hr_uniform_stock (company_id);
create index if not exists idx_hr_uniform_issues_company on hr_uniform_issues (company_id);
create index if not exists idx_hr_linen_items_company on hr_linen_items (company_id);
create index if not exists idx_hr_linen_stock_company on hr_linen_stock (company_id);
create index if not exists idx_hr_linen_movements_company on hr_linen_movements (company_id);
create index if not exists idx_hr_contracts_company on hr_contracts (company_id);
create index if not exists idx_hr_schedule_locations_company on hr_schedule_locations (company_id);
create index if not exists idx_hr_leave_company on hr_leave (company_id);

-- 6. Drop the hardcoded ZC/EC/SC location check on the 3 tables that have one

alter table hr_linen_stock drop constraint if exists hr_linen_stock_location_id_check;
alter table hr_linen_movements drop constraint if exists hr_linen_movements_location_id_check;
alter table hr_schedule_locations drop constraint if exists hr_schedule_locations_location_id_check;

-- =========================================================================
-- Grant Thijs HR Admin access for Crossing Lodges — he's using the
-- hradmin tier today via the shared password, so this needs to run before
-- 3b ships real auth, or he'd lose Contracts access. Uses his existing
-- auth user id (already a platform admin and Crossing Lodges admin from
-- Phase 1 — thijs@crossinglodges.com, id 4e47ef79-7cfa-44d9-aa2e-067ce1ac9aa5).
-- =========================================================================

insert into hr_admins (user_id, company_id)
values (
  '4e47ef79-7cfa-44d9-aa2e-067ce1ac9aa5',
  (select id from companies where slug = 'crossing-lodges')
)
on conflict (user_id, company_id) do nothing;

-- =========================================================================
-- VERIFICATION — run this and check "total" equals "with_company" on every
-- row.
-- =========================================================================

select 'hr_employees' as table_name, count(*) as total, count(company_id) as with_company from hr_employees
union all select 'hr_suppliers', count(*), count(company_id) from hr_suppliers
union all select 'hr_uniform_items', count(*), count(company_id) from hr_uniform_items
union all select 'hr_uniform_stock', count(*), count(company_id) from hr_uniform_stock
union all select 'hr_uniform_issues', count(*), count(company_id) from hr_uniform_issues
union all select 'hr_linen_items', count(*), count(company_id) from hr_linen_items
union all select 'hr_linen_stock', count(*), count(company_id) from hr_linen_stock
union all select 'hr_linen_movements', count(*), count(company_id) from hr_linen_movements
union all select 'hr_contracts', count(*), count(company_id) from hr_contracts
union all select 'hr_schedule_locations', count(*), count(company_id) from hr_schedule_locations
union all select 'hr_leave', count(*), count(company_id) from hr_leave
order by table_name;

-- Confirm the hr_admins grant worked and is_hr_admin() resolves correctly:
--   select * from hr_admins;
--   select is_hr_admin((select id from companies where slug = 'crossing-lodges'));
-- (the second one runs as the SQL editor's own elevated role, not as you,
-- so it isn't proof by itself — the real proof is logging into the live
-- app and seeing the Contracts tab once 3b ships.)
