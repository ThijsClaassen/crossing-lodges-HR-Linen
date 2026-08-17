-- HR/Linen: staff loans (2026-08-17)
--
-- Reference-only log — amount, date, agreed monthly deduction, notes. No
-- payroll integration, no automated balance tracking (the app estimates a
-- rough remaining balance for display only; Thijs's own records are
-- authoritative). Same visibility/protection as hr_contracts: HR Admin only,
-- enforced at the RLS level (not just the app's role==='hradmin' gate),
-- since a loan amount is exactly the kind of sensitive pay-related data
-- Contracts already gets extra protection for.

create table if not exists hr_staff_loans (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id),
  employee_id         uuid not null references hr_employees(id) on delete cascade,
  loan_date           date not null,
  amount              numeric not null default 0,
  monthly_deduction   numeric not null default 0,
  notes               text,
  created_at          timestamptz not null default now()
);

create index if not exists idx_hr_staff_loans_company on hr_staff_loans(company_id);
create index if not exists idx_hr_staff_loans_employee on hr_staff_loans(employee_id);

alter table hr_staff_loans enable row level security;

drop policy if exists "allow_all_hr_staff_loans" on hr_staff_loans;
create policy "allow_all_hr_staff_loans" on hr_staff_loans
  for all
  using (has_company_access(company_id) and is_hr_admin(company_id))
  with check (has_company_access(company_id) and is_hr_admin(company_id));

grant select, insert, update, delete on public.hr_staff_loans to authenticated;

-- Verification — should show exactly one allow_all_hr_staff_loans policy.
select tablename, policyname, cmd
from pg_policies
where tablename = 'hr_staff_loans';

-- ============================================================================
-- REMINDER: this project has "Automatically expose new tables" turned OFF
-- for the Data API. After running this, go to Supabase Dashboard ->
-- Integrations -> Data API -> Settings -> Exposed tables and manually
-- toggle ON: hr_staff_loans — otherwise every request to it 404s despite
-- correct grants + RLS.
-- ============================================================================
