-- Rostered extra days off, on top of a working pattern (#458).
--
-- Crossing Lodges' local staff are off every Sunday PLUS three days a month
-- that someone picks per person. Those three cannot come from a pattern
-- because they are a DECISION, not a rule: they move with who is needed when.
--
-- So this is a layer over the pattern rather than another kind of pattern. A
-- rostered day can only ever turn a working day into an off day; it can never
-- turn an off day into a working one. A roster that could cancel somebody's
-- Sunday is not a roster, it is a mistake waiting to be made.
--
-- Safe to re-run.
--
-- ===========================================================================
-- RUN add_hr_shift_patterns.sql FIRST. This builds on it.
--
-- And a warning learned the hard way on 2026-09-21: the Supabase SQL editor
-- wraps this whole file in ONE transaction, so an error anywhere — including
-- in a check statement at the bottom — rolls back everything above it. If you
-- edit a check, run it on its own first.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE ROSTER
--
-- One row per person per day off. Deliberately not "three days per month" as
-- a count: the count is a policy, the dates are the fact, and storing the
-- fact means the schedule grid can show exactly which days without anybody
-- interpreting anything.
create table if not exists hr_employee_off_days (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  employee_id uuid not null references hr_employees(id) on delete cascade,
  off_date date not null,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,

  -- The same day cannot be given twice. Without this, a double-click makes
  -- two rows and the month's count reads four when three were given.
  unique (employee_id, off_date)
);

comment on table hr_employee_off_days is
  'Extra days off ROSTERED per employee, on top of whatever their shift '
  'pattern says. Only ever turns a working day into an off day.';

-- The schedule grid asks for a visible window, and the leave calculation asks
-- for a request range. Both are employee + date range.
create index if not exists idx_hr_off_days_employee_date
  on hr_employee_off_days (employee_id, off_date);

create index if not exists idx_hr_off_days_company_date
  on hr_employee_off_days (company_id, off_date);


-- ---------------------------------------------------------------------------
-- 2. RLS. Read for any member, write for admins — same shape as the rest of
-- this schema, platform-admin arm included.
alter table hr_employee_off_days enable row level security;

drop policy if exists hr_off_days_select on hr_employee_off_days;
create policy hr_off_days_select on hr_employee_off_days
  for select using (has_company_access(company_id));

drop policy if exists hr_off_days_write on hr_employee_off_days;
create policy hr_off_days_write on hr_employee_off_days
  for all using (
    has_company_access(company_id)
    and (has_company_role(company_id, 'admin') or is_platform_admin())
  )
  with check (
    has_company_access(company_id)
    and (has_company_role(company_id, 'admin') or is_platform_admin())
  );


-- ---------------------------------------------------------------------------
-- AFTER RUNNING THIS: turn hr_employee_off_days ON under Data API -> Exposed
-- tables. Auto-expose is OFF in this project, so GRANT and RLS alone leave it
-- invisible to the app.


-- ---------------------------------------------------------------------------
-- CHECKS (see the transaction warning at the top before editing these)

-- a) The table is there and empty, which is correct on a fresh migration —
--    nothing is rostered until somebody rosters it.
select count(*) as rostered_days from hr_employee_off_days;

-- b) After you have set a month in the app: what was given, to whom.
select e.first_name, e.last_name, o.off_date, o.note
  from hr_employee_off_days o
  join hr_employees e on e.id = o.employee_id
 order by o.off_date desc, e.first_name
 limit 50;

-- c) Days per person per month — the number you are actually managing to.
--    Three is the policy; this shows where it was not met.
select e.first_name, e.last_name,
       to_char(o.off_date, 'YYYY-MM') as month,
       count(*) as days_given
  from hr_employee_off_days o
  join hr_employees e on e.id = o.employee_id
 group by e.first_name, e.last_name, to_char(o.off_date, 'YYYY-MM')
 order by month desc, e.first_name;
