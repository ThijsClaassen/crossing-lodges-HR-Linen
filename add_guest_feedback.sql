-- add_guest_feedback.sql — guest feedback per lodge per week, by department
-- (#487, 2026-09-27).
--
-- Thijs: "API with GuestRevu for example. Read the complaints/numbers. Check
-- the groups, food to chefs, clean to HK, activities to Rangers, then link
-- that to the employees that were working that week at that lodge. Make a
-- downloadable file of that for appraisals."
--
-- INVESTIGATED FIRST (2026-09-27): GuestRevu publishes no outbound API for
-- customers — its integrations are inbound (the PMS pushes guests in) and
-- its data comes OUT through the Reviews tab export (.csv / .xlsx for a
-- date range, all survey responses and online reviews). The API-tracker
-- profile for GuestRevu lists no docs, no auth, no endpoints. Whether the
-- Crossing Lodges plan can get a private API key is a question for
-- GuestRevu support, not something to build against.
--
-- So the feed is the EXPORT: drop the CSV on the Guest Feedback tab, map
-- the columns once (the mapping is remembered here), and every later export
-- imports in one step. If an API turns up later it lands in the same table.
--
-- THE FRAMING, agreed in the task: a week's cleanliness score is a
-- DEPARTMENT trend at a lodge, with a note of who was rostered — never a
-- score against a person. The appraisal pack shows the department line;
-- it does not print a guest's score next to a name.

create table if not exists guest_feedback (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  source        text not null default 'guestrevu_export',
  external_id   text,                        -- the export's own row id, when it has one
  location_id   text,                        -- lodge code, as in locations.id
  stay_date     date not null,               -- check-out date (or review date)
  overall       numeric,                     -- 0–10 scale as exported
  scores        jsonb not null default '{}', -- { "food": 8, "housekeeping": 6, ... } keyed by category
  comment       text,
  reviewer      text,                        -- guest name or source site ("Google")
  raw           jsonb,                       -- the whole row, so nothing is lost
  imported_at   timestamptz not null default now()
);
-- Plain (not partial) unique index: PostgREST's on_conflict cannot name a
-- partial index, and NULL external_ids never collide in a unique index anyway.
create unique index if not exists guest_feedback_external_idx on guest_feedback (company_id, external_id);
create index if not exists guest_feedback_stay_idx on guest_feedback (company_id, location_id, stay_date);

alter table guest_feedback enable row level security;
drop policy if exists "read guest_feedback" on guest_feedback;
create policy "read guest_feedback" on guest_feedback for select using (has_company_access(company_id));
drop policy if exists "admin write guest_feedback" on guest_feedback;
create policy "admin write guest_feedback" on guest_feedback for all
  using (has_company_access(company_id) and (has_company_role(company_id, 'admin') or is_hr_admin(company_id) or is_platform_admin()))
  with check (has_company_access(company_id) and (has_company_role(company_id, 'admin') or is_hr_admin(company_id) or is_platform_admin()));
grant select, insert, update, delete on guest_feedback to authenticated;

-- One row per company: how the export's columns map to our fields, and
-- which category feeds which HR department.
create table if not exists guest_feedback_settings (
  company_id           uuid primary key references companies(id) on delete cascade,
  column_map           jsonb not null default '{}',   -- { "stay_date": "Check-out", "location": "Property", "overall": "Overall", "comment": "Comments", "id": "Response ID", "categories": { "food": "Food & Beverage", "housekeeping": "Cleanliness" } }
  category_departments jsonb not null default '{}',   -- { "food": "Kitchen", "housekeeping": "Housekeeping", "activities": "Guiding" }
  location_aliases     jsonb not null default '{}',   -- { "Zebras Crossing": "ZC" }
  updated_at           timestamptz not null default now()
);
alter table guest_feedback_settings enable row level security;
drop policy if exists "read guest_feedback_settings" on guest_feedback_settings;
create policy "read guest_feedback_settings" on guest_feedback_settings for select using (has_company_access(company_id));
drop policy if exists "admin write guest_feedback_settings" on guest_feedback_settings;
create policy "admin write guest_feedback_settings" on guest_feedback_settings for all
  using (has_company_access(company_id) and (has_company_role(company_id, 'admin') or is_hr_admin(company_id) or is_platform_admin()))
  with check (has_company_access(company_id) and (has_company_role(company_id, 'admin') or is_hr_admin(company_id) or is_platform_admin()));
grant select, insert, update, delete on guest_feedback_settings to authenticated;

-- ===========================================================================
-- THE MIGRATION ENDS HERE.
-- ===========================================================================
select 'guest_feedback' as what, count(*) from guest_feedback
union all select 'guest_feedback_settings', count(*) from guest_feedback_settings;
