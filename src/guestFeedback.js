// Guest feedback (#487, 2026-09-27) — pure. Executed by
// tools/guest_feedback_test.mjs. No imports.
//
// GuestRevu has no customer-facing API (see add_guest_feedback.sql), so the
// feed is its Reviews-tab export. This module turns that CSV into rows,
// and rows into a department trend per lodge per week with a note of who
// was rostered — the framing the whole feature stands on.

// --- CSV -------------------------------------------------------------------------
// RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF, BOM tolerated.
// Calendar date helpers, inlined (not imported from ./dates.js) because the
// tests load this file on its own. Same code as src/dates.js.
function isoDate(d) {
  const x = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(x.getTime())) return null
  return `${String(x.getFullYear()).padStart(4, '0')}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}
function utcIsoDate(d) {
  const x = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(x.getTime())) return null
  return `${String(x.getUTCFullYear()).padStart(4, '0')}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`
}

export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const s = String(text || '').replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',' ) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((x) => x !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some((x) => x !== '')) rows.push(row)
  if (rows.length === 0) return { headers: [], records: [] }
  const headers = rows[0].map((h) => h.trim())
  const records = rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])))
  return { headers, records }
}

// --- Column mapping ------------------------------------------------------------
// Guess which export column is which. The user confirms; the guess only
// saves clicks. Category guesses use the words GuestRevu questionnaires
// tend to use; anything unrecognised is offered as "other".
const GUESS = {
  id: [/response.?id/i, /review.?id/i, /^id$/i],
  stay_date: [/check.?out/i, /departure/i, /stay.?date/i, /review.?date/i, /^date$/i],
  location: [/property/i, /lodge/i, /location/i, /hotel/i, /site/i],
  overall: [/overall/i, /total.?score/i, /^rating$/i, /^score$/i, /nps/i],
  comment: [/comment/i, /review.?text/i, /feedback/i, /remarks/i],
  reviewer: [/guest.?name/i, /reviewer/i, /^name$/i, /source/i],
}
export const CATEGORY_GUESS = {
  food: [/food/i, /dining/i, /meal/i, /restaurant/i, /beverage/i, /f&b/i],
  housekeeping: [/clean/i, /housekeep/i, /room/i, /accommodation/i],
  activities: [/activit/i, /game.?drive/i, /guide/i, /ranger/i, /safari/i, /experience/i],
  service: [/service/i, /staff/i, /friendl/i, /reception/i, /front/i, /welcome/i],
  facilities: [/facilit/i, /pool/i, /spa/i, /grounds/i, /maintenance/i],
  value: [/value/i, /price/i],
}
const isScoreColumn = (records, h) => {
  const vals = records.map((r) => r[h]).filter((v) => v !== '')
  if (vals.length === 0) return false
  return vals.filter((v) => /^\d+(\.\d+)?$/.test(v)).length / vals.length >= 0.8
}
export function guessColumnMap(headers, records = []) {
  const map = { categories: {} }
  const taken = new Set()
  for (const [field, pats] of Object.entries(GUESS)) {
    const h = headers.find((x) => !taken.has(x) && pats.some((p) => p.test(x)))
    if (h) { map[field] = h; taken.add(h) }
  }
  for (const h of headers) {
    if (taken.has(h) || !isScoreColumn(records, h)) continue
    const cat = Object.entries(CATEGORY_GUESS).find(([, pats]) => pats.some((p) => p.test(h)))?.[0]
    if (cat && !map.categories[cat]) { map.categories[cat] = h; taken.add(h) }
  }
  return map
}

// dd/mm/yyyy, yyyy-mm-dd, d MMM yyyy, or anything Date can read → ISO date.
export function toIsoDate(v) {
  if (!v) return null
  const s = String(v).trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : isoDate(d)
}

const num = (v) => {
  if (v === '' || v == null) return null
  const n = Number(String(v).replace(',', '.').replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : null
}

// Export records → guest_feedback rows. Unknown lodge names are kept as
// typed and reported in `unmappedLocations` so the user can add an alias.
export function normaliseRows(records, map, { locationAliases = {}, knownLocations = [] } = {}) {
  const rows = []
  const skipped = []
  const unmappedLocations = new Set()
  const known = new Set(knownLocations.map((l) => String(l).toUpperCase()))
  for (const r of records) {
    const stay = toIsoDate(r[map.stay_date])
    if (!stay) { skipped.push(r); continue }
    const locRaw = map.location ? r[map.location] : ''
    let location = null
    if (locRaw) {
      const alias = locationAliases[locRaw] || locationAliases[locRaw.trim()]
      if (alias) location = alias
      else if (known.has(locRaw.trim().toUpperCase())) location = locRaw.trim().toUpperCase()
      else { location = null; unmappedLocations.add(locRaw.trim()) }
    }
    const scores = {}
    for (const [cat, col] of Object.entries(map.categories || {})) {
      const n = num(r[col])
      if (n != null) scores[cat] = n
    }
    rows.push({
      external_id: map.id ? r[map.id] || null : null,
      location_id: location,
      stay_date: stay,
      overall: map.overall ? num(r[map.overall]) : null,
      scores,
      comment: map.comment ? r[map.comment] || null : null,
      reviewer: map.reviewer ? r[map.reviewer] || null : null,
      raw: r,
    })
  }
  return { rows, skipped, unmappedLocations: [...unmappedLocations] }
}

// --- Trend -------------------------------------------------------------------------
export function mondayOf(iso) {
  const d = new Date(`${iso}T00:00:00Z`)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() - (day - 1))
  return utcIsoDate(d)
}

// Per lodge, per week (Monday key), per category: average and count. Plus
// overall. Weeks with no responses are absent — a gap is a gap.
export function weeklyTrend(feedback, { locationId = null, from = null, to = null } = {}) {
  const weeks = {}
  for (const f of feedback) {
    if (locationId && f.location_id !== locationId) continue
    if (from && f.stay_date < from) continue
    if (to && f.stay_date > to) continue
    const wk = mondayOf(f.stay_date)
    const loc = f.location_id || '—'
    const key = `${loc}|${wk}`
    const w = weeks[key] || (weeks[key] = { location_id: loc, week: wk, responses: 0, overall: { sum: 0, n: 0 }, categories: {} })
    w.responses++
    if (f.overall != null) { w.overall.sum += Number(f.overall); w.overall.n++ }
    for (const [cat, v] of Object.entries(f.scores || {})) {
      const c = w.categories[cat] || (w.categories[cat] = { sum: 0, n: 0 })
      c.sum += Number(v); c.n++
    }
  }
  const round1 = (x) => Math.round(x * 10) / 10
  return Object.values(weeks)
    .map((w) => ({
      location_id: w.location_id,
      week: w.week,
      responses: w.responses,
      overall: w.overall.n ? round1(w.overall.sum / w.overall.n) : null,
      categories: Object.fromEntries(Object.entries(w.categories).map(([k, c]) => [k, { avg: round1(c.sum / c.n), n: c.n }])),
    }))
    .sort((a, b) => a.location_id.localeCompare(b.location_id) || a.week.localeCompare(b.week))
}

// Who was rostered at a lodge that week, grouped by department. Context,
// not attribution: the list is shown next to the trend, never scored.
export function rosterForWeek(scheduleLocations, employees, { locationId, week }) {
  const byId = Object.fromEntries((employees || []).map((e) => [e.id, e]))
  const out = {}
  for (const s of scheduleLocations || []) {
    if (s.location_id !== locationId || String(s.week_start_date).slice(0, 10) !== week) continue
    const e = byId[s.employee_id]
    if (!e) continue
    const dept = e.department?.trim() || 'No department'
    ;(out[dept] = out[dept] || []).push(`${e.first_name || ''} ${e.last_name || ''}`.trim())
  }
  for (const k of Object.keys(out)) out[k].sort()
  return out
}

// Categories that feed a department, by the company's mapping.
export function categoriesForDepartment(categoryDepartments, department) {
  const d = String(department || '').trim().toLowerCase()
  return Object.entries(categoryDepartments || {}).filter(([, dep]) => String(dep || '').trim().toLowerCase() === d).map(([cat]) => cat)
}

// Department trend by month for the appraisal pack: the lodges the employee
// was rostered at in the period, the categories that feed their department.
// Returns [{ month, avg, n }]; empty when the department has no category.
export function departmentTrend({ feedback, categoryDepartments, department, employeeId, scheduleLocations, from, to }) {
  const cats = categoriesForDepartment(categoryDepartments, department)
  if (cats.length === 0) return { categories: [], months: [] }
  const weeksAt = new Set((scheduleLocations || []).filter((s) => s.employee_id === employeeId).map((s) => `${s.location_id}|${String(s.week_start_date).slice(0, 10)}`))
  const months = {}
  for (const f of feedback || []) {
    if (from && f.stay_date < from) continue
    if (to && f.stay_date > to) continue
    if (weeksAt.size && !weeksAt.has(`${f.location_id}|${mondayOf(f.stay_date)}`)) continue
    const mo = f.stay_date.slice(0, 7)
    for (const c of cats) {
      const v = f.scores?.[c]
      if (v == null) continue
      const m = months[mo] || (months[mo] = { sum: 0, n: 0 })
      m.sum += Number(v); m.n++
    }
  }
  return {
    categories: cats,
    months: Object.entries(months).sort(([a], [b]) => a.localeCompare(b)).map(([month, m]) => ({ month, avg: Math.round((m.sum / m.n) * 10) / 10, n: m.n })),
  }
}

// --- Member reviews of staff visits (#519) ------------------------------------
// The LL members rate each staff visit to their plot (member_visit_reviews,
// written by the member portal; questions in member_review_questions). Unlike
// guest feedback this IS about a named person — the member watched them
// work — so the appraisal shows the employee's own averages next to the
// department's. With a FLOOR: no personal figure under `minCount` reviews in
// the period; the department line always shows.
export const MEMBER_REVIEW_MIN_COUNT = 3
const round1 = (n) => Math.round(n * 10) / 10

export function reviewOverall(scores) {
  const vals = Object.values(scores || {}).map(Number).filter((n) => n >= 1 && n <= 5)
  return vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null
}

export function memberFeedback({ reviews = [], questions = [], employeeId, department, employees = [], from, to, minCount = MEMBER_REVIEW_MIN_COUNT }) {
  const qs = (questions || []).filter((q) => q.active !== false).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.label).localeCompare(String(b.label))).map((q) => ({ key: q.key, label: q.label }))
  const deptOf = Object.fromEntries((employees || []).map((e) => [e.id, (e.department || '').trim()]))
  const inPeriod = (reviews || []).filter((r) => (!from || r.visit_date >= from) && (!to || r.visit_date <= to))
  const mine = inPeriod.filter((r) => r.employee_id === employeeId)
  const dept = department ? inPeriod.filter((r) => deptOf[r.employee_id] === department.trim()) : []

  const agg = (rows, floor) => {
    const n = rows.length
    const shown = n >= floor
    const avg = {}
    for (const q of qs) {
      const vals = rows.map((r) => Number(r.scores?.[q.key])).filter((v) => v >= 1 && v <= 5)
      avg[q.key] = shown && vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null
    }
    const overalls = rows.map((r) => reviewOverall(r.scores)).filter((v) => v != null)
    return { n, shown, avg, overall: shown && overalls.length ? round1(overalls.reduce((a, b) => a + b, 0) / overalls.length) : null }
  }
  const months = {}
  for (const r of mine) {
    const o = reviewOverall(r.scores)
    if (o == null) continue
    const mo = String(r.visit_date).slice(0, 7)
    const m = months[mo] || (months[mo] = { sum: 0, n: 0 })
    m.sum += o; m.n++
  }
  const employee = agg(mine, minCount)
  return {
    questions: qs,
    minCount,
    employee,
    department: { name: department || '', ...agg(dept, 1) },
    months: employee.shown ? Object.entries(months).sort(([a], [b]) => a.localeCompare(b)).map(([month, m]) => ({ month, avg: round1(m.sum / m.n), n: m.n })) : [],
    comments: mine.filter((r) => r.comment).sort((a, b) => String(b.visit_date).localeCompare(String(a.visit_date))).map((r) => ({ date: r.visit_date, overall: reviewOverall(r.scores), comment: r.comment })),
  }
}
