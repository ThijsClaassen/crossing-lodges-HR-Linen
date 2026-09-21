// Work patterns — who is on duty on a given day (#453, 2026-09-21).
//
// Until now this app had ONE shape of working life hardcoded as two module
// constants: 21 days on, 7 days off, counted from each employee's own anchor
// date. That is right for rotational staff who live on site and wrong for
// anyone local who works a normal week with set days off.
//
// Two kinds, because Crossing Lodges runs both:
//
//   rotation   — X days on, Y off, counted from an anchor date. What every
//                employee does today. Needs an anchor: without one there is
//                no way to know where in the cycle a date falls, and guessing
//                would silently put people on duty on their off days.
//
//   fixed_week — the same days off every week, by weekday. Needs no anchor at
//                all, which is the point: a local cleaner who is off every
//                Sunday has no cycle to anchor.
//
// Pure functions, no React and no Supabase, so the date arithmetic can be
// tested against known calendars rather than eyeballed on a grid
// (tools/shift_patterns_test.mjs).
//
// THE PROPERTY THAT MATTERS MOST. An employee with no pattern assigned must
// behave EXACTLY as they did before this file existed: 21/7 from their
// anchor. Anything else means deploying this quietly rewrites the roster and
// the leave balances of everyone who has not been migrated yet, and a roster
// that changed without anyone asking is worse than one that cannot change.

// The shape every employee had before patterns existed. Used as the fallback
// whenever an employee has no pattern, so the old behaviour is not merely
// reproducible — it is what happens by default.
export const LEGACY_ROTATION = Object.freeze({
  id: null,
  name: 'Rotational 21 on / 7 off',
  kind: 'rotation',
  on_days: 21,
  off_days: 7,
  days_off: [],
})

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

// 'YYYY-MM-DD' -> local-midnight Date. Avoids the UTC-parsing footgun of
// `new Date('YYYY-MM-DD')`, which lands on the PREVIOUS day in any timezone
// behind UTC — and South Africa is ahead of it, so the bug would not show up
// here while breaking for anyone running this further west.
//
// Exported and imported by App.jsx rather than defined in both: two copies of
// a date convention is two chances for them to drift, and a day's drift in
// here moves somebody's off day.
export function parseDateOnly(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function fmtDateOnly(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

// Which pattern applies to an employee. Falls back to the legacy rotation
// rather than to "no pattern" — see the note at the top.
export function patternFor(employee, patternsById = {}) {
  const id = employee?.shift_pattern_id
  if (id && patternsById[id]) return patternsById[id]
  return LEGACY_ROTATION
}

// { status: 'on' | 'off' | 'none', blockStart? } for one day.
//
// blockStart is only set for a rotation, and only when on duty: it is the date
// the current working block began, which the schedule grid uses to label a
// stretch. Lodge assignment is keyed by calendar week, not by block, so
// nothing depends on a fixed_week pattern producing one.
export function statusForDate(pattern, anchorISO, date) {
  const p = pattern || LEGACY_ROTATION

  if (p.kind === 'fixed_week') {
    const daysOff = Array.isArray(p.days_off) ? p.days_off : []
    // No anchor needed, and none consulted. A fixed-week employee has a
    // knowable status on every date in history, including before they were
    // hired — the caller decides which dates are worth asking about.
    return { status: daysOff.includes(date.getDay()) ? 'off' : 'on' }
  }

  // Rotation from here down.
  const on = Number(p.on_days) || 0
  const off = Number(p.off_days) || 0
  const length = on + off

  // A rotation of zero length would divide by zero and put everyone on duty
  // forever. Treated as unset rather than as a working pattern.
  if (length <= 0) return { status: 'none' }
  if (!anchorISO) return { status: 'none' }

  const anchor = parseDateOnly(anchorISO)
  if (!Number.isFinite(anchor.getTime())) return { status: 'none' }

  const diffDays = Math.round((date - anchor) / 86400000)
  // JavaScript's % keeps the sign of the dividend, so a date BEFORE the
  // anchor gives a negative phase and would read as on duty. Dates before the
  // anchor are real — the grid can be scrolled back — so this wraps rather
  // than clamping.
  let phase = diffDays % length
  if (phase < 0) phase += length

  if (phase < on) return { status: 'on', blockStart: fmtDateOnly(addDays(date, -phase)) }
  return { status: 'off' }
}

// How many days in [startISO, endISO] inclusive fall on a day this employee
// was already scheduled to work.
//
// This is what decides how much leave a request costs: days that were already
// off cost nothing. Getting it wrong does not look wrong — it shows up months
// later as a balance that does not reconcile.
export function workingDaysInRange(pattern, anchorISO, startISO, endISO) {
  if (!startISO || !endISO) return 0
  const p = pattern || LEGACY_ROTATION
  // A rotation with no anchor has no knowable status, so no day in the range
  // can be counted as working. Returning 0 matches the old behaviour exactly.
  if (p.kind !== 'fixed_week' && !anchorISO) return 0

  let count = 0
  let d = parseDateOnly(startISO)
  const end = parseDateOnly(endISO)
  // Guard against a reversed range spinning forever if a caller ever passes
  // one — the UI blocks it, but this function is also called from the leave
  // engine and from tests.
  let guard = 0
  while (d <= end && guard++ < 4000) {
    if (statusForDate(p, anchorISO, d).status === 'on') count++
    d = addDays(d, 1)
  }
  return count
}

// One line describing a pattern, for a dropdown or a column. Written so the
// reader never has to open the pattern to know what it means.
export function describePattern(pattern) {
  const p = pattern || LEGACY_ROTATION
  if (p.kind === 'fixed_week') {
    const daysOff = (Array.isArray(p.days_off) ? p.days_off : []).slice().sort((a, b) => a - b)
    if (!daysOff.length) return 'Every day — no days off set'
    return `Off ${daysOff.map((d) => WEEKDAY_NAMES[d]).join(', ')}`
  }
  return `${p.on_days} on / ${p.off_days} off`
}

// Does this employee have everything the pattern needs to produce a schedule?
// Returned as a reason rather than a boolean so the UI can say WHICH thing is
// missing — "no pattern" and "no start date" need different fixes.
export function missingSetup(employee, pattern) {
  const p = pattern || LEGACY_ROTATION
  if (p.kind === 'fixed_week') return null
  if (!employee?.cycle_anchor_date) return 'no cycle start date set'
  return null
}
