// Supabase Edge Function: admin-create-user
//
// Deploy via Supabase Dashboard > Edge Functions > Create a new function,
// name it exactly "admin-create-user", paste this file's contents in,
// and Deploy. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided
// automatically by Supabase for every Edge Function — nothing to configure.
//
// Why this needs to exist at all: creating a Supabase Auth user requires
// the Admin API (auth.admin.createUser), which requires the service-role
// key. That key can never be shipped to the browser, so this function runs
// server-side instead. The app (ManageUsers.jsx) calls this over HTTPS with
// the signed-in HR Admin's own access token; this function re-checks that
// token is actually an HR Admin for the target company (via the existing
// is_hr_admin() Postgres function, through a client scoped to the caller's
// own token, so RLS applies normally) before doing anything privileged with
// the service-role client. If either creation step after the auth user
// exists fails (username taken, company insert fails), the auth user it
// just created is deleted again so it doesn't become an orphaned account.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const USERNAME_DOMAIN = 'users.crossinglodges.internal'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { username, password, companyId, role, isHrAdmin, realEmail } = await req.json()

    if (!username || !password || !companyId || !role) {
      return json({ error: 'username, password, companyId, and role are required.' }, 400)
    }
    if (String(password).length < 8) {
      return json({ error: 'Password must be at least 8 characters.' }, 400)
    }
    if (!['staff', 'admin'].includes(role)) {
      return json({ error: 'role must be "staff" or "admin".' }, 400)
    }

    const normalizedUsername = String(username).trim().toLowerCase()
    if (!/^[a-z0-9._-]{3,32}$/.test(normalizedUsername)) {
      return json(
        { error: 'Username must be 3-32 characters: lowercase letters, numbers, dot, underscore, hyphen.' },
        400
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Scoped to the caller's own token — RLS/is_hr_admin() applies exactly
    // as it would for any normal client request from the app.
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const {
      data: { user: caller },
      error: callerErr,
    } = await callerClient.auth.getUser()
    if (callerErr || !caller) return json({ error: 'Not authenticated.' }, 401)

    const { data: callerIsHrAdmin, error: checkErr } = await callerClient.rpc('is_hr_admin', {
      target_company_id: companyId,
    })
    if (checkErr) return json({ error: checkErr.message }, 500)
    if (!callerIsHrAdmin) return json({ error: 'Not authorized for this company.' }, 403)

    const email = (realEmail && String(realEmail).trim()) || `${normalizedUsername}@${USERNAME_DOMAIN}`

    // Service-role client — only used from here down, only for the
    // privileged writes an HR Admin was just confirmed authorized to make.
    const adminClient = createClient(supabaseUrl, serviceKey)

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (createErr) return json({ error: createErr.message }, 400)

    const newUserId = created.user.id

    const { error: usernameErr } = await adminClient
      .from('user_usernames')
      .insert({ user_id: newUserId, username: normalizedUsername })
    if (usernameErr) {
      await adminClient.auth.admin.deleteUser(newUserId)
      return json({ error: `Username taken or invalid: ${usernameErr.message}` }, 400)
    }

    const { error: membershipErr } = await adminClient
      .from('user_companies')
      .insert({ user_id: newUserId, company_id: companyId, role })
    if (membershipErr) {
      await adminClient.auth.admin.deleteUser(newUserId)
      return json({ error: membershipErr.message }, 400)
    }

    if (isHrAdmin) {
      const { error: hrErr } = await adminClient
        .from('hr_admins')
        .insert({ user_id: newUserId, company_id: companyId })
      if (hrErr) return json({ error: hrErr.message }, 400)
    }

    return json({ userId: newUserId, username: normalizedUsername, email })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Unexpected error.' }, 500)
  }
})
