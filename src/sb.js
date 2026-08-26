// Lightweight Supabase REST wrapper — same pattern as crossing-lodges-ops,
// crossing-lodges-beverage, and crossing-lodges-food (small bundle, no SDK
// version dependency, plain fetch calls against PostgREST).
//
// Points at the SAME Supabase project as the other three apps so all four
// share one database.
//
// Made session-aware 2026-08-08 (HR/Linen 3b of the multi-tenant rebuild):
// headers() now reads the real Supabase Auth session and sends the user's
// own access token instead of the anon key, so RLS's auth.uid() resolves to
// the logged-in user rather than nobody. Same change already made in Food
// Stock's sb.js.

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient.js'

const REST = `${SUPABASE_URL}/rest/v1`

async function headers(extra = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

function qs(filters = {}) {
  const parts = []
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue
    // pass through already-formed postgrest filters like { period: 'eq.2026-07' }
    parts.push(`${key}=${typeof value === 'string' && value.includes('.') ? value : `eq.${value}`}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

async function handle(res) {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${res.status}: ${text}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

export const sb = {
  // select('hr_employees', { location_id: 'ZC' }, { select: '*', order: 'first_name.asc' })
  async select(table, filters = {}, opts = {}) {
    const params = { ...filters }
    if (opts.select) params.select = opts.select
    if (opts.order) params.order = opts.order
    const res = await fetch(`${REST}/${table}${qs(params)}`, {
      headers: await headers(),
    })
    return handle(res)
  },

  async insert(table, rows) {
    const res = await fetch(`${REST}/${table}`, {
      method: 'POST',
      headers: await headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
    })
    return handle(res)
  },

  // upsert on a unique constraint, e.g. onConflict = 'item_id,location_id'
  async upsert(table, rows, onConflict) {
    const res = await fetch(
      `${REST}/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
      {
        method: 'POST',
        headers: await headers({
          Prefer: 'resolution=merge-duplicates,return=representation',
        }),
        body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
      }
    )
    return handle(res)
  },

  async update(table, filters, patch) {
    const res = await fetch(`${REST}/${table}${qs(filters)}`, {
      method: 'PATCH',
      headers: await headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(patch),
    })
    return handle(res)
  },

  async remove(table, filters) {
    const res = await fetch(`${REST}/${table}${qs(filters)}`, {
      method: 'DELETE',
      headers: await headers({ Prefer: 'return=representation' }),
    })
    return handle(res)
  },
}

// Lodges for the current company. Loaded from the shared `locations` table
// at login (see CompanyContext.jsx) instead of being hardcoded, so a second
// company's own lodges work without a code change (2026-08-26).
//
// Deliberately a MUTABLE module array rather than React state: this app
// already reads LOCATIONS synchronously in a number of places, some outside
// components, and converting every one to a hook would be a large change for
// no visible benefit today. CompanyContext fills this in BEFORE it renders
// any children, and refills it on company switch, so by the time anything
// reads it, it's correct. The array identity never changes — contents are
// replaced in place — so existing dependency arrays keep behaving as before.
export const LOCATIONS = []

// Only 'lodge' rows: the shared locations table also holds an 'overhead'
// (head office) row that the Finance Dashboard uses for non-lodge costs and
// that this app has never shown. Ordering is by created_at, not id, because
// the established display order is ZC, EC, SC — which alphabetical order
// would reshuffle to EC, SC, ZC.
export function setLocations(rows) {
  LOCATIONS.length = 0
  for (const r of rows || []) {
    if (r.type && r.type !== 'lodge') continue
    LOCATIONS.push({ id: r.id, name: r.name, type: r.type ?? null })
  }
}

export const UNIFORM_CATEGORIES = ['Shirt', 'Pants', 'Jacket', 'Shoes', 'Apron', 'Hat', 'Other']
export const LINEN_CATEGORIES = ['Duvets', 'Pillow Covers', 'Towels', 'Serviettes', 'Gowns', 'Other']
export const MOVEMENT_REASONS = ['Received', 'Lost', 'Damaged', 'Other']
export const CONTRACT_TYPES = ['Permanent', 'Fixed-term', 'Probation']
