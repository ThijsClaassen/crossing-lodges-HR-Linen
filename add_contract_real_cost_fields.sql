-- Run once in the Supabase SQL editor.
--
-- Adds the fixed monthly costs needed for the new "Staff Cost" overview
-- (2026-08-10) — Thijs wants to see real cost per employee, not just
-- salary: healthcare, pension, and housing are now captured per contract
-- as plain monthly rand amounts (same convention as salary). Food and
-- Beverage cost-per-staff are NOT stored here — they're computed live from
-- the Food Stock/Beverage Stock apps' own issue data + hr_schedule_locations'
-- weekly headcount, in staffCostEngine.js, so they can never drift out of
-- sync with what those apps actually show.
--
-- Safe to re-run: every alter uses "if not exists".

alter table hr_contracts add column if not exists medical_aid_monthly_cost numeric;
alter table hr_contracts add column if not exists pension_fund_monthly_cost numeric;
alter table hr_contracts add column if not exists housing_monthly_cost numeric;

-- =========================================================================
-- VERIFICATION
-- =========================================================================

select column_name, data_type
from information_schema.columns
where table_name = 'hr_contracts'
order by ordinal_position;
