-- v3 migration — run this once in the Supabase SQL editor.
-- Adds the work-schedule builder: each employee's recurring 21-days-on /
-- 7-days-off rotation, which lodge they're assigned to for each working
-- block, and annual leave (allocation + logged leave that automatically
-- marks days unavailable and deducts from the balance).
--
-- Safe to run on your live database — purely additive, no existing data
-- is touched.

-- ---------------------------------------------------------------------------
-- 1. Employees — a cycle anchor date (any date that fell on day 1 of a
--    known working block; the app calculates on/off going forward AND
--    backward in 28-day steps from there, so it doesn't have to be a
--    future date) and how many annual leave days they get, per calendar
--    year, going forward.
-- ---------------------------------------------------------------------------
alter table hr_employees add column if not exists cycle_anchor_date date;
alter table hr_employees add column if not exists annual_leave_days numeric not null default 0;

-- ---------------------------------------------------------------------------
-- 2. hr_schedule_locations — which lodge an employee is working at for a
--    given working block. Keyed by the block's start date (not a week or
--    a day) since a 21-day block commonly spans parts of 3-4 calendar
--    weeks — one assignment covers the whole block. Cycles don't have to
--    align to calendar weeks, so this is looked up by the exact date the
--    app calculates as "day 1" of that particular on-stretch.
-- ---------------------------------------------------------------------------
create table if not exists hr_schedule_locations (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references hr_employees(id) on delete cascade,
  block_start_date date not null,
  location_id     text not null check (location_id in ('ZC', 'EC', 'SC')),
  created_at      timestamptz not null default now(),
  unique (employee_id, block_start_date)
);

create index if not exists idx_hr_schedule_locations_employee on hr_schedule_locations(employee_id);

-- ---------------------------------------------------------------------------
-- 3. hr_leave — one row per logged leave period (start/end date, inclusive).
--    days_used is a SNAPSHOT taken when the leave is logged: only the days
--    in the range that fell on a scheduled WORKING day count (a day that
--    was already a regular off-cycle day costs nothing) — stored rather
--    than recalculated live, so a later change to someone's cycle anchor
--    can't silently rewrite historical leave balances.
-- ---------------------------------------------------------------------------
create table if not exists hr_leave (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references hr_employees(id) on delete cascade,
  start_date    date not null,
  end_date      date not null,
  days_used     numeric not null default 0,
  note          text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_hr_leave_employee on hr_leave(employee_id);

-- ---------------------------------------------------------------------------
-- RLS + grants — same open allow_all pattern as the rest of this app.
-- ---------------------------------------------------------------------------
alter table hr_schedule_locations enable row level security;
alter table hr_leave              enable row level security;

drop policy if exists allow_all_hr_schedule_locations on hr_schedule_locations;
create policy allow_all_hr_schedule_locations on hr_schedule_locations
  for all using (true) with check (true);

drop policy if exists allow_all_hr_leave on hr_leave;
create policy allow_all_hr_leave on hr_leave
  for all using (true) with check (true);

grant select, insert, update, delete on public.hr_schedule_locations to anon, authenticated;
grant select, insert, update, delete on public.hr_leave              to anon, authenticated;
