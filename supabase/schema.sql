-- Crossing Lodges HR & Housekeeping App — schema
-- Run this in the Supabase SQL editor of the SAME project used by
-- crossing-lodges-ops, crossing-lodges-beverage, and crossing-lodges-food
-- (https://arrendpmuwdhrfwvokhv.supabase.co), so all four apps share one
-- database. Naming follows the same department-prefix convention — this
-- app uses "hr_".
--
-- Unlike Beverage/Food, this is people and durable-goods tracking, not
-- consumable stock with monthly costing — no weighted-average cost engine
-- here, just current stock levels with reorder alerts.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- hr_access — three login tiers, own passwords, not shared with the other
-- apps' access tables:
--   staff    — issue/replace/return uniforms, log linen movements
--   admin    — all of staff, plus employees, item catalogs, suppliers, orders
--   hradmin  — all of admin, plus contracts (salary/medical aid/pension)
-- ---------------------------------------------------------------------------
create table if not exists hr_access (
  id          uuid primary key default gen_random_uuid(),
  role        text not null unique check (role in ('staff', 'admin', 'hradmin')),
  password    text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- hr_employees — ONE company-wide list. People work across lodges, so
-- there's no per-location split here (unlike Linen, further down).
-- ---------------------------------------------------------------------------
create table if not exists hr_employees (
  id                  uuid primary key default gen_random_uuid(),
  first_name          text not null,
  last_name           text not null,
  position            text,
  department          text,
  start_date          date,
  phone               text,
  email               text,
  status              text not null default 'Active' check (status in ('Active', 'Inactive')),
  notes               text,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  -- Work-schedule builder: any date that fell on day 1 of a known working
  -- block — on/off is calculated forward AND backward from there in
  -- 28-day (21 on + 7 off) steps, so it doesn't have to be a future date.
  -- Null = this person isn't on the rotation (e.g. office/admin staff).
  cycle_anchor_date   date,
  -- Leave days granted per calendar year, going forward, until changed.
  annual_leave_days   numeric not null default 0
);

-- ---------------------------------------------------------------------------
-- hr_suppliers — one shared list (not per-lodge), used by both uniforms
-- and linen for ordering.
-- ---------------------------------------------------------------------------
create table if not exists hr_suppliers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  contact_name  text,
  phone         text,
  email         text,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Uniforms
-- ---------------------------------------------------------------------------

-- Shared catalog — one master list of uniform types/sizes for the whole
-- company. price feeds stock value, order value, and write-off value.
create table if not exists hr_uniform_items (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,               -- e.g. 'Polo Shirt'
  category      text not null default 'Other', -- e.g. Shirt, Pants, Shoes, Jacket, Apron
  size          text,                          -- e.g. 'M', 'XL', '9' — free text
  price         numeric not null default 0,
  supplier_id   uuid references hr_suppliers(id) on delete set null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ONE company-wide stock pool per item — not split by lodge, since
-- uniforms follow the employee, and employees aren't tied to one lodge.
create table if not exists hr_uniform_stock (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references hr_uniform_items(id) on delete cascade,
  qty_on_hand   numeric not null default 0,
  min_units     numeric not null default 0,
  max_units     numeric not null default 0,
  updated_at    timestamptz not null default now(),
  unique (item_id)
);

-- Per-employee issue history. "Replace" (broken) creates a new row and
-- links back via replaces_issue_id; the broken one is retired, not
-- returned to stock (it counts as a write-off, valued at the item's
-- price). "Return" (good condition) puts it back in stock.
create table if not exists hr_uniform_issues (
  id                  uuid primary key default gen_random_uuid(),
  item_id             uuid not null references hr_uniform_items(id) on delete cascade,
  employee_id         uuid not null references hr_employees(id) on delete cascade,
  status              text not null default 'issued' check (status in ('issued', 'broken', 'returned')),
  issued_date         date not null default current_date,
  resolved_date       date,                      -- date it was marked broken/returned
  replaces_issue_id   uuid references hr_uniform_issues(id) on delete set null,
  note                text,
  created_at          timestamptz not null default now()
);

create index if not exists idx_hr_uniform_issues_employee on hr_uniform_issues(employee_id);
create index if not exists idx_hr_uniform_issues_status on hr_uniform_issues(status);

-- ---------------------------------------------------------------------------
-- Linen
-- ---------------------------------------------------------------------------

-- Shared catalog — duvets, pillow covers, towels, serviettes, gowns, etc.
-- Stock itself is still per-lodge (see hr_linen_stock below) — Linen is
-- the one part of this app that keeps a location split.
create table if not exists hr_linen_items (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,                 -- e.g. 'Duvet Cover'
  category      text not null default 'Other', -- e.g. Duvets, Pillow Covers, Towels, Serviettes, Gowns
  size          text,                           -- e.g. 'Queen', 'Bath', blank if not sized
  price         numeric not null default 0,
  supplier_id   uuid references hr_suppliers(id) on delete set null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Current stock on hand per item per lodge.
create table if not exists hr_linen_stock (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references hr_linen_items(id) on delete cascade,
  location_id   text not null check (location_id in ('ZC', 'EC', 'SC')),
  qty_on_hand   numeric not null default 0,
  min_units     numeric not null default 0,
  max_units     numeric not null default 0,
  updated_at    timestamptz not null default now(),
  unique (item_id, location_id)
);

-- Log of stock movements — received (+), lost/damaged (-), other adjustments.
create table if not exists hr_linen_movements (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references hr_linen_items(id) on delete cascade,
  location_id   text not null check (location_id in ('ZC', 'EC', 'SC')),
  date          date not null default current_date,
  qty_change    numeric not null,              -- positive = received, negative = lost/damaged
  reason        text not null default 'Received', -- 'Received', 'Lost', 'Damaged', 'Other'
  note          text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_hr_linen_movements_lookup on hr_linen_movements(location_id, item_id);

-- ---------------------------------------------------------------------------
-- hr_contracts — full history per employee (HR Admin only in the app).
-- "Current" contract is derived as the one with the latest start_date for
-- that employee, not a stored status flag — one less thing to keep in sync.
-- ---------------------------------------------------------------------------
create table if not exists hr_contracts (
  id                    uuid primary key default gen_random_uuid(),
  employee_id           uuid not null references hr_employees(id) on delete cascade,
  contract_type         text not null default 'Permanent' check (contract_type in ('Permanent', 'Fixed-term', 'Probation')),
  start_date            date not null,
  end_date              date,                    -- null for permanent / ongoing
  salary                numeric,
  medical_aid           boolean not null default false,
  medical_aid_scheme    text,
  pension_fund          boolean not null default false,
  pension_fund_name     text,
  notes                 text,
  created_at            timestamptz not null default now()
);

create index if not exists idx_hr_contracts_employee on hr_contracts(employee_id);
create index if not exists idx_hr_contracts_end_date on hr_contracts(end_date);

-- ---------------------------------------------------------------------------
-- Work schedule — hr_schedule_locations records which lodge an employee is
-- assigned to for a given calendar week (Monday date), so lodge can change
-- week to week within the same working block, not just once per rotation.
-- hr_leave holds logged leave periods; days_used is a snapshot taken when
-- the leave is entered (only days that fell on a scheduled working day
-- count), so a later change to someone's cycle anchor can't silently
-- rewrite past balances.
-- ---------------------------------------------------------------------------
create table if not exists hr_schedule_locations (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references hr_employees(id) on delete cascade,
  week_start_date   date not null,
  location_id       text not null check (location_id in ('ZC', 'EC', 'SC')),
  created_at        timestamptz not null default now(),
  unique (employee_id, week_start_date)
);

create index if not exists idx_hr_schedule_locations_employee on hr_schedule_locations(employee_id);

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
-- Row Level Security — open allow_all policies via the anon key, same
-- approach as the other three apps. hr_access is read-only from the
-- client. Same caveat as always: this is a client-side role gate, not
-- database-enforced — anyone with the anon key could technically write to
-- any table, including contracts. Worth knowing given the sensitivity of
-- the data in this app specifically; ask if you want this tightened with
-- real per-user Supabase Auth instead.
-- ---------------------------------------------------------------------------
alter table hr_access            enable row level security;
alter table hr_employees         enable row level security;
alter table hr_suppliers         enable row level security;
alter table hr_uniform_items     enable row level security;
alter table hr_uniform_stock     enable row level security;
alter table hr_uniform_issues    enable row level security;
alter table hr_linen_items       enable row level security;
alter table hr_linen_stock       enable row level security;
alter table hr_linen_movements   enable row level security;
alter table hr_contracts         enable row level security;
alter table hr_schedule_locations enable row level security;
alter table hr_leave             enable row level security;

-- drop-then-create so this script is safe to run more than once (Postgres
-- has no "create policy if not exists").
drop policy if exists allow_read_hr_access on hr_access;
create policy allow_read_hr_access on hr_access
  for select using (true);
drop policy if exists allow_all_hr_employees on hr_employees;
create policy allow_all_hr_employees on hr_employees
  for all using (true) with check (true);
drop policy if exists allow_all_hr_suppliers on hr_suppliers;
create policy allow_all_hr_suppliers on hr_suppliers
  for all using (true) with check (true);
drop policy if exists allow_all_hr_uniform_items on hr_uniform_items;
create policy allow_all_hr_uniform_items on hr_uniform_items
  for all using (true) with check (true);
drop policy if exists allow_all_hr_uniform_stock on hr_uniform_stock;
create policy allow_all_hr_uniform_stock on hr_uniform_stock
  for all using (true) with check (true);
drop policy if exists allow_all_hr_uniform_issues on hr_uniform_issues;
create policy allow_all_hr_uniform_issues on hr_uniform_issues
  for all using (true) with check (true);
drop policy if exists allow_all_hr_linen_items on hr_linen_items;
create policy allow_all_hr_linen_items on hr_linen_items
  for all using (true) with check (true);
drop policy if exists allow_all_hr_linen_stock on hr_linen_stock;
create policy allow_all_hr_linen_stock on hr_linen_stock
  for all using (true) with check (true);
drop policy if exists allow_all_hr_linen_movements on hr_linen_movements;
create policy allow_all_hr_linen_movements on hr_linen_movements
  for all using (true) with check (true);
drop policy if exists allow_all_hr_contracts on hr_contracts;
create policy allow_all_hr_contracts on hr_contracts
  for all using (true) with check (true);
drop policy if exists allow_all_hr_schedule_locations on hr_schedule_locations;
create policy allow_all_hr_schedule_locations on hr_schedule_locations
  for all using (true) with check (true);
drop policy if exists allow_all_hr_leave on hr_leave;
create policy allow_all_hr_leave on hr_leave
  for all using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Baseline table grants — Postgres requires these separately from RLS
-- policies for anon/authenticated to touch these tables at all.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select on public.hr_access to anon, authenticated;
grant select, insert, update, delete on public.hr_employees          to anon, authenticated;
grant select, insert, update, delete on public.hr_suppliers          to anon, authenticated;
grant select, insert, update, delete on public.hr_uniform_items      to anon, authenticated;
grant select, insert, update, delete on public.hr_uniform_stock      to anon, authenticated;
grant select, insert, update, delete on public.hr_uniform_issues     to anon, authenticated;
grant select, insert, update, delete on public.hr_linen_items        to anon, authenticated;
grant select, insert, update, delete on public.hr_linen_stock        to anon, authenticated;
grant select, insert, update, delete on public.hr_linen_movements    to anon, authenticated;
grant select, insert, update, delete on public.hr_contracts          to anon, authenticated;
grant select, insert, update, delete on public.hr_schedule_locations to anon, authenticated;
grant select, insert, update, delete on public.hr_leave              to anon, authenticated;

-- Default passwords — CHANGE THESE immediately via the Table Editor
-- (hr_access table) after setup. Three separate passwords this time.
insert into hr_access (role, password) values
  ('staff', 'ChangeMe-Staff1'),
  ('admin', 'ChangeMe-Admin1'),
  ('hradmin', 'ChangeMe-HRAdmin1')
on conflict (role) do nothing;
