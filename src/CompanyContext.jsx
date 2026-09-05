// Resolves "which companies can this logged-in user access, and with what
// role" and exposes the currently-selected one app-wide. Same logic as the
// Finance Dashboard's / Food Stock's CompanyContext.jsx (2026-08-08) — this
// is the SAME Supabase project, so companies/user_companies/platform_admins
// already exist and mean the same thing here; copied over rather than
// shared as a package since each app is its own deploy.
//
// HR/Linen-specific addition: this app has a third permission tier
// (hradmin) that isn't part of the shared user_companies.role column — it's
// tracked in its own hr_admins allow-list table instead (see
// add_company_id_and_hr_admins.sql, 3a). So this context also queries
// hr_admins for the signed-in user and exposes isHrAdmin, resolved for
// whichever company is currently selected. App.jsx derives its existing
// 'staff' | 'admin' | 'hradmin' role string from base role + isHrAdmin, so
// none of the app's extensive role === 'hradmin' checks needed to change.
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { supabase } from './supabaseClient.js'
import { setLocations } from './sb.js'

// 2026-08-09: also filters by per-app access (user_app_access) — a company
// only shows up in the switcher here if this account is actually allowed
// into HR/Linen for it. Admins, HR Admins, and platform admins always
// pass. A plain staff account with NO user_app_access rows at all for a
// company is legacy/unrestricted (predates this feature) and also passes;
// one with rows only passes if 'hr_linen' is explicitly among them. Note
// this is a UI-level filter, not database-level enforcement — see
// has_app_access() in add_username_login_and_app_access.sql if that ever
// needs hardening further.
const CompanyContext = createContext(null)
const STORAGE_KEY = 'hr_company_id'
const APP_KEY = 'hr_linen'

export function CompanyProvider({ children }) {
  const [loading, setLoading] = useState(true)
  // Lodges come from the shared `locations` table now instead of a
  // hardcoded list (2026-08-26). They're loaded into sb.js's LOCATIONS array
  // below; this flag keeps `loading` true until that's done, so nothing ever
  // renders against an empty lodge list.
  const [locationsReady, setLocationsReady] = useState(false)
  const [error, setError] = useState('')
  const [availableCompanies, setAvailableCompanies] = useState([])
  const [companyId, setCompanyId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const {
        data: { session },
        error: sessionErr,
      } = await supabase.auth.getSession()
      if (sessionErr) throw sessionErr
      const user = session?.user
      if (!user) throw new Error('No active session.')

      const [
        { data: companies, error: compErr },
        { data: memberships, error: memErr },
        { data: adminRow, error: adminErr },
        { data: hrAdminRows, error: hrAdminErr },
        { data: appAccessRows, error: appAccessErr },
      ] = await Promise.all([
        supabase.from('companies').select('id, slug, name, status').order('name'),
        supabase.from('user_companies').select('company_id, role').eq('user_id', user.id),
        supabase.from('platform_admins').select('user_id').eq('user_id', user.id).maybeSingle(),
        supabase.from('hr_admins').select('company_id').eq('user_id', user.id),
        supabase.from('user_app_access').select('company_id, app_key').eq('user_id', user.id),
      ])
      if (compErr) throw compErr
      if (memErr) throw memErr
      if (adminErr) throw adminErr
      if (hrAdminErr) throw hrAdminErr
      if (appAccessErr) throw appAccessErr

      const isPlatformAdmin = !!adminRow
      const roleByCompany = Object.fromEntries((memberships || []).map((m) => [m.company_id, m.role]))
      const hrAdminCompanyIds = new Set((hrAdminRows || []).map((r) => r.company_id))

      const appAccessByCompany = {}
      for (const row of appAccessRows || []) {
        if (!appAccessByCompany[row.company_id]) appAccessByCompany[row.company_id] = new Set()
        appAccessByCompany[row.company_id].add(row.app_key)
      }

      const available = (companies || [])
        .map((c) => ({
          id: c.id,
          slug: c.slug,
          name: c.name,
          status: c.status,
          role: roleByCompany[c.id] || (isPlatformAdmin ? 'admin' : null),
          isHrAdmin: isPlatformAdmin || hrAdminCompanyIds.has(c.id),
        }))
        .filter((c) => c.role)
        .filter((c) => {
          // 2026-08-25: plain Company Admin no longer unconditionally
          // bypasses this — Thijs wants manager accounts (Company Admins)
          // restrictable to specific apps too, same mechanism as staff.
          // HR Admin keeps its own unconditional bypass (a narrower,
          // already-understood permission Thijs didn't ask to restrict).
          // An admin with zero user_app_access rows still passes via the
          // `!grants` fallback below, so nobody currently unrestricted
          // loses access.
          if (isPlatformAdmin || c.isHrAdmin) return true
          const grants = appAccessByCompany[c.id]
          return !grants || grants.has(APP_KEY)
        })

      setAvailableCompanies(available)
      const stored = localStorage.getItem(STORAGE_KEY)
      const stillValid = available.find((c) => c.id === stored)
      const next = stillValid ? stored : available[0]?.id || null
      setCompanyId(next)
      if (next) localStorage.setItem(STORAGE_KEY, next)
      else localStorage.removeItem(STORAGE_KEY)
    } catch (err) {
      setError(err.message || 'Could not load your company access.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Load this company's lodges into sb.js's LOCATIONS array whenever the
  // selected company changes. Ordered by created_at rather than id so the
  // established ZC, EC, SC display order is preserved (alphabetical would
  // reshuffle it to EC, SC, ZC). Only 'lodge' rows are kept — setLocations
  // filters out the Finance Dashboard's 'overhead' head-office row, which
  // these apps have never shown.
  useEffect(() => {
    let cancelled = false
    if (!companyId) {
      setLocations([])
      setLocationsReady(true)
      return
    }
    setLocationsReady(false)
    supabase
      .from('locations')
      .select('id, name, type, created_at')
      .eq('company_id', companyId)
      .order('created_at')
      .order('id')
      .then(({ data, error: locErr }) => {
        if (cancelled) return
        if (locErr) setError(locErr.message || 'Could not load lodges.')
        setLocations(data || [])
        setLocationsReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [companyId])

  const switchCompany = useCallback((id) => {
    setCompanyId(id)
    localStorage.setItem(STORAGE_KEY, id)
  }, [])

  const current = availableCompanies.find((c) => c.id === companyId) || null
  const value = {
    // Gate on lodges too — see locationsReady above.
    loading: loading || !locationsReady,
    error,
    availableCompanies,
    companyId,
    companyName: current?.name || '',
    companySlug: current?.slug || '',
    role: current?.role || null,
    isHrAdmin: current?.isHrAdmin || false,
    switchCompany,
    reload: load,
  }
  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>
}

export function useCompany() {
  const ctx = useContext(CompanyContext)
  if (!ctx) throw new Error('useCompany() must be used inside a <CompanyProvider>')
  return ctx
}
