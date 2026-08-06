-- v4 migration — run this once in the Supabase SQL editor.
-- Changes lodge assignment on the Schedule tab from "once per 21-day
-- working block" to "once per calendar week" — you asked to be able to
-- change an employee's lodge week to week, not just once per rotation.
--
-- Safe to run on your live database. Any lodge assignments you already
-- made under the old block-based system are kept as rows, but they'll
-- only re-apply automatically if their stored date happens to land on a
-- Monday (a week start) — otherwise just re-pick the lodge for the
-- relevant week(s) on the Schedule tab, it takes a few seconds.

alter table hr_schedule_locations
  drop constraint if exists hr_schedule_locations_employee_id_block_start_date_key;

alter table hr_schedule_locations
  rename column block_start_date to week_start_date;

alter table hr_schedule_locations
  add constraint hr_schedule_locations_employee_id_week_start_date_key unique (employee_id, week_start_date);
