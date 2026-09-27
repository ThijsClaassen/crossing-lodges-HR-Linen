-- add_hr_appraisals.sql — position requirements, and a record of each
-- appraisal conversation (#486, 2026-09-27).
--
-- Thijs: "When doing staff appraisal, in HR being able to download a file
-- where all info is showing, qualifications, off/sick things. Position
-- requirements."
--
-- The pack itself is assembled in the app from what already exists —
-- contract, leave and sick record, off-day pattern and rostered extras,
-- licences and qualifications (#484), bonuses — so the only things that
-- needed a home were:
--
--   1. hr_position_requirements — what a position asks of the person holding
--      it, so the pack can show requirements next to what they hold. Free
--      text for the human part; a short list of qualification kinds for the
--      part the app can tick off automatically ("drivers_licence:EC",
--      "first_aid", "pdp").
--   2. hr_appraisals — the notes from the conversation, so the next appraisal
--      starts from the last one instead of from memory.
--
-- SENSITIVE BY CONSTRUCTION: sick leave and appraisal notes about a named
-- person. Both tables are HR-admin only, the same wall as contracts, loans
-- and bonuses. Position requirements are not sensitive, but there is no
-- reason for anyone else to edit them, so admin/HR-admin write, company read.
--
-- Safe to re-run. NEW TABLES — expose under Data API if not automatic.

create table if not exists hr_position_requirements (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references companies(id) on delete cascade,
  position                text not null,
  requirements            text,            -- one per line, free text
  required_qualifications text,            -- comma list: drivers_licence:EC, pdp, first_aid, fgasa:1
  updated_at              timestamptz not null default now(),
  unique (company_id, position)
);
alter table hr_position_requirements enable row level security;
drop policy if exists "read hr_position_requirements" on hr_position_requirements;
create policy "read hr_position_requirements" on hr_position_requirements
  for select using (has_company_access(company_id));
drop policy if exists "admin write hr_position_requirements" on hr_position_requirements;
create policy "admin write hr_position_requirements" on hr_position_requirements
  for all
  using (has_company_access(company_id) and (has_company_role(company_id, 'admin') or is_hr_admin(company_id) or is_platform_admin()))
  with check (has_company_access(company_id) and (has_company_role(company_id, 'admin') or is_hr_admin(company_id) or is_platform_admin()));
grant select, insert, update, delete on hr_position_requirements to authenticated;

create table if not exists hr_appraisals (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id) on delete cascade,
  employee_id    uuid not null references hr_employees(id) on delete cascade,
  appraisal_date date not null default current_date,
  period_from    date not null,
  period_to      date not null,
  appraiser      text,
  rating         text,                     -- free: "meets", "exceeds", "1-5" — whatever the company uses
  strengths      text,
  development    text,
  agreed_actions text,
  notes          text,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  constraint hr_appraisals_period check (period_to >= period_from)
);
create index if not exists hr_appraisals_employee_idx on hr_appraisals (company_id, employee_id, appraisal_date desc);
alter table hr_appraisals enable row level security;
drop policy if exists "hr_admin_read_hr_appraisals" on hr_appraisals;
create policy "hr_admin_read_hr_appraisals" on hr_appraisals
  for select using (has_company_access(company_id) and is_hr_admin(company_id));
drop policy if exists "hr_admin_write_hr_appraisals" on hr_appraisals;
create policy "hr_admin_write_hr_appraisals" on hr_appraisals
  for all
  using (has_company_access(company_id) and is_hr_admin(company_id))
  with check (has_company_access(company_id) and is_hr_admin(company_id));
grant select, insert, update, delete on hr_appraisals to authenticated;

-- ===========================================================================
-- THE MIGRATION ENDS HERE.
-- ===========================================================================
select 'hr_position_requirements' as what, count(*) from hr_position_requirements
union all select 'hr_appraisals', count(*) from hr_appraisals;
