// Staffing coverage — "do we have enough of position X on duty for the
// number of guests in-house" (2026-08-12). Pure functions, no Supabase
// calls, so this can be reasoned about/tested independently of the
// Schedule tab's UI.
//
// Guest counts come from revenue_bookings, which lives in this same shared
// Supabase project (populated by the Finance Dashboard's Revenue Importer)
// — read cross-app the same way staffCostEngine.js already reads
// food_issues/bev_issues. Only bookings with a "real" status count, same
// rule as the Finance Dashboard itself (crossing-lodges-budget/src/
// constants.js REAL_REVENUE_STATUSES) so a night here agrees with what the
// Finance Dashboard would call occupied.
const REAL_BOOKING_STATUSES = ['Confirmed', 'Checked Out']

function isoDate(d) {
  return d.toISOString().slice(0, 10)
}

// revenue_bookings.bed_nights is the *total* for the whole stay (guests x
// nights), not a per-night figure — a booking only tells you "9 bed nights
// over 3 nights", not how many guests were in on any single night. Thijs
// asked for day-level flags ("every day separate"), so this spreads each
// booking's bed_nights evenly across its stay (arrival_date inclusive ..
// departure_date exclusive, standard hotel convention — the guest occupies
// a bed the night of arrival through the night before departure). Even
// split is the only assumption possible from PMS export data that doesn't
// record day-by-day pax changes mid-stay.
//
// bookings: array of { location_id, arrival_date, departure_date, nights,
// bed_nights, reservation_status }. Returns { [`${location_id}|${date}`]: guests }.
export function guestsByLodgeAndDate(bookings) {
  const map = {}
  for (const b of bookings || []) {
    if (!REAL_BOOKING_STATUSES.includes(b.reservation_status)) continue
    if (!b.location_id || !b.arrival_date || !b.departure_date) continue
    const nights = Number(b.nights || 0)
    if (nights <= 0) continue
    const perNight = Number(b.bed_nights || 0) / nights

    let d = new Date(`${b.arrival_date}T00:00:00`)
    const end = new Date(`${b.departure_date}T00:00:00`)
    while (d < end) {
      const key = `${b.location_id}|${isoDate(d)}`
      map[key] = (map[key] || 0) + perNight
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
    }
  }
  return map
}

// tiers: [{ position, min_guests, max_guests (nullable), required_count }].
// Returns null if no tier is defined for this position at all (so the
// caller can distinguish "not configured" from "configured, 0 required").
export function requiredCountFor(tiers, position, guests) {
  const applicable = (tiers || []).filter((t) => t.position === position).sort((a, b) => a.min_guests - b.min_guests)
  if (applicable.length === 0) return null

  const g = Math.round(Number(guests) || 0)
  if (g <= 0) return 0

  for (const t of applicable) {
    const max = t.max_guests
    if (g >= t.min_guests && (max == null || g <= max)) return t.required_count
  }

  // Busier than any tier you've defined — use the top tier's requirement
  // rather than silently showing "no shortage" just because nobody's typed
  // in a rule for that many guests yet.
  const top = applicable[applicable.length - 1]
  if (top.max_guests != null && g > top.max_guests) return top.required_count

  // Falls in a gap below the lowest tier's min_guests (e.g. tiers start at
  // 5 and g is 2) — treat as "no requirement configured for this range."
  return 0
}
