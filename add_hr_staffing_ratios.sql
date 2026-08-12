-- HR/Linen: staffing ratio tiers + guest-driven understaffing flags
-- (2026-08-12).
--
-- Why: Thijs wants the Schedule tab to flag weeks/days where headcount of a
-- given position (e.g. Ranger) falls short of what the number of guests
-- in-house that day calls for (e.g. 1 ranger for 1-9 guests, 2 for 10-20).
-- Guest counts are read live from revenue_bookings, which already lives in
-- this same shared Supabase project (populated by the Finance Dashboard's
-- Revenue Importer) — same cross-app-read pattern staffCostEngine.js
-- already uses for Food/Beverage tables.
--
-- Run once against the shared Supabase project (same one all 6 apps use).

create table if not exists hr_staffing_ratios (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  -- Free text, matching hr_employees.position exactly (that field isn't an
  -- enum either) — the Schedule tab's ratio settings UI lets you pick from
  -- positions that already exist on your employees, so this can't drift.
  position text not null,
  min_guests int not null check (min_guests >= 0),
  -- null = open-ended (this tier covers min_guests and above, until a
  -- higher tier's min_guests takes over).
  max_guests int check (max_guests is null or max_guests >= min_guests),
  required_count int not null check (required_count >= 0),
  created_at timestamptz not null default now()
);

create index if not exists hr_staffing_ratios_company_position_idx
  on hr_staffing_ratios (company_id, position);

alter table hr_staffing_ratios enable row level security;

drop policy if exists allow_company_read_hr_staffing_ratios on hr_staffing_ratios;
create policy allow_company_read_hr_staffing_ratios on hr_staffing_ratios
  for select using (has_company_access(company_id));

-- Admin-only write, same pattern as every other admin-only write policy in
-- this project (see feedback_admin_write_rls_needs_platform_admin memory:
-- must OR in is_platform_admin(), not just the company role check).
drop policy if exists allow_admin_write_hr_staffing_ratios on hr_staffing_ratios;
create policy allow_admin_write_hr_staffing_ratios on hr_staffing_ratios
  for all using (
    has_company_role(company_id, 'admin') or is_platform_admin()
  ) with check (
    has_company_role(company_id, 'admin') or is_platform_admin()
  );
