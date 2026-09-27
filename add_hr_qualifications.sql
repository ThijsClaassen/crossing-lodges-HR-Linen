-- add_hr_qualifications.sql — staff licences and qualifications, with the
-- document and its expiry date (#484, 2026-09-27).
--
-- Thijs: "Upload the licenses, also when they expire. Link that to fixed
-- asset register, when write off."
--
-- One row per document a person holds: driver's licence (with its class),
-- PDP, first aid, FGASA, whatever else. Issue and expiry dates so the app can
-- say "expired 8 days ago" the way it already does for contracts and vehicle
-- licences (#423). The scanned document goes in a private storage bucket.
--
-- This is the backbone for three other things:
--   * the vehicle register's "licence class required" + driver gate (#485),
--     which is why the Ops app reads this table too;
--   * the insurance claim pack's driver section (#483);
--   * the appraisal pack (#486).
--
-- WHO SEES WHAT. The ROW (kind, class, dates) is readable by anyone in the
-- company: the Ops vehicle log needs to know whether Piet may drive the
-- Cruiser, and "Code EC, expires March" is not a secret. Writing is admin /
-- HR-admin. The DOCUMENT itself (the scan of the licence, with ID number and
-- photo) is HR-admin and company-admin only — the bucket policy below, not
-- the table, is what guards it.
--
-- Safe to re-run. NEW TABLE — expose it under Data API → Exposed tables if
-- that is not automatic on this project (it has been for every other table
-- so far).

create table if not exists hr_qualifications (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  employee_id  uuid not null references hr_employees(id) on delete cascade,
  -- What sort of document. Free text beyond the well-known ones so a new
  -- kind never needs a migration; the app offers a picklist with these.
  kind         text not null,               -- drivers_licence | pdp | first_aid | fgasa | other
  -- For a driver's licence this is the class (B, C1, C, EC, EB, A ...); for
  -- FGASA the level; blank for things that have no class.
  category     text,
  title        text,                        -- "Code EC driver's licence", "Level 1 first aid"
  doc_number   text,
  issued_on    date,
  expires_on   date,                        -- null = does not expire
  storage_path text,                        -- object in the hr-documents bucket, may be null
  note         text,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  constraint hr_qualifications_dates check (issued_on is null or expires_on is null or expires_on >= issued_on)
);
create index if not exists hr_qualifications_employee_idx on hr_qualifications (company_id, employee_id);
create index if not exists hr_qualifications_expiry_idx on hr_qualifications (company_id, expires_on) where expires_on is not null;

alter table hr_qualifications enable row level security;

drop policy if exists "read hr_qualifications" on hr_qualifications;
create policy "read hr_qualifications" on hr_qualifications
  for select using (has_company_access(company_id));

drop policy if exists "admin write hr_qualifications" on hr_qualifications;
create policy "admin write hr_qualifications" on hr_qualifications
  for all
  using (has_company_access(company_id) and (has_company_role(company_id, 'admin') or is_hr_admin(company_id) or is_platform_admin()))
  with check (has_company_access(company_id) and (has_company_role(company_id, 'admin') or is_hr_admin(company_id) or is_platform_admin()));

grant select, insert, update, delete on hr_qualifications to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: the documents themselves. Path: {company_id}/hr/{uuid}.{ext}
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hr-documents', 'hr-documents', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

drop policy if exists "hr admins read hr documents" on storage.objects;
create policy "hr admins read hr documents" on storage.objects
  for select using (
    bucket_id = 'hr-documents'
    and (is_platform_admin()
         or has_company_role((storage.foldername(name))[1]::uuid, 'admin')
         or is_hr_admin((storage.foldername(name))[1]::uuid))
  );

drop policy if exists "hr admins upload hr documents" on storage.objects;
create policy "hr admins upload hr documents" on storage.objects
  for insert with check (
    bucket_id = 'hr-documents'
    and (is_platform_admin()
         or has_company_role((storage.foldername(name))[1]::uuid, 'admin')
         or is_hr_admin((storage.foldername(name))[1]::uuid))
  );

drop policy if exists "hr admins delete hr documents" on storage.objects;
create policy "hr admins delete hr documents" on storage.objects
  for delete using (
    bucket_id = 'hr-documents'
    and (is_platform_admin()
         or has_company_role((storage.foldername(name))[1]::uuid, 'admin')
         or is_hr_admin((storage.foldername(name))[1]::uuid))
  );

-- ---------------------------------------------------------------------------
-- Who may drive what (#485). Given a company and a required licence class,
-- returns every active employee with a driver's licence row, and whether it
-- qualifies. The Ops vehicle log calls this so the rule lives in one place:
--   * class must cover the requirement (EC covers everything below it);
--   * the licence must not be expired ON THE DATE ASKED (default today) —
--     a log captured last month stays valid if the licence expired since;
--   * PDP, when the vehicle needs one, must be present and unexpired.
-- Employees WITHOUT any licence row are returned too (qualifies=false,
-- reason 'no licence on file') so the picker can grey them with a reason
-- rather than make them vanish.
-- ---------------------------------------------------------------------------
create or replace function licence_class_rank(p_class text)
returns int language sql immutable as $$
  select case upper(coalesce(p_class, ''))
    when 'A1' then 1 when 'A' then 2
    when 'B'  then 10 when 'EB' then 11
    when 'C1' then 20 when 'C'  then 21
    when 'EC1' then 30 when 'EC' then 31
    else 0 end;
$$;

create or replace function drivers_for_vehicle(p_company_id uuid, p_required_class text, p_needs_pdp boolean default false, p_on date default current_date)
returns table (employee_id uuid, employee_name text, licence_class text, licence_expires date, pdp_expires date, qualifies boolean, reason text)
language sql stable security definer set search_path = public as $$
  with lic as (
    select q.employee_id, q.category as licence_class, q.expires_on,
           row_number() over (partition by q.employee_id order by licence_class_rank(q.category) desc, q.expires_on desc nulls first) as rn
      from hr_qualifications q
     where q.company_id = p_company_id and q.kind = 'drivers_licence'
  ),
  pdp as (
    select q.employee_id, max(q.expires_on) as expires_on, bool_or(q.expires_on is null) as never_expires
      from hr_qualifications q
     where q.company_id = p_company_id and q.kind = 'pdp'
     group by q.employee_id
  )
  select e.id, e.first_name || ' ' || e.last_name,
         l.licence_class, l.expires_on, p.expires_on,
         case
           when l.employee_id is null then false
           when l.expires_on is not null and l.expires_on < p_on then false
           when licence_class_rank(l.licence_class) < licence_class_rank(p_required_class) then false
           when p_needs_pdp and p.employee_id is null then false
           when p_needs_pdp and not p.never_expires and p.expires_on < p_on then false
           else true
         end,
         case
           when l.employee_id is null then 'no licence on file'
           when l.expires_on is not null and l.expires_on < p_on then 'licence expired ' || to_char(l.expires_on, 'DD Mon YYYY')
           when licence_class_rank(l.licence_class) < licence_class_rank(p_required_class) then 'holds Code ' || coalesce(l.licence_class, '?') || ', needs ' || coalesce(p_required_class, '?')
           when p_needs_pdp and p.employee_id is null then 'no PDP on file'
           when p_needs_pdp and not p.never_expires and p.expires_on < p_on then 'PDP expired ' || to_char(p.expires_on, 'DD Mon YYYY')
           else null
         end
    from hr_employees e
    left join lic l on l.employee_id = e.id and l.rn = 1
    left join pdp p on p.employee_id = e.id
   where e.company_id = p_company_id and e.active
     and has_company_access(p_company_id)
   order by 6 desc, 2;
$$;
grant execute on function drivers_for_vehicle(uuid, text, boolean, date) to authenticated;

-- ===========================================================================
-- THE MIGRATION ENDS HERE.
-- ===========================================================================
select 'hr_qualifications' as what, count(*) as rows from hr_qualifications
union all
select 'hr-documents bucket', count(*) from storage.buckets where id = 'hr-documents'
union all
select 'drivers_for_vehicle()', count(*) from pg_proc where proname = 'drivers_for_vehicle';
