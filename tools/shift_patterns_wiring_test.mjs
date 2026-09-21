// Does the pattern engine actually drive the app? (#453)
//
//   node tools/shift_patterns_wiring_test.mjs
//
// The arithmetic is tested in tools/shift_patterns_test.mjs. This checks the
// wiring, and the failure it exists for is a specific one:
//
//   the engine is correct, but ONE of the three places that ask "is this
//   person working" still uses the old hardcoded 21/7 — so the grid shows a
//   fixed-week cleaner one way and her leave is charged the other way, and
//   the two never appear on the same screen to contradict each other.
//
// There are exactly three such places: the schedule grid, the "today" badge
// on the employee list, and the leave day count. All three must go through
// the engine, and no copy of the old constants may survive anywhere.

import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const traverse = traverseModule.default || traverseModule
const here = dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(join(here, '..', 'src', f), 'utf8')

let passed = 0
const failures = []
const check = (name, cond, detail) =>
  cond ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`)

const APP = read('App.jsx')
const LEAVE = read('leaveEngine.js')
const ENGINE = read('shiftPatterns.js')

let ast
try {
  ast = parse(APP, { sourceType: 'module', plugins: ['jsx'] })
  passed++
} catch (e) {
  console.log(`\n0 passed, 1 failed\n  FAIL: App.jsx does not parse — ${e.message}`)
  process.exit(1)
}

// --- 1. THE OLD LOGIC IS GONE, not merely bypassed ------------------------
//
// A surviving copy of the constants is the thing that would let one call site
// quietly keep the old behaviour.
check(
  'the hardcoded cycle constants are gone from App.jsx',
  !/const CYCLE_ON_DAYS\s*=/.test(APP) && !/const CYCLE_LENGTH\s*=/.test(APP),
  'a surviving copy is how one call site keeps the old behaviour while the others move',
)
check(
  'and 21/7 appears only in the engine, as the documented fallback',
  /on_days: 21/.test(ENGINE),
)
check(
  'App.jsx imports the engine',
  /from '\.\/shiftPatterns\.js'/.test(APP),
)

// --- 2. ALL THREE STATUS QUESTIONS GO THROUGH THE ENGINE ------------------
//
// Read from the parsed program: every call to the two status helpers must
// pass a patterns map, not just an anchor date. The old signature took
// (anchorDate, date) — a call still shaped that way is a call that ignores
// patterns entirely.
{
  const calls = []
  traverse(ast, {
    CallExpression: (p) => {
      const callee = p.node.callee
      if (callee.type !== 'Identifier') return
      if (!['cycleStatusForDate', 'countWorkingDaysInRange'].includes(callee.name)) return
      // Skip the definitions themselves.
      calls.push({
        name: callee.name,
        args: p.node.arguments.map((a) =>
          a.type === 'Identifier' ? a.name : a.type === 'MemberExpression' ? 'member' : a.type,
        ),
        line: p.node.loc?.start.line,
      })
    },
  })

  check('the status helpers are actually called', calls.length >= 3, `found ${calls.length}`)

  const wrongShape = calls.filter((c) => !c.args.includes('patternsById'))
  check(
    'EVERY status call resolves a pattern',
    wrongShape.length === 0,
    wrongShape.map((c) => `${c.name} at line ${c.line}`).join(', ') +
      ' — a call without patternsById uses whatever the engine defaults to and ignores the person',
  )

  const statusCalls = calls.filter((c) => c.name === 'cycleStatusForDate')
  check(
    'both the grid and the today badge ask',
    statusCalls.length >= 2,
    `found ${statusCalls.length} — the schedule grid and the employee list each need one`,
  )
}

// --- 3. LEAVE. The engine drives the day count AND the BCEA balances ------
check(
  'the leave day count resolves a pattern',
  /countWorkingDaysInRange\(emp, patternsById/.test(APP),
  'this is the figure stored on the leave row — get it wrong and a balance is wrong forever',
)
check(
  'the balance calculation is given an adapter, not the raw helper',
  /workingDaysBetween: \(employee, start, end\) =>/.test(APP),
)
check(
  'and leaveEngine hands it the employee rather than an anchor date',
  /workingDaysBetween\(employee, startDate, asOfISO\)/.test(LEAVE),
  'passing the anchor alone cannot express which pattern applies',
)

// --- 4. THE MIGRATION PROMISE ---------------------------------------------
//
// An employee with no pattern must behave exactly as before. That is a
// property of the engine, tested next door — what matters here is that the
// app does not defeat it by refusing to render anyone without a pattern.
check(
  'the pattern dropdown offers "no pattern" and says what it means',
  /No pattern set — 21 on \/ 7 off/.test(APP),
)
check(
  'the page states that nobody moves until they are reassigned',
  /nobody&rsquo;s schedule changes until you move them/.test(APP),
)

// --- 5. A fixed-week employee is not asked for a date that does nothing ---
check(
  'the cycle start field is hidden for a fixed-week pattern',
  /pattern\.kind === 'fixed_week' \?/.test(APP),
  'an input with no effect is worse than no input — somebody will fill it in and expect something to happen',
)
check(
  'and a rotation missing its date says so',
  /missingSetup/.test(APP) && /no on\/off can be worked out/.test(APP),
)

// --- 6. The patterns are fetched, and their absence is survivable ---------
check('the app fetches the patterns', /from\('hr_shift_patterns'|'hr_shift_patterns'/.test(APP))
check(
  'and a company that has not run the migration still loads',
  /hr_shift_patterns[\s\S]{0,200}?\.catch\(\(\) => \[\]\)/.test(APP),
  'without the catch, every HR user of an unmigrated company sees a blank app',
)

// --- 7. The date convention lives in one place ----------------------------
check(
  'App.jsx does not define its own date parser any more',
  !/^function parseDateOnly/m.test(APP),
  'two copies of a date convention is two chances to drift, and a day of drift moves somebody’s off day',
)
check('it imports them instead', /parseDateOnly,\n\s*fmtDateOnly,/.test(APP))

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  failures.forEach((f) => console.log(`  FAIL: ${f}`))
  process.exit(1)
}
