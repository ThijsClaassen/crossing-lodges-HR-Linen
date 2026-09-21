// Behavioural test for src/shiftPatterns.js (#453).
//
//   node tools/shift_patterns_test.mjs
//
// A wrong answer here does not look wrong. It puts somebody on duty on their
// off day, or charges them leave for a day they were never going to work, and
// it surfaces months later as a balance nobody can reconcile. The cases below
// are the ways that happens:
//
//   - an employee with no pattern silently getting a DIFFERENT schedule from
//     the one they had before patterns existed
//   - a date before the anchor reading as on duty, because JavaScript's %
//     keeps the sign of the dividend
//   - a rotation with no anchor guessing rather than declining to answer
//   - leave costing days the person was already off

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const P = await import(
  'data:text/javascript;base64,' +
    Buffer.from(readFileSync(join(ROOT, 'src', 'shiftPatterns.js'), 'utf8')).toString('base64')
)

let passed = 0
const failures = []
const check = (name, cond, detail) =>
  cond ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
const eq = (name, got, want) =>
  check(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)

const d = (iso) => P.parseDateOnly(iso)
const statusOn = (pattern, anchor, iso) => P.statusForDate(pattern, anchor, d(iso)).status

// ---------------------------------------------------------------------------
// 1. THE COMPATIBILITY PROPERTY. No pattern must mean exactly the old
// behaviour: 21 on, 7 off, from the anchor. If this breaks, deploying the
// feature rewrites the roster of everyone not yet migrated.
{
  const anchor = '2026-09-01' // day 1 of a block
  // Days 1..21 on.
  eq('day 1 of the cycle is on', statusOn(null, anchor, '2026-09-01'), 'on')
  eq('day 21 is still on', statusOn(null, anchor, '2026-09-21'), 'on')
  // Days 22..28 off.
  eq('day 22 is the first off day', statusOn(null, anchor, '2026-09-22'), 'off')
  eq('day 28 is the last off day', statusOn(null, anchor, '2026-09-28'), 'off')
  // Day 29 starts the next block.
  eq('day 29 starts the next block', statusOn(null, anchor, '2026-09-29'), 'on')

  eq(
    'an employee with no pattern resolves to the legacy rotation',
    P.patternFor({ shift_pattern_id: null }, {}).name,
    P.LEGACY_ROTATION.name,
  )
  eq(
    'and so does one pointing at a pattern that no longer exists',
    P.patternFor({ shift_pattern_id: 'deleted-id' }, {}).on_days,
    21,
  )
}

// The block start is the date the current stretch began — used to label a
// stretch in the grid.
{
  const info = P.statusForDate(P.LEGACY_ROTATION, '2026-09-01', d('2026-09-10'))
  eq('block start points back to the first day on', info.blockStart, '2026-09-01')
  const off = P.statusForDate(P.LEGACY_ROTATION, '2026-09-01', d('2026-09-25'))
  eq('an off day carries no block start', off.blockStart, undefined)
}

// ---------------------------------------------------------------------------
// 2. DATES BEFORE THE ANCHOR. The grid scrolls backwards, so these are real.
// `diffDays % length` is NEGATIVE here, and a negative phase compared against
// on_days reads as on duty — the wrap is what stops that.
{
  const anchor = '2026-09-01'
  // 1 day before the anchor is the last day of the preceding off stretch.
  eq('the day before the anchor is off', statusOn(null, anchor, '2026-08-31'), 'off')
  // 7 days before the anchor is the FIRST day of the preceding off stretch
  // (phase 21), and 8 days before is the last working day of the previous
  // block (phase 20). Worth spelling out: I had these one day apart on the
  // first attempt, which is exactly the off-by-one this test exists to catch.
  eq('seven days before is off', statusOn(null, anchor, '2026-08-25'), 'off')
  eq('eight days before is back on duty', statusOn(null, anchor, '2026-08-24'), 'on')
  // A full cycle before the anchor is day 1 of that cycle.
  eq('exactly one cycle before is day 1 again', statusOn(null, anchor, '2026-08-04'), 'on')
}

// ---------------------------------------------------------------------------
// 3. A ROTATION WITHOUT AN ANCHOR DECLINES TO ANSWER.
{
  eq('no anchor means no status', statusOn(P.LEGACY_ROTATION, null, '2026-09-10'), 'none')
  eq('empty string is not an anchor either', statusOn(P.LEGACY_ROTATION, '', '2026-09-10'), 'none')
  eq(
    'and it counts no working days, so leave costs nothing',
    P.workingDaysInRange(P.LEGACY_ROTATION, null, '2026-09-01', '2026-09-30'),
    0,
  )
  check(
    'the UI can say which thing is missing',
    P.missingSetup({ cycle_anchor_date: null }, P.LEGACY_ROTATION) === 'no cycle start date set',
  )
}

// A zero-length rotation would divide by zero and put everyone on duty
// forever. It is treated as unset, not as a working pattern.
{
  const broken = { kind: 'rotation', on_days: 0, off_days: 0 }
  eq('a zero-length rotation has no status', statusOn(broken, '2026-09-01', '2026-09-10'), 'none')
}

// ---------------------------------------------------------------------------
// 4. OTHER ROTATION LENGTHS.
{
  const p = { kind: 'rotation', on_days: 14, off_days: 7 } // 21-day cycle
  const anchor = '2026-09-01'
  eq('14/7: day 14 is on', statusOn(p, anchor, '2026-09-14'), 'on')
  eq('14/7: day 15 is off', statusOn(p, anchor, '2026-09-15'), 'off')
  eq('14/7: day 21 is off', statusOn(p, anchor, '2026-09-21'), 'off')
  eq('14/7: day 22 starts the next block', statusOn(p, anchor, '2026-09-22'), 'on')

  const six = { kind: 'rotation', on_days: 6, off_days: 1 }
  eq('6/1: the seventh day is off', statusOn(six, anchor, '2026-09-07'), 'off')
  eq('6/1: the eighth is back on', statusOn(six, anchor, '2026-09-08'), 'on')
}

// ---------------------------------------------------------------------------
// 5. FIXED WEEKDAY PATTERNS. No anchor, ever.
{
  // 2026-09-20 is a Sunday; 2026-09-21 a Monday.
  eq('a Sunday sanity check', d('2026-09-20').getDay(), 0)

  const sundaysOff = { kind: 'fixed_week', days_off: [0] }
  eq('off on Sunday', statusOn(sundaysOff, null, '2026-09-20'), 'off')
  eq('on every other day', statusOn(sundaysOff, null, '2026-09-21'), 'on')
  eq(
    'and it needs no anchor at all',
    statusOn(sundaysOff, null, '2026-09-27'),
    'off',
    'a fixed-week employee has a knowable status without a cycle start date — that is the whole point',
  )
  check('so nothing is reported as missing', P.missingSetup({ cycle_anchor_date: null }, sundaysOff) === null)

  const weekendOff = { kind: 'fixed_week', days_off: [0, 6] }
  eq('Saturday off', statusOn(weekendOff, null, '2026-09-19'), 'off')
  eq('Sunday off', statusOn(weekendOff, null, '2026-09-20'), 'off')
  eq('Monday on', statusOn(weekendOff, null, '2026-09-21'), 'on')

  // A fixed-week pattern with no days off is legitimate but worth saying out
  // loud rather than rendering as a blank.
  const noneOff = { kind: 'fixed_week', days_off: [] }
  eq('no days off means working every day', statusOn(noneOff, null, '2026-09-20'), 'on')
  check('and the description says so', /no days off/.test(P.describePattern(noneOff)))
}

// ---------------------------------------------------------------------------
// 6. LEAVE COST. Days already off cost nothing — this is what a balance is
// built from.
{
  const anchor = '2026-09-01' // on 1-21, off 22-28
  // A week wholly inside the working block.
  eq(
    'a week on duty costs seven days',
    P.workingDaysInRange(null, anchor, '2026-09-07', '2026-09-13'),
    7,
  )
  // A week wholly inside the off stretch.
  eq(
    'a week that was already off costs nothing',
    P.workingDaysInRange(null, anchor, '2026-09-22', '2026-09-28'),
    0,
  )
  // Straddling the boundary: 19,20,21 on + 22..25 off.
  eq(
    'a straddling request only charges the working days',
    P.workingDaysInRange(null, anchor, '2026-09-19', '2026-09-25'),
    3,
  )
  // Single day.
  eq('one working day costs one', P.workingDaysInRange(null, anchor, '2026-09-10', '2026-09-10'), 1)
  eq('one off day costs nothing', P.workingDaysInRange(null, anchor, '2026-09-25', '2026-09-25'), 0)

  const sundaysOff = { kind: 'fixed_week', days_off: [0] }
  eq(
    'a fixed-week fortnight costs twelve days, not fourteen',
    P.workingDaysInRange(sundaysOff, null, '2026-09-14', '2026-09-27'),
    12,
  )
}

// A reversed range returns 0 rather than spinning.
{
  eq('a reversed range costs nothing', P.workingDaysInRange(null, '2026-09-01', '2026-09-10', '2026-09-05'), 0)
}

// ---------------------------------------------------------------------------
// 7. DESCRIPTIONS — what the reader sees in a dropdown.
eq('a rotation reads as its numbers', P.describePattern({ kind: 'rotation', on_days: 21, off_days: 7 }), '21 on / 7 off')
eq(
  'a fixed week names its days',
  P.describePattern({ kind: 'fixed_week', days_off: [0, 3] }),
  'Off Sunday, Wednesday',
)
eq(
  'days are named in week order regardless of how they were stored',
  P.describePattern({ kind: 'fixed_week', days_off: [3, 0] }),
  'Off Sunday, Wednesday',
)
eq('no pattern describes the legacy one', P.describePattern(null), '21 on / 7 off')

// ---------------------------------------------------------------------------
// 8. DATE PARSING. The convention that must not drift.
{
  const parsed = P.parseDateOnly('2026-09-21')
  eq('parses to local midnight, not UTC', parsed.getDate(), 21)
  eq('and the month is right', parsed.getMonth(), 8)
  eq('round-trips', P.fmtDateOnly(parsed), '2026-09-21')
  eq('addDays crosses a month boundary', P.fmtDateOnly(P.addDays(parsed, 10)), '2026-10-01')
  eq('and goes backwards', P.fmtDateOnly(P.addDays(parsed, -21)), '2026-08-31')
}

// ---------------------------------------------------------------------------
// 9. ROSTERED EXTRA DAYS (#458). Local staff are off every Sunday PLUS three
// days a month that somebody picks. Those three are a decision, not a rule,
// so they sit on top of the pattern rather than inside it.
{
  const sundaysOff = { kind: 'fixed_week', days_off: [0] }
  // 2026-09-21 is a Monday, 2026-09-20 a Sunday.
  const roster = new Set(['2026-09-23', '2026-09-24'])

  eq(
    'a rostered day turns a working day off',
    P.statusForDate(sundaysOff, null, d('2026-09-23'), roster).status,
    'off',
  )
  eq(
    'and says it came from the roster',
    P.statusForDate(sundaysOff, null, d('2026-09-23'), roster).reason,
    'rostered',
  )
  eq(
    'a day not on the roster is unaffected',
    P.statusForDate(sundaysOff, null, d('2026-09-22'), roster).status,
    'on',
  )
  eq(
    'the weekly day off still applies',
    P.statusForDate(sundaysOff, null, d('2026-09-20'), roster).status,
    'off',
  )
  eq(
    'and an ordinary off day is NOT labelled as rostered',
    P.statusForDate(sundaysOff, null, d('2026-09-20'), roster).reason,
    undefined,
  )

  // Omitting the roster entirely must behave exactly as before it existed —
  // every call site that has not been updated keeps working.
  eq(
    'no roster argument means no change',
    P.statusForDate(sundaysOff, null, d('2026-09-23')).status,
    'on',
  )
}

// A roster can only take days away, never give them back.
{
  const sundaysOff = { kind: 'fixed_week', days_off: [0] }
  const roster = new Set(['2026-09-20']) // a Sunday, already off
  eq(
    'rostering an already-off day leaves it off',
    P.statusForDate(sundaysOff, null, d('2026-09-20'), roster).status,
    'off',
  )
  check(
    'and the UI can warn that the day was wasted',
    P.rosteredDayIsRedundant(sundaysOff, null, d('2026-09-20')) === true,
    'a day given off that was already off is a day the person loses without noticing',
  )
  check(
    'while a real working day is not flagged',
    P.rosteredDayIsRedundant(sundaysOff, null, d('2026-09-23')) === false,
  )
}

// It works on a rotation too, including one with no anchor — where the
// pattern itself cannot answer but a rostered day still can.
{
  const roster = new Set(['2026-09-10'])
  eq(
    'a rostered day off inside a working block',
    P.statusForDate(null, '2026-09-01', d('2026-09-10'), roster).status,
    'off',
  )
  eq(
    'and it answers even when the rotation cannot',
    P.statusForDate(P.LEGACY_ROTATION, null, d('2026-09-10'), roster).status,
    'off',
    'a rostered day is a fact about that date, not a calculation from an anchor',
  )
  // The mirror of the fixed-week assertion above, on the ROTATION path. The
  // first version of this test only checked the fixed-week branch, so
  // labelling every rotation off day as rostered passed — the two branches
  // need the same assertion, not one between them.
  eq(
    "a rotation's own off day is not labelled rostered",
    P.statusForDate(null, '2026-09-01', d('2026-09-25'), roster).reason,
    undefined,
    'otherwise every off day in a 21/7 cycle claims somebody chose it, and the three real ones become impossible to find',
  )
  eq(
    'nor is a working day',
    P.statusForDate(null, '2026-09-01', d('2026-09-10')).reason,
    undefined,
  )
}

// LEAVE. A request spanning a rostered day must not charge it — the same
// rule as an off-cycle day, on a different axis.
{
  const sundaysOff = { kind: 'fixed_week', days_off: [0] }
  const roster = new Set(['2026-09-23'])
  eq(
    'without the roster, a Mon-Fri week costs five days',
    P.workingDaysInRange(sundaysOff, null, '2026-09-21', '2026-09-25'),
    5,
  )
  eq(
    'with one rostered day in it, four',
    P.workingDaysInRange(sundaysOff, null, '2026-09-21', '2026-09-25', roster),
    4,
  )
  eq(
    'a fortnight with Sundays and three rostered days costs nine',
    P.workingDaysInRange(
      sundaysOff,
      null,
      '2026-09-14',
      '2026-09-27',
      new Set(['2026-09-16', '2026-09-23', '2026-09-25']),
    ),
    9,
    '14 days minus 2 Sundays minus 3 rostered = 9',
  )
}

// Grouping rows by employee.
{
  const map = P.rosteredOffByEmployee([
    { employee_id: 'a', off_date: '2026-09-23' },
    { employee_id: 'a', off_date: '2026-09-24' },
    { employee_id: 'b', off_date: '2026-09-23' },
    { employee_id: null, off_date: '2026-09-23' },
    { employee_id: 'c', off_date: null },
  ])
  eq('two employees have rostered days', Object.keys(map).length, 2)
  eq('and the right number each', map.a.size, 2)
  check('rows with no employee are dropped', !map[null] && !map.undefined)
  check('and rows with no date', !map.c)
  check('timestamps are trimmed to a date', P.rosteredOffByEmployee([{ employee_id: 'a', off_date: '2026-09-23T00:00:00Z' }]).a.has('2026-09-23'))
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  failures.forEach((f) => console.log(`  FAIL: ${f}`))
  process.exit(1)
}
