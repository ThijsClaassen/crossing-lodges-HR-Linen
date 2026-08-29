-- Run once in the Supabase SQL editor.
--
-- Bonuses (2026-08-27) — Thijs: "for staff cost, we need to add some cost.
-- Leave pay, uniforms, bonuses."
--
-- Of those three, only bonuses need somewhere new to live:
--   * Uniforms are already derivable — hr_uniform_items carries a price and
--     every hr_uniform_issues row records the employee and issue date, so
--     actual uniform spend per person is a join, not a new field.
--   * Leave is already derivable — hr_employees.annual_leave_days is the
--     entitlement and hr_leave.days_used is what's been taken, so the accrued
--     (owed but untaken) balance and its rand value both fall out of existing
--     data.
--   * Bonuses have no record anywhere, so they get this table.
--
-- Deliberately NOT folded into hr_contracts: a contract holds ongoing monthly
-- terms, whereas a bonus is a dated one-off event. Putting it on the contract
-- would either overwrite the previous bonus or misrepresent it as recurring.
--
-- Safe to re-run.

create table if not exists hr_bonuses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  employee_id uuid not null references hr_employees(id) on delete cascade,
  bonus_date date not null,
  amount numeric not null check (amount >= 0),
  -- Free text rather than an enum: "13th cheque", "performance", "long
  -- service", "guest commendation" — the list will grow and shouldn't need a
  -- migration each time.
  bonus_type text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_hr_bonuses_company on hr_bonuses (company_id);
create index if not exists idx_hr_bonuses_employee on hr_bonuses (employee_id);
create index if not exists idx_hr_bonuses_date on hr_bonuses (bonus_date);

alter table hr_bonuses enable row level security;

-- HR-admin only, in both directions. Bonus amounts are as sensitive as salary
-- — the same wall hr_contracts sits behind (is_hr_admin, see
-- add_company_id_and_hr_admins.sql), not merely company access.
drop policy if exists "hr_admin_read_hr_bonuses" on hr_bonuses;
create policy "hr_admin_read_hr_bonuses" on hr_bonuses
  for select using (has_company_access(company_id) and is_hr_admin(company_id));

drop policy if exists "hr_admin_write_hr_bonuses" on hr_bonuses;
create policy "hr_admin_write_hr_bonuses" on hr_bonuses
  for all
  using (has_company_access(company_id) and is_hr_admin(company_id))
  with check (has_company_access(company_id) and is_hr_admin(company_id));

-- =========================================================================
-- VERIFICATION
-- =========================================================================

select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'hr_bonuses'
order by ordinal_position;

select count(*) as bonuses from hr_bonuses;

-- Sanity check for the uniform costing: any uniform item with no price set
-- contributes R0, so these are the ones to fill in if uniform cost looks low.
select c.name as company, u.name as item, u.category, u.size, u.price
from hr_uniform_items u join companies c on c.id = u.company_id
where u.price is null or u.price = 0
order by c.name, u.name;

-- REMINDER: hr_bonuses is a NEW table — switch it on under
-- Data API -> Exposed tables, or every read/write from the app 404s.
