-- Run once in the Supabase SQL editor.
--
-- HR/LINEN — username-based login pilot (2026-08-09).
--
-- Context: Thijs wants staff without a real email address to be able to log
-- in with a username + password that an HR Admin assigns, instead of every
-- account needing an email. Supabase Auth itself always requires *some*
-- email on the account, so username-only accounts get a synthetic,
-- never-emailed placeholder address instead
-- (e.g. jsmith@users.crossinglodges.internal — .internal is a reserved TLD
-- that will never resolve or receive real mail). Email-based accounts keep
-- working exactly as they do today; this is additive.
--
-- Same Supabase project as the other 5 apps, so this table/these functions
-- are usable by all of them later, not just HR/Linen — this file only
-- covers the pilot in HR/Linen. is_hr_admin(), has_company_access(), and
-- the companies/user_companies/hr_admins tables already exist from earlier
-- phases.
--
-- Safe to re-run: every statement uses "if not exists" / "or replace".

-- 1. user_usernames — one username per auth user, globally unique ----------
-- Globally unique (not per-company) because login has to resolve a
-- username to an account BEFORE it knows which company that account
-- belongs to — same reason emails are globally unique in auth.users.

create table if not exists user_usernames (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique check (username ~ '^[a-z0-9._-]{3,32}$'),
  created_at  timestamptz not null default now()
);

alter table user_usernames enable row level security;
drop policy if exists "read own username" on user_usernames;
create policy "read own username" on user_usernames
  for select using (user_id = auth.uid() or is_platform_admin());
-- No client-side insert/update/delete policy — usernames are only ever
-- created by the admin-create-user Edge Function, which uses the
-- service-role key and so bypasses RLS entirely (same reasoning as
-- hr_admins/user_companies not having client-writable policies).

grant select on public.user_usernames to authenticated;

-- 2. resolve_username_email() — lets the login screen turn a username into
--    the email Supabase Auth actually needs, before the user is signed in.
--    SECURITY DEFINER so it can read auth.users; only ever returns an
--    email string (or nothing), never anything else about the account.

create or replace function resolve_username_email(p_username text)
returns text
language sql
security definer
stable
set search_path = public, auth
as $$
  select au.email
  from user_usernames uu
  join auth.users au on au.id = uu.user_id
  where uu.username = lower(trim(p_username))
  limit 1;
$$;

grant execute on function resolve_username_email(text) to anon, authenticated;

-- 3. list_company_users() — powers the "Users in this company" table in the
--    new Manage Users screen. SECURITY DEFINER so it can read auth.users
--    and every company's user_companies rows, but it checks the CALLER is
--    an HR Admin for the requested company before returning anything —
--    same authorization rule as is_hr_admin() everywhere else.

create or replace function list_company_users(p_company_id uuid)
returns table (
  user_id      uuid,
  username     text,
  email        text,
  role         text,
  is_hr_admin  boolean
)
language plpgsql
security definer
stable
set search_path = public, auth
as $$
begin
  if not is_hr_admin(p_company_id) then
    raise exception 'Not authorized for this company.';
  end if;

  return query
    select
      uc.user_id,
      uu.username,
      au.email,
      uc.role,
      exists (
        select 1 from hr_admins ha
        where ha.user_id = uc.user_id and ha.company_id = p_company_id
      ) as is_hr_admin
    from user_companies uc
    join auth.users au on au.id = uc.user_id
    left join user_usernames uu on uu.user_id = uc.user_id
    where uc.company_id = p_company_id
    order by coalesce(uu.username, au.email);
end;
$$;

grant execute on function list_company_users(uuid) to authenticated;

-- 4. admin_reset_password() — lets an HR Admin set a new password for
--    someone in their company without needing an Edge Function. This is
--    the well-known Supabase pattern: auth.users.encrypted_password is a
--    bcrypt hash produced by pgcrypto's crypt()/gen_salt('bf'), the exact
--    same algorithm Supabase Auth itself uses, so writing it this way
--    produces a password that works immediately. Checks the caller is an
--    HR Admin for p_company_id AND that the target user actually belongs
--    to that company, before touching anything.

create or replace function admin_reset_password(p_user_id uuid, p_new_password text, p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
begin
  if not is_hr_admin(p_company_id) then
    raise exception 'Not authorized for this company.';
  end if;
  if length(p_new_password) < 8 then
    raise exception 'Password must be at least 8 characters.';
  end if;
  if not exists (
    select 1 from user_companies where user_id = p_user_id and company_id = p_company_id
  ) then
    raise exception 'That user is not part of this company.';
  end if;

  update auth.users
  set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
      updated_at = now()
  where id = p_user_id;
end;
$$;

grant execute on function admin_reset_password(uuid, text, uuid) to authenticated;

-- =========================================================================
-- VERIFICATION
-- =========================================================================
-- 1. Confirm the objects exist:
--      select * from user_usernames;  -- should be empty, no error
--      select resolve_username_email('nobody');  -- should return null, no error
--
-- 2. After deploying the admin-create-user Edge Function (separate
--    hand-off) and creating a test username through the new "Add a user"
--    form in the app:
--      select * from user_usernames;  -- the new row should show up
--      select * from list_company_users((select id from companies where slug = 'crossing-lodges'));
--        -- should list every user in Crossing Lodges, including the new one
--
-- 3. Log out, then log back in using ONLY the username (not the email) —
--    confirm it signs in.
--
-- 4. From the Manage Users table, click "Reset password" on the test user,
--    save a new password, then confirm logging in with the OLD password
--    fails and the NEW one works.
