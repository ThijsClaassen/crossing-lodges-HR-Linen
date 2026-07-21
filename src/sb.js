// Lightweight Supabase REST wrapper — same pattern as crossing-lodges-ops,
// crossing-lodges-beverage, and crossing-lodges-food (small bundle, no SDK
// version dependency, plain fetch calls against PostgREST).
//
// Points at the SAME Supabase project as the other three apps so all four
// share one database.

const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || 'https://arrendpmuwdhrfwvokhv.supabase.co'
const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_e5hLLlXWBVV8NkNUAz3Blg_8oMwP3Wt'

const REST = `${SUPABASE_URL}/rest/v1`

function headers(extra = {}) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
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
      headers: headers(),
    })
    return handle(res)
  },

  async insert(table, rows) {
    const res = await fetch(`${REST}/${table}`, {
      method: 'POST',
      headers: headers({ Prefer: 'return=representation' }),
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
        headers: headers({
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
      headers: headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(patch),
    })
    return handle(res)
  },

  async remove(table, filters) {
    const res = await fetch(`${REST}/${table}${qs(filters)}`, {
      method: 'DELETE',
      headers: headers({ Prefer: 'return=representation' }),
    })
    return handle(res)
  },
}

export const LOCATIONS = [
  { id: 'ZC', name: 'Zebras Crossing' },
  { id: 'EC', name: 'Elephants Crossing' },
  { id: 'SC', name: 'Schamach' },
]

export const UNIFORM_CATEGORIES = ['Shirt', 'Pants', 'Jacket', 'Shoes', 'Apron', 'Hat', 'Other']
export const LINEN_CATEGORIES = ['Duvets', 'Pillow Covers', 'Towels', 'Serviettes', 'Gowns', 'Other']
export const MOVEMENT_REASONS = ['Received', 'Lost', 'Damaged', 'Other']
export const CONTRACT_TYPES = ['Permanent', 'Fixed-term', 'Probation']
