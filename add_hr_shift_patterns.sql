-- Work patterns: more than one shape of working life (#453).
--
-- The app has had exactly one rotation hardcoded since it was built — 21 days
-- on, 7 off, counted from each employee's own cycle_anchor_date. That is right
-- for rotational staff who live on site and wrong for anyone local who works a
-- normal week with set days off.
--
-- Two kinds:
--   rotation    X days on, Y off, from an anchor date. What everyone does now.
--   fixed_week  the same weekdays off every week. Needs no anchor at all.
--
-- Safe to re-run.
--
-- ===========================================================================
-- THE MIGRATION RULE THIS FILE IS BUILT AROUND
--
-- Nobody's schedule may change as a result of running this. The seeded 21/7
-- pattern is assigned to every existing employee, and the app falls back to
-- the same 21/7 shape for anyone with no pattern at all — so the roster after
-- this migration is identical to the roster before it, whether or not the
-- assignment below matched every row.
--
-- That matters more than it sounds: this calculation decides who is on duty
-- AND how many days a leave request costs. A silent shift would move people's
-- leave balances with nothing on screen to say why.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE PATTERNS
create table if not exists hr_shift_patterns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  kind text not null default 'rotation' check (kind in ('rotation', 'fixed_week')),

  -- Rotation only. Null for a fixed_week pattern rather than zero: zero is a
  -- value, and "this pattern works zero days" is not what is meant.
  on_days integer,
  off_days integer,

  -- fixed_week only. 0 = Sunday .. 6 = Saturday, matching JavaScript's
  -- Date.getDay() so the app never has to translate between two conventions —
  -- an off-by-one in a weekday mapping moves somebody's day off and looks
  -- entirely plausible on screen.
  days_off smallint[] not null default '{}',

  active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),

  unique (company_id, name),

  -- The shape has to match the kind. Without this a rotation can be saved
  -- with no day counts and every employee on it silently loses their
  -- schedule, which shows as an empty grid rather than as an error.
  constraint hr_shift_patterns_shape check (
    (kind = 'rotation' and on_days is not null and on_days > 0 and off_days is not null and off_days >= 0)
    or
    (kind = 'fixed_week')
  ),

  -- Weekday numbers must be weekday numbers.
  constraint hr_shift_patterns_days_off_range check (
    days_off <@ array[0,1,2,3,4,5,6]::smallint[]
  )
);

comment on table hr_shift_patterns is
  'Named working patterns. An employee with no pattern falls back to the '
  'legacy 21-on/7-off rotation in code, so this table can be empty without '
  'anything breaking.';

comment on column hr_shift_patterns.days_off is
  'fixed_week only. 0=Sunday..6=Saturday, matching JS Date.getDay().';


-- ---------------------------------------------------------------------------
-- 2. THE ASSIGNMENT
--
-- Nullable on purpose. Null means the legacy rotation, which is exactly what
-- an unmigrated employee should get. ON DELETE SET NULL so removing a pattern
-- returns its people to the legacy shape rather than deleting employees.
alter table hr_employees
  add column if not exists shift_pattern_id uuid references hr_shift_patterns(id) on delete set null;

create index if not exists idx_hr_employees_shift_pattern
  on hr_employees (shift_pattern_id);


-- ---------------------------------------------------------------------------
-- 3. SEED — the pattern everyone is already on, plus two likely starters.
--
-- Named for what they are rather than for their numbers, so the dropdown
-- reads as a choice about a person rather than a sum.
insert into hr_shift_patterns (company_id, name, kind, on_days, off_days, note)
select c.id, 'Rotational 21 on / 7 off', 'rotation', 21, 7,
       'The pattern every employee was on before patterns existed.'
  from companies c
 where c.name ilike '%crossing%lodges%'
on conflict (company_id, name) do nothing;

insert into hr_shift_patterns (company_id, name, kind, on_days, off_days, note)
select c.id, 'Rotational 14 on / 7 off', 'rotation', 14, 7, null
  from companies c
 where c.name ilike '%crossing%lodges%'
on conflict (company_id, name) do nothing;

insert into hr_shift_patterns (company_id, name, kind, days_off, note)
select c.id, 'Local — Sundays off', 'fixed_week', array[0]::smallint[],
       'No cycle start date needed: the day of the week decides.'
  from companies c
 where c.name ilike '%crossing%lodges%'
on conflict (company_id, name) do nothing;


-- ---------------------------------------------------------------------------
-- 4. PUT EVERYONE ON THE PATTERN THEY ARE ALREADY ON
--
-- Only rows that have no pattern yet, so re-running cannot undo a deliberate
-- assignment made in the app afterwards.
update hr_employees e
   set shift_pattern_id = p.id
  from hr_shift_patterns p
 where p.company_id = e.company_id
   and p.name = 'Rotational 21 on / 7 off'
   and e.shift_pattern_id is null;


-- ---------------------------------------------------------------------------
-- 5. RLS. Read for any member, write for admins — the same shape as every
-- other table here, including the platform-admin arm without which a platform
-- admin operating on a tenant they do not belong to is locked out of their own
-- support tooling.
alter table hr_shift_patterns enable row level security;

drop policy if exists hr_shift_patterns_select on hr_shift_patterns;
create policy hr_shift_patterns_select on hr_shift_patterns
  for select using (has_company_access(company_id));

drop policy if exists hr_shift_patterns_write on hr_shift_patterns;
create policy hr_shift_patterns_write on hr_shift_patterns
  for all using (
    has_company_access(company_id)
    and (has_company_role(company_id, 'admin') or is_platform_admin())
  )
  with check (
    has_company_access(company_id)
    and (has_company_role(company_id, 'admin') or is_platform_admin())
  );


-- ---------------------------------------------------------------------------
-- AFTER RUNNING THIS: turn hr_shift_patterns ON under Data API -> Exposed
-- tables. Auto-expose is OFF in this project, so GRANT and RLS alone leave it
-- invisible to the app and the Schedule tab fails with a bare permission
-- error.


-- ---------------------------------------------------------------------------
-- CHECKS
--
-- These run in the SAME TRANSACTION as everything above, because the Supabase
-- SQL editor wraps the whole script in one. So a typo in a check statement
-- rolls back the migration that already succeeded — which is exactly what
-- happened on 2026-09-21: a wrong column name here (full_name, which this
-- table does not have) undid the entire file, and the only symptom was the
-- error from the last statement.
--
-- If you ever edit a check, run it on its own first.

-- a) The patterns exist and their shapes are valid.
select name, kind, on_days, off_days, days_off, active
  from hr_shift_patterns
 order by kind, name;

-- b) EVERY employee is on a pattern, and it is the 21/7 one. If any row comes
--    back with a different pattern, someone has already been reassigned in
--    the app and that is fine — but it should be deliberate.
select p.name as pattern, count(*) as employees
  from hr_employees e
  left join hr_shift_patterns p on p.id = e.shift_pattern_id
 group by p.name
 order by employees desc;

-- c) THE ONE THAT MATTERS. Nobody's schedule should have moved. Pick any
--    employee with a cycle anchor and confirm the app still shows the same
--    on/off days for this month as it did before the migration — the seeded
--    pattern is 21/7, so it should be identical. If it is not, stop and say
--    so rather than reassigning people to make it look right.
select id, first_name, last_name, cycle_anchor_date, shift_pattern_id
  from hr_employees
 where cycle_anchor_date is not null
 order by first_name, last_name
 limit 10;
