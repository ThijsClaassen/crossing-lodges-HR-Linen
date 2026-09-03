// BCEA leave cycle maths.
//
// The whole reason this is a separate module rather than a few lines in
// LeaveTab: leave balances in South Africa are NOT per calendar year.
//
//   Annual leave              12-month cycle
//   Family responsibility     12-month cycle, lapses (no carry-over)
//   Sick leave                THIRTY-SIX month cycle
//   Maternity                 per birth, no recurring balance
//
// and every cycle runs from the EMPLOYEE'S OWN START DATE, not 1 January.
// Two people who started in different months are in different cycles on the
// same day. Counting sick leave per calendar year would hand each employee
// 30 days a year instead of 30 days per three years, and nothing on screen
// would look wrong.
//
// Kept free of React and of Supabase so it can be exercised directly —
// see tools/leave_engine_test.mjs.

export const LEAVE_TYPES = ['annual', 'sick', 'family_responsibility', 'maternity']

export const LEAVE_TYPE_LABELS = {
  annual: 'Annual leave',
  sick: 'Sick leave',
  family_responsibility: 'Family responsibility leave',
  maternity: 'Maternity leave',
}

// Fallbacks only. Real values come from hr_leave_entitlements, which is
// editable — an employer may grant more than the statutory minimum, and the
// law itself moves (parental leave is mid-reform after Van Wyk 2025).
export const BCEA_FALLBACK = {
  annual: { days_per_cycle: 15, cycle_months: 12, paid: true, min_service_months: 0 },
  sick: { days_per_cycle: 30, cycle_months: 36, paid: true, min_service_months: 0 },
  family_responsibility: { days_per_cycle: 3, cycle_months: 12, paid: true, min_service_months: 4 },
  maternity: { days_per_cycle: 120, cycle_months: null, paid: false, min_service_months: 0 },
}

function toDate(value) {
  if (!value) return null
  const s = String(value).slice(0, 10)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  // Build in UTC so no local timezone can shift the calendar day.
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
}

function toISO(date) {
  return date.toISOString().slice(0, 10)
}

// Add months, clamping the day so 31 Jan + 1 month is 28/29 Feb rather than
// rolling into March the way naive setMonth() does. A cycle that silently
// skipped a month would put the employee in the wrong window.
function addMonths(date, months) {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  const d = date.getUTCDate()
  const target = new Date(Date.UTC(y, m + months, 1))
  const daysInTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate()
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, daysInTarget)))
}

export function monthsBetween(fromISO, toISOStr) {
  const a = toDate(fromISO)
  const b = toDate(toISOStr)
  if (!a || !b) return 0
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth())
  if (b.getUTCDate() < a.getUTCDate()) months -= 1
  return months
}

/**
 * The cycle window containing `asOf`, counting from the employee's start
 * date in steps of `cycleMonths`.
 *
 * Returns null when there is no recurring cycle (maternity) or no start
 * date on record — deliberately null rather than a guessed window, because
 * a wrong window shows a confident, wrong balance.
 */
export function cycleWindow(startDateISO, cycleMonths, asOfISO) {
  const start = toDate(startDateISO)
  const asOf = toDate(asOfISO)
  if (!start || !asOf || !cycleMonths || cycleMonths <= 0) return null
  if (asOf < start) return null

  // Step forward a cycle at a time. Employment spans are short enough that
  // this is cheaper and far easier to reason about than date arithmetic
  // tricks, and it cannot drift on month-length edge cases.
  let index = 0
  let cycleStart = start
  let cycleEnd = addMonths(start, cycleMonths)
  while (cycleEnd <= asOf && index < 200) {
    cycleStart = cycleEnd
    cycleEnd = addMonths(cycleStart, cycleMonths)
    index += 1
  }
  return {
    index,
    start: toISO(cycleStart),
    // Inclusive last day of the cycle: the day before the next one starts.
    end: toISO(new Date(cycleEnd.getTime() - 86400000)),
    nextStart: toISO(cycleEnd),
  }
}

/**
 * Sick leave during the first six months of employment is capped at
 * 1 day per 26 days worked, rather than the full 30. Returns null when the
 * cap does not apply, so the caller can tell "no cap" from "cap of zero".
 */
export function firstSixMonthsSickCap(startDateISO, asOfISO, daysWorked) {
  if (monthsBetween(startDateISO, asOfISO) >= 6) return null
  const worked = Number(daysWorked)
  if (!Number.isFinite(worked) || worked < 0) return 0
  return Math.floor(worked / 26)
}

/**
 * Balance for one employee and one leave type.
 *
 * `workingDaysBetween` is injected rather than imported so this module does
 * not duplicate the 21-on/7-off rotation logic that already lives in
 * App.jsx. Two copies of that would drift, and the copy in the balance
 * engine would be the one nobody notices is wrong.
 */
export function leaveBalance({
  employee,
  leaveType,
  entitlement,
  leaveRows,
  asOf,
  workingDaysBetween,
}) {
  const ent = entitlement || BCEA_FALLBACK[leaveType] || {}
  const asOfISO = String(asOf).slice(0, 10)
  const startDate = employee?.start_date || null
  const cycleMonths = ent.cycle_months ?? null

  const rowsOfType = (leaveRows || []).filter(
    (l) => l.employee_id === employee?.id && (l.leave_type || 'annual') === leaveType,
  )

  const window = cycleWindow(startDate, cycleMonths, asOfISO)

  // Per-event types (maternity) and employees with no start date on record
  // get usage totals but no balance. Showing "120 days remaining" for
  // maternity would imply an annual allowance that does not exist.
  if (!window) {
    const usedAllTime = rowsOfType.reduce((s, l) => s + Number(l.days_used || 0), 0)
    return {
      leaveType,
      hasBalance: false,
      reason: cycleMonths ? 'no start date on record' : 'per event, not a recurring allowance',
      entitled: null,
      used: usedAllTime,
      remaining: null,
      cycleStart: null,
      cycleEnd: null,
      paid: ent.paid !== false,
      eligible: true,
    }
  }

  const used = rowsOfType
    .filter((l) => {
      const d = String(l.start_date || '').slice(0, 10)
      return d >= window.start && d <= window.end
    })
    .reduce((s, l) => s + Number(l.days_used || 0), 0)

  // Family responsibility leave requires a minimum period of service.
  const serviceMonths = startDate ? monthsBetween(startDate, asOfISO) : 0
  const minService = Number(ent.min_service_months || 0)
  const eligible = serviceMonths >= minService

  let entitled = eligible ? Number(ent.days_per_cycle || 0) : 0
  let cappedNote = null

  if (leaveType === 'sick' && typeof workingDaysBetween === 'function') {
    const worked = workingDaysBetween(employee?.cycle_anchor_date, startDate, asOfISO)
    const cap = firstSixMonthsSickCap(startDate, asOfISO, worked)
    if (cap != null && cap < entitled) {
      entitled = cap
      cappedNote = `First 6 months: capped at 1 day per 26 days worked (${worked} worked)`
    }
  }

  return {
    leaveType,
    hasBalance: true,
    entitled,
    used,
    remaining: entitled - used,
    cycleStart: window.start,
    cycleEnd: window.end,
    cycleIndex: window.index,
    paid: ent.paid !== false,
    eligible,
    serviceMonths,
    minServiceMonths: minService,
    note: cappedNote,
    // Family responsibility leave lapses at cycle end rather than carrying
    // over — surfaced so the UI can say so rather than implying a rollover.
    lapses: leaveType === 'family_responsibility',
  }
}

/** All types for one employee, in the entitlement table's own sort order. */
export function allBalances({ employee, entitlements, leaveRows, asOf, workingDaysBetween }) {
  const list = (entitlements && entitlements.length ? entitlements : null) || [
    { leave_type: 'annual', ...BCEA_FALLBACK.annual, sort_order: 1 },
    { leave_type: 'sick', ...BCEA_FALLBACK.sick, sort_order: 2 },
    { leave_type: 'family_responsibility', ...BCEA_FALLBACK.family_responsibility, sort_order: 3 },
    { leave_type: 'maternity', ...BCEA_FALLBACK.maternity, sort_order: 4 },
  ]
  return [...list]
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
    .map((ent) =>
      leaveBalance({
        employee,
        leaveType: ent.leave_type,
        entitlement: ent,
        leaveRows,
        asOf,
        workingDaysBetween,
      }),
    )
}

/**
 * Annual leave keeps its per-employee override (hr_employees.annual_leave_days),
 * which predates this module and is how Thijs already grants above-minimum
 * leave. Zero is treated as "not set" and falls back to the company
 * entitlement — an employee row defaults to 0, and 0 days of annual leave is
 * never a real intention.
 */
export function entitlementForEmployee(entitlement, employee) {
  if (!entitlement || entitlement.leave_type !== 'annual') return entitlement
  const override = Number(employee?.annual_leave_days || 0)
  if (override > 0) return { ...entitlement, days_per_cycle: override }
  return entitlement
}
