-- v2 migration — run this once in the Supabase SQL editor.
-- Restructures the app: employees, uniforms, suppliers, and contracts
-- become ONE company-wide list/pool (people and uniform stock aren't tied
-- to a single lodge) — only Linen keeps its per-lodge split, since linen
-- physically lives at each property. Also adds prices to uniform and
-- linen items so stock value, order value, and write-off value can be
-- tracked for budgeting.
--
-- Safe to run on your live database — existing per-location uniform stock
-- is consolidated (summed) into one row per item rather than discarded.

-- ---------------------------------------------------------------------------
-- 1. Employees — drop the per-lodge split, one shared list.
-- ---------------------------------------------------------------------------
drop index if exists idx_hr_employees_location;
alter table hr_employees drop column if exists location_id;

-- ---------------------------------------------------------------------------
-- 2. Uniform stock — consolidate existing per-location rows into one row
--    per item (summing quantities; taking the highest min/max seen), then
--    drop location_id and switch the unique constraint to item_id alone.
-- ---------------------------------------------------------------------------
create temp table hr_uniform_stock_consolidated as
  select
    item_id,
    sum(qty_on_hand) as qty_on_hand,
    max(min_units) as min_units,
    max(max_units) as max_units
  from hr_uniform_stock
  group by item_id;

delete from hr_uniform_stock;

-- CASCADE drops the old unique(item_id, location_id) constraint along with
-- the column, since that constraint depends on location_id.
alter table hr_uniform_stock drop column if exists location_id cascade;
alter table hr_uniform_stock add constraint hr_uniform_stock_item_id_key unique (item_id);

insert into hr_uniform_stock (item_id, qty_on_hand, min_units, max_units)
  select item_id, qty_on_hand, min_units, max_units from hr_uniform_stock_consolidated;

drop table hr_uniform_stock_consolidated;

-- ---------------------------------------------------------------------------
-- 3. Uniform issues — no longer needs a location tag either, now that
--    issuing isn't tied to a lodge.
-- ---------------------------------------------------------------------------
drop index if exists idx_hr_uniform_issues_location;
alter table hr_uniform_issues drop column if exists location_id;

-- ---------------------------------------------------------------------------
-- 4. Prices — for stock value, order value, and write-off value tracking.
-- ---------------------------------------------------------------------------
alter table hr_uniform_items add column if not exists price numeric not null default 0;
alter table hr_linen_items   add column if not exists price numeric not null default 0;
