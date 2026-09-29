// dates_test.mjs — calendar dates must not drift with the time zone (added
// 2026-09-29, same rule as the Finance Dashboard). Runs itself under a
// Johannesburg clock: that is where toISOString() reads a local midnight
// as the day before.
//   node tools/dates_test.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
if (process.env.TZ !== 'Africa/Johannesburg') {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, TZ: 'Africa/Johannesburg' }, encoding: 'utf8' })
  process.stdout.write(r.stdout)
  process.stderr.write(r.stderr)
  process.exit(r.status)
}
let passed = 0
const failures = []
const check = (name, ok, detail) => (ok ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`))

const { isoDate, todayIso, addDaysIso } = await import('../src/dates.js')
check('a Date built at local midnight stays on its own day', isoDate(new Date(2026, 8, 30)) === '2026-09-30')
check('01:00 local is still today, not yesterday', isoDate(new Date(2026, 8, 29, 1, 0)) === '2026-09-29')
check('todayIso is the local calendar date', todayIso() === isoDate(new Date()))
check('addDaysIso steps one calendar day, across month and leap-year ends', addDaysIso('2026-09-30', 1) === '2026-10-01' && addDaysIso('2026-03-01', -1) === '2026-02-28' && addDaysIso('2028-02-28', 1) === '2028-02-29')
check('the old form really did drift here (why this file exists)', new Date(2026, 9, 0).toISOString().slice(0, 10) === '2026-09-29')

// HR-specific: the places where the drift actually changed a result.
const { utcIsoDate } = await import('../src/dates.js')
check('utcIsoDate reads a UTC-built date back in UTC', utcIsoDate(new Date(Date.UTC(2026, 8, 28))) === '2026-09-28')
const cov = await import('../src/staffingCoverageEngine.js')
const nights = cov.guestsByLodgeAndDate([{ location_id: 'ZC', arrival_date: '2026-09-28', departure_date: '2026-09-30', nights: 2, bed_nights: 4, reservation_status: 'Confirmed' }])
check('staffing coverage: a guest arriving on the 28th is in-house on the 28th and 29th (was keyed a day early)', JSON.stringify(Object.keys(nights).sort()) === JSON.stringify(['ZC|2026-09-28', 'ZC|2026-09-29']), JSON.stringify(nights))
const q = await import('../src/qualifications.js')
check('qualifications: at 01:00 a licence expiring tomorrow is 1 day away, not 2', q.daysToExpiry({ expires_on: '2026-09-30' }, new Date(2026, 8, 29, 1, 0)) === 1)
const gf = await import('../src/guestFeedback.js')
check('guest feedback: "28 Sep 2026" reads as the 28th; weeks start on Monday', gf.toIsoDate('28 Sep 2026') === '2026-09-28' && gf.mondayOf('2026-10-01') === '2026-09-28')
const sc = readFileSync(join(ROOT, 'src', 'staffCostEngine.js'), 'utf8')
check('staff cost: week keys are Mondays in local time, matching hr_schedule_locations.week_start_date', /d\.setDate\(d\.getDate\(\) \+ diff\)\n  return isoDate\(d\)/.test(sc))

const offenders = readdirSync(join(ROOT, 'src'))
  .filter((f) => /\.jsx?$/.test(f) && f !== 'dates.js')
  .filter((f) => /\.toISOString\(\)(\.slice\(0, ?(7|10)\)|\.split\('T'\))/.test(readFileSync(join(ROOT, 'src', f), 'utf8').replace(/\/\/[^\n]*/g, '')))
check('no file derives a calendar date from toISOString() (use isoDate / todayIso)', offenders.length === 0, offenders.join(', '))

console.log(`dates_test: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
