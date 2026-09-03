-- South African statutory leave types for the HR/Linen app.
-- Run once in the Supabase SQL editor.
--
-- Until now hr_leave had no type column at all — every row was implicitly
-- annual leave, counted per calendar year against
-- hr_employees.annual_leave_days. This adds the BCEA types alongside it.
--
-- THE ONE THING THAT ISN'T JUST "ANOTHER DROPDOWN VALUE":
-- sick leave runs on a THIRTY-SIX MONTH cycle, not a year. 30 days per
-- 3-year cycle, anchored on the employee's start date. A per-calendar-year
-- counter would silently give each employee 30 sick days every year instead
-- of every three years — a tenfold over-grant that looks completely normal
-- on screen. That is why hr_leave_entitlements carries cycle_months rather
-- than assuming 12, and why balances are computed against the employee's
-- own cycle window rather than a calendar year.
--
-- Entitlements are DATA, not constants in the code, for two reasons:
-- many employers grant more than the statutory minimum, and parental leave
-- is currently unsettled law (Van Wyk, ConCourt 3 Oct 2025 — declaration of
-- invalidity suspended 36 months to Oct 2028 while Parliament legislates).
-- Hard-coding today's numbers would guarantee a code change later.
--
-- AFTER RUNNING: toggle hr_leave_entitlements ON under
-- Data API -> Exposed tables. Auto-expose is OFF in this project, so GRANT
-- and RLS alone are not enough.

-- 1. Type on the leave record ----------------------------------------------
-- Default 'annual' is deliberate: every existing row WAS annual leave, so
-- the default backfills history correctly rather than leaving it unknown.
alter table hr_leave
  add column if not exists leave_type text not null default 'annual';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'hr_leave_leave_type_check'
  ) then
    alter table hr_leave
      add constraint hr_leave_leave_type_check
      check (leave_type in ('annual', 'sick', 'family_responsibility', 'maternity'));
  end if;
end $$;

create index if not exists idx_hr_leave_employee_type
  on hr_leave (employee_id, leave_type);

-- 2. Entitlements per company ----------------------------------------------
create table if not exists hr_leave_entitlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  leave_type text not null check (leave_type in ('annual', 'sick', 'family_responsibility', 'maternity')),
  label text not null,
  -- Days granted per cycle. For maternity this is per birth, not per cycle
  -- (see cycle_months below).
  days_per_cycle numeric not null default 0,
  -- 12 for annual and family responsibility, 36 for sick.
  -- NULL means "not a recurring allowance" — maternity is per event, so
  -- there is no running balance to draw down and none is shown.
  cycle_months integer,
  -- Paid BY THE EMPLOYER. Maternity is false: it is unpaid by the employer
  -- and claimed from UIF. This drives whether the leave builds a salary
  -- accrual in the Finance Dashboard's staff cost report.
  paid boolean not null default true,
  -- Minimum months of service before the employee qualifies. Family
  -- responsibility leave requires 4 months' service under the BCEA.
  min_service_months integer not null default 0,
  sort_order integer not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  unique (company_id, leave_type)
);

alter table hr_leave_entitlements enable row level security;

-- Read: anyone with company access — a manager needs to see remaining
-- balances to approve leave. Write: HR admins only, since changing an
-- entitlement silently rewrites every balance in the app.
drop policy if exists "read_hr_leave_entitlements" on hr_leave_entitlements;
create policy "read_hr_leave_entitlements" on hr_leave_entitlements
  for select using (has_company_access(company_id));

drop policy if exists "hr_admin_write_hr_leave_entitlements" on hr_leave_entitlements;
create policy "hr_admin_write_hr_leave_entitlements" on hr_leave_entitlements
  for all using (has_company_access(company_id) and (is_hr_admin(company_id) or is_platform_admin()))
  with check (has_company_access(company_id) and (is_hr_admin(company_id) or is_platform_admin()));

grant select, insert, update, delete on hr_leave_entitlements to authenticated;

-- 3. BCEA defaults for every company ---------------------------------------
-- Statutory minimums for a five-day-week employee. An employer may grant
-- more; none of these may be reduced.
--
--   Annual   15 working days per 12 months (BCEA: 21 consecutive days)
--   Sick     30 days per 36 months (the days worked in six weeks)
--   Family   3 days per 12 months, after 4 months' service, no carry-over
--   Maternity 4 consecutive months (~120 days) per birth, unpaid by employer
insert into hr_leave_entitlements
  (company_id, leave_type, label, days_per_cycle, cycle_months, paid, min_service_months, sort_order, notes)
select c.id, v.leave_type, v.label, v.days, v.cycle_months, v.paid, v.min_service, v.sort_order, v.notes
from companies c
join (values
  ('annual', 'Annual leave', 15, 12, true, 0, 1,
   'BCEA minimum: 21 consecutive days per 12-month cycle = 15 working days on a five-day week. Per-employee overrides live on the employee record.'),
  ('sick', 'Sick leave', 30, 36, true, 0, 2,
   'BCEA: days worked in six weeks, per 36-month cycle. During the first six months of employment the entitlement is capped at 1 day per 26 days worked.'),
  ('family_responsibility', 'Family responsibility leave', 3, 12, true, 4, 3,
   'BCEA: 3 days per 12-month cycle after 4 months service, for employees working at least 4 days a week. Does NOT carry over — unused days lapse at cycle end.'),
  ('maternity', 'Maternity leave', 120, null, false, 0, 4,
   'BCEA: 4 consecutive months per birth, from 4 weeks before the due date. Unpaid by the employer; claimed from UIF. Per event, so no running balance.')
) as v(leave_type, label, days, cycle_months, paid, min_service, sort_order, notes) on true
on conflict (company_id, leave_type) do nothing;

-- =========================================================================
-- VERIFICATION — expect 4 rows per company, sick showing cycle_months = 36
-- and maternity showing paid = false.
-- =========================================================================
select c.name, e.leave_type, e.days_per_cycle, e.cycle_months, e.paid, e.min_service_months
from hr_leave_entitlements e
join companies c on c.id = e.company_id
order by c.name, e.sort_order;
