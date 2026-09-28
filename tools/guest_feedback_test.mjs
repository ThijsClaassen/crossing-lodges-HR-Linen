// Guest feedback (#487): CSV → rows → weekly department trend + roster
// context. EXECUTED. Plus the framing check: nothing scores a person.
//
//   node tools/guest_feedback_test.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(join(ROOT, f), 'utf8')
let passed = 0
const failures = []
const check = (name, cond, detail) => (cond ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`))

const m = await import('data:text/javascript;base64,' + Buffer.from(read('src/guestFeedback.js')).toString('base64'))

// CSV
const csv = '﻿Response ID,Property,Check-out date,Overall,Food & Beverage,Cleanliness,Game drives,Comments\r\n' +
  '101,Zebras Crossing,24/08/2026,9,9,8,10,"Lovely, ""quiet"" stay"\r\n' +
  '102,Zebras Crossing,26/08/2026,7,6,7,,\r\n' +
  '103,Elephants Crossing,2026-08-25,8,8,9,8,"Multi\nline"\r\n' +
  '104,Zebras Crossing,,5,5,5,5,no date\r\n'
const p = m.parseCsv(csv)
check('csv: BOM stripped, headers trimmed', p.headers[0] === 'Response ID' && p.headers.length === 8)
check('csv: quoted commas, doubled quotes and embedded newlines', p.records[0].Comments === 'Lovely, "quiet" stay' && p.records[2].Comments === 'Multi\nline' && p.records.length === 4)

// mapping guess
const map = m.guessColumnMap(p.headers, p.records)
check('guess: id, date, location, overall, comment', map.id === 'Response ID' && map.stay_date === 'Check-out date' && map.location === 'Property' && map.overall === 'Overall' && map.comment === 'Comments')
check('guess: category columns by words, numeric only', map.categories.food === 'Food & Beverage' && map.categories.housekeeping === 'Cleanliness' && map.categories.activities === 'Game drives' && !map.categories.service)

// normalise
const n = m.normaliseRows(p.records, map, { locationAliases: { 'Zebras Crossing': 'ZC' }, knownLocations: ['ZC', 'EC'] })
check('dates: dd/mm/yyyy and ISO both land as ISO', n.rows[0].stay_date === '2026-08-24' && n.rows[2].stay_date === '2026-08-25')
check('rows without a date are skipped, not guessed', n.rows.length === 3 && n.skipped.length === 1)
check('aliases map lodge names; unknown names are reported, not dropped', n.rows[0].location_id === 'ZC' && n.rows[2].location_id === null && n.unmappedLocations.join() === 'Elephants Crossing')
check('scores keyed by category, blanks omitted', n.rows[0].scores.food === 9 && !('activities' in n.rows[1].scores))
check('raw row kept', n.rows[0].raw['Response ID'] === '101')

// trend
const fb = [
  { location_id: 'ZC', stay_date: '2026-08-24', overall: 9, scores: { food: 9, housekeeping: 8 } },   // Mon 24 Aug week
  { location_id: 'ZC', stay_date: '2026-08-26', overall: 7, scores: { food: 6, housekeeping: 7 } },
  { location_id: 'ZC', stay_date: '2026-08-30', overall: 8, scores: { food: 8 } },                    // Sun → still week of 24 Aug
  { location_id: 'ZC', stay_date: '2026-08-31', overall: 10, scores: { food: 10 } },                  // Mon 31 Aug
  { location_id: 'EC', stay_date: '2026-08-25', overall: 8, scores: { housekeeping: 9 } },
]
check('mondayOf: Sunday belongs to the week starting the previous Monday', m.mondayOf('2026-08-30') === '2026-08-24' && m.mondayOf('2026-08-31') === '2026-08-31')
const t = m.weeklyTrend(fb, { locationId: 'ZC' })
check('trend: two ZC weeks, averages to 1 dp with counts', t.length === 2 && t[0].week === '2026-08-24' && t[0].responses === 3 && t[0].overall === 8 && t[0].categories.food.avg === 7.7 && t[0].categories.food.n === 3 && t[0].categories.housekeeping.n === 2)
check('trend: all lodges when unfiltered, sorted lodge then week', m.weeklyTrend(fb).map((w) => `${w.location_id}:${w.week}`).join() === 'EC:2026-08-24,ZC:2026-08-24,ZC:2026-08-31')

// roster
const employees = [
  { id: 'e1', first_name: 'Sipho', last_name: 'N', department: 'Housekeeping' },
  { id: 'e2', first_name: 'Anna', last_name: 'B', department: 'Kitchen' },
  { id: 'e3', first_name: 'Thabo', last_name: 'M', department: 'Housekeeping' },
]
const sched = [
  { employee_id: 'e1', week_start_date: '2026-08-24', location_id: 'ZC' },
  { employee_id: 'e3', week_start_date: '2026-08-24', location_id: 'ZC' },
  { employee_id: 'e2', week_start_date: '2026-08-24', location_id: 'EC' },
  { employee_id: 'e2', week_start_date: '2026-08-31', location_id: 'ZC' },
]
const r = m.rosterForWeek(sched, employees, { locationId: 'ZC', week: '2026-08-24' })
check('roster: grouped by department, names only, sorted', JSON.stringify(r) === JSON.stringify({ Housekeeping: ['Sipho N', 'Thabo M'] }))

// department trend for the pack
const cd = { food: 'Kitchen', housekeeping: 'Housekeeping' }
check('categoriesForDepartment is case-insensitive', m.categoriesForDepartment(cd, 'housekeeping').join() === 'housekeeping')
const dt = m.departmentTrend({ feedback: fb, categoryDepartments: cd, department: 'Kitchen', employeeId: 'e2', scheduleLocations: sched, from: '2026-08-01', to: '2026-09-30' })
check('department trend: only the lodges/weeks the person was rostered (Anna: EC wk24 has no food; ZC wk31 has 10)', dt.categories.join() === 'food' && dt.months.length === 1 && dt.months[0].avg === 10 && dt.months[0].n === 1)
check('no category for the department → empty, no guessing', m.departmentTrend({ feedback: fb, categoryDepartments: cd, department: 'Guiding', employeeId: 'e9', scheduleLocations: sched }).categories.length === 0)
const noSched = m.departmentTrend({ feedback: fb, categoryDepartments: cd, department: 'Kitchen', employeeId: 'e9', scheduleLocations: [], from: '2026-08-01', to: '2026-09-30' })
check('no roster rows at all → whole company (nothing to narrow by)', noSched.months[0].n === 4)

// framing: nothing scores a person
const src = read('src/guestFeedback.js') + read('src/App.jsx').slice(read('src/App.jsx').indexOf('function GuestFeedbackTab'))
// The GUEST feedback half of the module never scores a person. (The member
// reviews half, added for #519, deliberately does — a member rated a named
// employee's visit to their own plot — and lives after its own header.)
const guestHalf = read('src/guestFeedback.js').split('// --- Member reviews of staff visits')[0]
check('no per-employee score anywhere in guest feedback', !/employee.*score|score.*employee_id/i.test(guestHalf))
check('the roster is labelled as context, not a finding', /context for the department's score, not a finding about anyone/.test(src))
check('the appraisal pack says so too', /not a person's score/.test(read('src/App.jsx')) && /not the person/.test(read('src/appraisal.js')))

// SQL
const sql = read('add_guest_feedback.sql').replace(/--[^\n]*/g, '')
check('guest_feedback keyed by external id per company for re-imports', /guest_feedback_external_idx on guest_feedback \(company_id, external_id\);/.test(sql))
check('settings hold column map, category→department, lodge aliases', /column_map\s+jsonb/.test(sql) && /category_departments jsonb/.test(sql) && /location_aliases\s+jsonb/.test(sql))
check('the investigation result is on record in the migration header', /no outbound API/.test(read('add_guest_feedback.sql')))

// GuestRevu API feed (#527, 2026-09-28): the panel on the tab, and the CSV import demoted to a fallback.
{
  const app = read('src/App.jsx')
  const panel = app.slice(app.indexOf('function GuestRevuSyncPanel('), app.indexOf('function GuestFeedbackTab('))
  check('panel is mounted above the CSV import, which is now the fallback', /<GuestRevuSyncPanel /.test(app) && /Import a GuestRevu export \(fallback\)/.test(app) && !/GuestRevu has no customer API/.test(app))
  check('property ids map to lodges and are saved on guest_feedback_settings.guestrevu_accounts', /guestrevu_accounts: next/.test(panel) && /GuestRevu property \{id\} is/.test(panel))
  check('calls the guestrevu-sync Edge Function with the user token; never sends credentials', /functions\/v1\/guestrevu-sync/.test(panel) && /Authorization: `Bearer \$\{session\?\.access_token\}`/.test(panel) && !/md5/i.test(panel))
  check('three actions: test (writes nothing), sync now, full history behind a confirm', /call\('test'\)/.test(panel) && /call\('sync'\)/.test(panel) && /window\.confirm\([\s\S]*?call\('sync', \{ mode: 'full' \}\)/.test(panel))
  check('shows last run from guest_feedback_sync_log and the nightly switch from scheduled_syncs', /guest_feedback_sync_log/.test(panel) && /job: 'guestrevu'/.test(panel) && /Pause nightly/.test(panel))
  check('test result lists sources, unmapped questions and a mapped preview', /unmapped_questions/.test(panel) && /average_review_rating/.test(panel) && /Nothing was written/.test(panel))
  check('sb.select supports limit (used for the run log)', /if \(opts\.limit\) params\.limit = opts\.limit/.test(read('src/sb.js')))
}

console.log(`guest_feedback_test: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
