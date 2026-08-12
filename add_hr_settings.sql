-- HR/Linen: configurable Schedule week-start day (2026-08-12).
--
-- Why: the Schedule tab's "Headcount by position" view buckets days into
-- calendar weeks (Mon-Sun) purely for display. Thijs's actual rotation
-- blocks don't align to that — staff go off Friday and return the
-- following Thursday, so a Mon-Sun bucket almost always contains at least
-- one working day for every employee, making headcount-by-week look like
-- everyone is available every week. This table stores one company-wide
-- "which day does a display week start on" setting so the grid can be
-- realigned to match the real rotation boundary (e.g. Friday).
--
-- Run once against the shared Supabase project (same one all 6 apps use).

create table if not exists hr_settings (
  company_id uuid primary key references companies(id) on delete cascade,
  -- 0 = Sunday .. 6 = Saturday, same convention as JS Date.getDay().
  -- Default 1 (Monday) matches the app's old hardcoded behaviour.
  week_start_day smallint not null default 1 check (week_start_day between 0 and 6),
  updated_at timestamptz not null default now()
);

alter table hr_settings enable row level security;

-- Anyone with access to the company can read the setting (needed just to
-- render the schedule grid correctly, not an admin-only view).
drop policy if exists allow_company_read_hr_settings on hr_settings;
create policy allow_company_read_hr_settings on hr_settings
  for select using (has_company_access(company_id));

-- Only admins (or platform admins) can change it — same pattern as every
-- other admin-only write policy in this project (see
-- feedback_admin_write_rls_needs_platform_admin memory: must OR in
-- is_platform_admin(), not just the company role check).
drop policy if exists allow_admin_write_hr_settings on hr_settings;
create policy allow_admin_write_hr_settings on hr_settings
  for all using (
    has_company_role(company_id, 'admin') or is_platform_admin()
  ) with check (
    has_company_role(company_id, 'admin') or is_platform_admin()
  );
