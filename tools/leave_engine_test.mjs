// Behavioural tests for the BCEA leave cycle engine.
//
// The bug this exists to prevent: sick leave counted per calendar year
// instead of per 36-month cycle. That mistake grants roughly three times
// the correct entitlement and produces a screen that looks entirely normal
// — no error, no warning, just wrong numbers that a payroll dispute would
// eventually surface. So the cycle maths is tested against dates, not
// eyeballed.
//
//   node tools/leave_engine_test.mjs
import {
  cycleWindow,
  monthsBetween,
  firstSixMonthsSickCap,
  leaveBalance,
  allBalances,
  entitlementForEmployee,
  BCEA_FALLBACK,
} from '../src/leaveEngine.js'

let passed = 0
const failures = []
function check(name, cond, detail) {
  if (cond) passed += 1
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

const ENT = {
  annual: { leave_type: 'annual', ...BCEA_FALLBACK.annual, sort_order: 1 },
  sick: { leave_type: 'sick', ...BCEA_FALLBACK.sick, sort_order: 2 },
  frl: { leave_type: 'family_responsibility', ...BCEA_FALLBACK.family_responsibility, sort_order: 3 },
  maternity: { leave_type: 'maternity', ...BCEA_FALLBACK.maternity, sort_order: 4 },
}

const emp = { id: 'e1', start_date: '2023-04-01', cycle_anchor_date: null, annual_leave_days: 0 }

// --- 1. Cycle windows run from the start date, not the calendar year -----
{
  const w = cycleWindow('2023-04-01', 12, '2026-09-03')
  check('annual cycle starts on the employment anniversary', w.start === '2026-04-01', `got ${w.start}`)
  check('and ends the day before the next one', w.end === '2027-03-31', `got ${w.end}`)
  check('not 1 January', w.start !== '2026-01-01')

  // The headline case: 36-month sick cycle. Asked mid-cycle-1 it must give
  // the three-year window, and it must NOT roll early.
  const s = cycleWindow('2023-04-01', 36, '2025-01-01')
  check('sick cycle is three years long', s.start === '2023-04-01' && s.end === '2026-03-31', `got ${s.start}..${s.end}`)
  check('and is cycle index 0', s.index === 0, `got ${s.index}`)

  const lastDay = cycleWindow('2023-04-01', 36, '2026-03-31')
  check('the final day of a cycle still belongs to that cycle', lastDay.start === '2023-04-01', `got ${lastDay.start}`)

  const s2 = cycleWindow('2023-04-01', 36, '2026-09-03')
  check('and rolls to the second cycle after 3 years', s2.start === '2026-04-01', `got ${s2.start}`)
  check('second sick cycle ends in 2029', s2.end === '2029-03-31', `got ${s2.end}`)
  check('second cycle is index 1', s2.index === 1, `got ${s2.index}`)

  check('a date before employment has no cycle', cycleWindow('2026-01-01', 12, '2025-01-01') === null)
  check('no start date means no cycle', cycleWindow(null, 12, '2026-09-03') === null)
  check('no cycle length means no cycle (per-event types)', cycleWindow('2023-04-01', null, '2026-09-03') === null)
}

// --- 2. Month-end clamping ------------------------------------------------
{
  // 31 Jan + 1 month must be 28/29 Feb, not 2/3 March.
  const w = cycleWindow('2024-01-31', 1, '2024-02-15')
  check('31 Jan + 1 month clamps to 29 Feb in a leap year', w.start === '2024-01-31' && w.end === '2024-02-28', `got ${w.start}..${w.end}`)

  const leap = cycleWindow('2024-02-29', 12, '2025-06-01')
  check('29 Feb start rolls to 28 Feb the next year', leap.start === '2025-02-28', `got ${leap.start}`)
}

// --- 3. monthsBetween ------------------------------------------------------
{
  check('exactly 4 months', monthsBetween('2026-01-15', '2026-05-15') === 4)
  check('one day short of 4 months is 3', monthsBetween('2026-01-15', '2026-05-14') === 3, `got ${monthsBetween('2026-01-15','2026-05-14')}`)
  check('same day is 0', monthsBetween('2026-05-15', '2026-05-15') === 0)
}

// --- 4. Sick leave: the tenfold-over-grant trap ---------------------------
{
  // 12 days taken in year 1, 12 more in year 2 — inside ONE 36-month cycle.
  const rows = [
    { employee_id: 'e1', leave_type: 'sick', start_date: '2023-06-01', days_used: 12 },
    { employee_id: 'e1', leave_type: 'sick', start_date: '2024-06-01', days_used: 12 },
  ]
  const b = leaveBalance({ employee: emp, leaveType: 'sick', entitlement: ENT.sick, leaveRows: rows, asOf: '2025-01-01' })
  check('both years count against the same 36-month cycle', b.used === 24, `got ${b.used}`)
  check('leaving 6 of 30, not 18 of 30', b.remaining === 6, `got ${b.remaining}`)
  check('cycle window is the 3-year one', b.cycleStart === '2023-04-01' && b.cycleEnd === '2026-03-31')

  // After the cycle rolls, usage resets.
  const after = leaveBalance({ employee: emp, leaveType: 'sick', entitlement: ENT.sick, leaveRows: rows, asOf: '2026-09-03' })
  check('usage from the previous cycle does not follow the employee', after.used === 0, `got ${after.used}`)
  check('and the full 30 days are available again', after.remaining === 30, `got ${after.remaining}`)
}

// --- 5. First six months sick cap ----------------------------------------
{
  check('cap does not apply after 6 months', firstSixMonthsSickCap('2026-01-01', '2026-08-01', 150) === null)
  check('78 days worked in month 3 gives 3 days', firstSixMonthsSickCap('2026-06-01', '2026-08-15', 78) === 3, `got ${firstSixMonthsSickCap('2026-06-01','2026-08-15',78)}`)
  check('25 days worked gives 0, not a fraction', firstSixMonthsSickCap('2026-06-01', '2026-07-01', 25) === 0)

  const newStarter = { id: 'e2', start_date: '2026-07-01', cycle_anchor_date: null }
  const b = leaveBalance({
    employee: newStarter,
    leaveType: 'sick',
    entitlement: ENT.sick,
    leaveRows: [],
    asOf: '2026-09-03',
    workingDaysBetween: () => 46, // ~46 working days since 1 July
  })
  check('a new starter is capped below the full 30', b.entitled === 1, `got ${b.entitled}`)
  check('and the reason is stated rather than silent', typeof b.note === 'string' && b.note.includes('26'))

  // Without an injected working-day function the cap cannot be applied —
  // must fall back to the full entitlement rather than silently zero.
  const noFn = leaveBalance({ employee: newStarter, leaveType: 'sick', entitlement: ENT.sick, leaveRows: [], asOf: '2026-09-03' })
  check('no working-day function means no cap, not a zero balance', noFn.entitled === 30, `got ${noFn.entitled}`)
}

// --- 6. Family responsibility: service qualification and lapsing ---------
{
  const newStarter = { id: 'e3', start_date: '2026-07-01' }
  const b = leaveBalance({ employee: newStarter, leaveType: 'family_responsibility', entitlement: ENT.frl, leaveRows: [], asOf: '2026-09-03' })
  check('under 4 months service is not yet eligible', b.eligible === false)
  check('and is entitled to 0 days', b.entitled === 0, `got ${b.entitled}`)

  const qualified = leaveBalance({ employee: emp, leaveType: 'family_responsibility', entitlement: ENT.frl, leaveRows: [], asOf: '2026-09-03' })
  check('a long-serving employee is eligible', qualified.eligible === true)
  check('and gets 3 days', qualified.entitled === 3, `got ${qualified.entitled}`)
  check('flagged as lapsing, since FRL does not carry over', qualified.lapses === true)

  // Usage in a previous 12-month cycle must not reduce this cycle.
  const rows = [{ employee_id: 'e1', leave_type: 'family_responsibility', start_date: '2025-05-01', days_used: 3 }]
  const thisCycle = leaveBalance({ employee: emp, leaveType: 'family_responsibility', entitlement: ENT.frl, leaveRows: rows, asOf: '2026-09-03' })
  check('last cycle’s FRL does not carry a deficit forward', thisCycle.used === 0 && thisCycle.remaining === 3, `used ${thisCycle.used}`)
}

// --- 7. Maternity: per event, no running balance -------------------------
{
  const rows = [{ employee_id: 'e1', leave_type: 'maternity', start_date: '2025-02-01', days_used: 120 }]
  const b = leaveBalance({ employee: emp, leaveType: 'maternity', entitlement: ENT.maternity, leaveRows: rows, asOf: '2026-09-03' })
  check('maternity has no balance', b.hasBalance === false)
  check('remaining is null, not 0 (0 would imply exhausted)', b.remaining === null)
  check('but usage is still totalled', b.used === 120, `got ${b.used}`)
  check('and it is marked unpaid by the employer', b.paid === false)
  check('the reason is explicit', typeof b.reason === 'string' && b.reason.length > 0)
}

// --- 8. Types do not bleed into each other -------------------------------
{
  const rows = [
    { employee_id: 'e1', leave_type: 'annual', start_date: '2026-05-01', days_used: 5 },
    { employee_id: 'e1', leave_type: 'sick', start_date: '2026-05-02', days_used: 4 },
    { employee_id: 'e1', leave_type: 'family_responsibility', start_date: '2026-05-03', days_used: 1 },
    { employee_id: 'OTHER', leave_type: 'annual', start_date: '2026-05-04', days_used: 9 },
  ]
  const annual = leaveBalance({ employee: emp, leaveType: 'annual', entitlement: ENT.annual, leaveRows: rows, asOf: '2026-09-03' })
  check('annual counts only annual', annual.used === 5, `got ${annual.used}`)
  check('another employee’s leave is excluded', annual.used !== 14)

  const sick = leaveBalance({ employee: emp, leaveType: 'sick', entitlement: ENT.sick, leaveRows: rows, asOf: '2026-09-03' })
  check('sick counts only sick', sick.used === 4, `got ${sick.used}`)

  // Legacy rows written before leave_type existed must count as annual.
  const legacy = [{ employee_id: 'e1', start_date: '2026-05-01', days_used: 7 }]
  const withLegacy = leaveBalance({ employee: emp, leaveType: 'annual', entitlement: ENT.annual, leaveRows: legacy, asOf: '2026-09-03' })
  check('rows with no leave_type are treated as annual', withLegacy.used === 7, `got ${withLegacy.used}`)
}

// --- 9. Per-employee annual override --------------------------------------
{
  const generous = { ...emp, annual_leave_days: 20 }
  const e = entitlementForEmployee(ENT.annual, generous)
  check('per-employee annual override wins', e.days_per_cycle === 20, `got ${e.days_per_cycle}`)

  const zero = entitlementForEmployee(ENT.annual, { ...emp, annual_leave_days: 0 })
  check('0 is treated as unset, not as zero leave', zero.days_per_cycle === 15, `got ${zero.days_per_cycle}`)

  const sickUntouched = entitlementForEmployee(ENT.sick, generous)
  check('the annual override does not leak into sick leave', sickUntouched.days_per_cycle === 30, `got ${sickUntouched.days_per_cycle}`)
}

// --- 10. allBalances ------------------------------------------------------
{
  const list = allBalances({ employee: emp, entitlements: Object.values(ENT), leaveRows: [], asOf: '2026-09-03' })
  check('returns all four types', list.length === 4, `got ${list.length}`)
  check('in sort order', list.map((b) => b.leaveType).join(',') === 'annual,sick,family_responsibility,maternity', list.map((b) => b.leaveType).join(','))
  check('falls back to BCEA when no entitlements are configured', allBalances({ employee: emp, entitlements: [], leaveRows: [], asOf: '2026-09-03' }).length === 4)

  const noStart = allBalances({ employee: { id: 'x' }, entitlements: Object.values(ENT), leaveRows: [], asOf: '2026-09-03' })
  check('an employee with no start date gets no invented balances', noStart.every((b) => b.hasBalance === false))
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`)
  process.exit(1)
}
console.log('All BCEA leave cycle assertions pass.\n')
