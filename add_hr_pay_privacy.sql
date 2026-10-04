-- Pay figures: Owners only, also inside the HR app (2026-10-04, task #544,
-- roles step 4 of 5).
--
-- Run once in the Supabase SQL editor, AFTER add_user_roles.sql (step 1).
-- Safe to run again. No new tables.
--
-- THE DECISIONS (Thijs)
--   2026-09-30  pay per person is for Owners only, for now.
--   2026-09-30  HR manager keeps Contracts, Leave, Loans and Appraisals, but
--               sees no pay figures.
--   2026-10-04  the HR manager may still ENTER salaries on new contracts.
--
-- So the HR manager can write a salary but cannot read one back. Whole-table
-- rules (RLS) cannot express that: they decide which ROWS someone sees, not
-- which COLUMNS. This uses Postgres column privileges instead:
--
--   hr_contracts  salary, medical_aid_monthly_cost, pension_fund_monthly_cost,
--                 housing_monthly_cost   -> nobody can SELECT them through the
--                                           API any more; INSERT and UPDATE
--                                           still work for everyone the row
--                                           rules already allow (HR admins).
--   hr_bonuses    amount                 -> the same.
--
-- Owners read the figures through get_hr_pay() below, which checks
-- can_see_pay() (Owner) on the server. Everything else that needs contract
-- money — the Finance Dashboard reports, Maintenance hourly rates — already
-- goes through SECURITY DEFINER functions, which are not affected by this.
--
-- And is_hr_admin() now counts Owners, so an Owner sees the HR app's
-- confidential tabs without needing a separate hr_admins row.
--
-- WHAT THE APP MUST DO (the HR app release that goes with this file):
--   - never `select *` on these two tables (it would now be refused);
--   - insert / update with return=minimal and read the row back by id with
--     the allowed columns.
--   Push the HR app first or at the same time: the old app does select * and
--   would show "permission denied" on load until the new one is live.

-- 1. Owners count as HR admins ------------------------------------------------
create or replace function is_hr_admin(target_company_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    is_platform_admin()
    or exists (
      select 1 from hr_admins
      where user_id = auth.uid() and company_id = target_company_id
    )
    or exists (
      select 1 from user_companies uc
      where uc.user_id = auth.uid() and uc.company_id = target_company_id and uc.profile = 'owner'
    );
$$;

-- 2. Contract pay columns: write yes, read no -----------------------------------
revoke select on hr_contracts from anon, authenticated;
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'hr_contracts'
     and column_name not in ('salary', 'medical_aid_monthly_cost', 'pension_fund_monthly_cost', 'housing_monthly_cost');
  execute format('grant select (%s) on hr_contracts to authenticated', cols);
end $$;
grant insert, update, delete on hr_contracts to authenticated;

-- 3. Bonus amounts: write yes, read no -------------------------------------------
-- Only if bonuses were ever set up (add_hr_bonuses.sql).
do $$
declare cols text;
begin
  if to_regclass('public.hr_bonuses') is null then
    return;
  end if;
  execute 'revoke select on hr_bonuses from anon, authenticated';
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'hr_bonuses'
     and column_name <> 'amount';
  execute format('grant select (%s) on hr_bonuses to authenticated', cols);
  execute 'grant insert, update, delete on hr_bonuses to authenticated';
end $$;

-- 4. Owners read the figures here ----------------------------------------------------
-- One call returns every contract's pay and every bonus amount for the
-- company, keyed by row id; the app lays them over the rows it already has.
-- Anyone else gets null — the same as having no figures.
create or replace function get_hr_pay(p_company_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_contracts jsonb;
  v_bonuses jsonb := '[]'::jsonb;
begin
  if not can_see_pay(p_company_id) then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id,
           'salary', c.salary,
           'medical_aid_monthly_cost', c.medical_aid_monthly_cost,
           'pension_fund_monthly_cost', c.pension_fund_monthly_cost,
           'housing_monthly_cost', c.housing_monthly_cost)), '[]'::jsonb)
    into v_contracts
    from hr_contracts c
   where c.company_id = p_company_id;

  if to_regclass('public.hr_bonuses') is not null then
    execute 'select coalesce(jsonb_agg(jsonb_build_object(''id'', b.id, ''amount'', b.amount)), ''[]''::jsonb)
               from hr_bonuses b where b.company_id = $1'
      into v_bonuses
      using p_company_id;
  end if;

  return jsonb_build_object('contracts', v_contracts, 'bonuses', v_bonuses);
end $$;

revoke all on function get_hr_pay(uuid) from public;
grant execute on function get_hr_pay(uuid) to authenticated;

-- 5. Renewals by the HR manager keep the pay ------------------------------------------
-- A renewal is a new contract row prefilled from the current one. The HR
-- manager cannot see the current pay, so their pay boxes start blank; any
-- they leave blank are copied from the previous contract here, on the
-- server, without the figures ever reaching their screen. Only fills blanks
-- (what they did type wins), only between two contracts of the same person
-- in the same company, and only for an HR admin of that company.
create or replace function carry_contract_pay(p_new_id uuid, p_from_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update hr_contracts n
     set salary                    = coalesce(n.salary, o.salary),
         medical_aid_monthly_cost  = coalesce(n.medical_aid_monthly_cost, o.medical_aid_monthly_cost),
         pension_fund_monthly_cost = coalesce(n.pension_fund_monthly_cost, o.pension_fund_monthly_cost),
         housing_monthly_cost      = coalesce(n.housing_monthly_cost, o.housing_monthly_cost)
    from hr_contracts o
   where n.id = p_new_id
     and o.id = p_from_id
     and o.id <> n.id
     and o.employee_id = n.employee_id
     and o.company_id = n.company_id
     and is_hr_admin(n.company_id);
end $$;

revoke all on function carry_contract_pay(uuid, uuid) from public;
grant execute on function carry_contract_pay(uuid, uuid) to authenticated;

-- THE MIGRATION ENDS HERE. Everything below is commented out on purpose.
--
-- CHECK (run as yourself in the SQL editor — you are the owner, so these use
-- the postgres role and see everything; the real test is the smoke test in
-- the handoff, signed in as the HR manager):
--
--   -- the pay columns no longer have a SELECT grant for authenticated:
--   select column_name, privilege_type
--     from information_schema.column_privileges
--    where table_name in ('hr_contracts', 'hr_bonuses') and grantee = 'authenticated'
--    order by table_name, column_name, privilege_type;
--   -- expect salary / *_monthly_cost / amount with INSERT and UPDATE only.
--
-- UNDO (puts the old whole-table read back):
--   grant select on hr_contracts to authenticated;
--   grant select on hr_bonuses to authenticated;
