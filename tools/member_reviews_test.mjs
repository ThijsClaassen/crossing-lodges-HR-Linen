// Member reviews of staff visits (#519, 2026-09-28): the LL members rate a
// named employee's visit; the appraisal shows the person's own averages,
// floored at 3 reviews, next to the department's. EXECUTED.
//
//   node tools/member_reviews_test.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(join(ROOT, f), 'utf8')
let passed = 0
const failures = []
const check = (name, cond, detail) => (cond ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`))

const m = await import('data:text/javascript;base64,' + Buffer.from(read('src/guestFeedback.js')).toString('base64'))
const a = await import('data:text/javascript;base64,' + Buffer.from(read('src/appraisal.js')).toString('base64'))

const Q = [
  { key: 'overall', label: 'Overall', sort_order: 4 },
  { key: 'quality', label: 'Quality of the work', sort_order: 1 },
  { key: 'old', label: 'Retired one', sort_order: 2, active: false },
]
const EMP = [
  { id: 'anna', first_name: 'Anna', last_name: 'M', department: 'Housekeeping' },
  { id: 'ben', first_name: 'Ben', last_name: 'K', department: 'Housekeeping' },
  { id: 'carl', first_name: 'Carl', last_name: 'P', department: 'Garden' },
]
const R = (emp, date, scores, comment) => ({ id: `${emp}-${date}`, employee_id: emp, visit_date: date, scores, comment })
const REVIEWS = [
  R('anna', '2026-09-01', { quality: 5, overall: 5 }, 'Spotless.'),
  R('anna', '2026-09-08', { quality: 4, overall: 4 }),
  R('anna', '2026-10-02', { quality: 3, overall: 3, old: 1 }, 'Rushed today.'),
  R('ben', '2026-09-03', { quality: 2, overall: 2 }, 'Late.'),
  R('ben', '2026-09-10', { quality: 4, overall: 4 }),
  R('carl', '2026-09-05', { quality: 5, overall: 5 }),
  R('anna', '2025-12-30', { quality: 1, overall: 1 }),   // outside the period
]

// --- the maths ------------------------------------------------------------------
const anna = m.memberFeedback({ reviews: REVIEWS, questions: Q, employeeId: 'anna', department: 'Housekeeping', employees: EMP, from: '2026-01-01', to: '2026-12-31' })
check('active questions only, in sort order', anna.questions.map((q) => q.key).join() === 'quality,overall')
check('period filter applies (the 2025 review is out)', anna.employee.n === 3)
check('with 3 reviews the personal averages show', anna.employee.shown === true && anna.employee.avg.quality === 4 && anna.employee.overall === 3.8, JSON.stringify(anna.employee))
check('a retired question still counts toward the review overall', m.reviewOverall({ quality: 3, overall: 3, old: 1 }) === 2.3)
check('department = same department only, no floor (Anna + Ben = 5)', anna.department.n === 5 && anna.department.name === 'Housekeeping' && anna.department.avg.quality === 3.6, JSON.stringify(anna.department))
check('monthly trend of the person\'s overall', anna.months.map((x) => `${x.month}:${x.avg}/${x.n}`).join() === '2026-09:4.5/2,2026-10:2.3/1')
check('comments newest first, with the visit overall', anna.comments.length === 2 && anna.comments[0].date === '2026-10-02' && anna.comments[0].overall === 2.3)

const ben = m.memberFeedback({ reviews: REVIEWS, questions: Q, employeeId: 'ben', department: 'Housekeeping', employees: EMP, from: '2026-01-01', to: '2026-12-31' })
check('under the floor: count kept, figures withheld, no monthly trend', ben.employee.n === 2 && ben.employee.shown === false && ben.employee.avg.quality === null && ben.employee.overall === null && ben.months.length === 0)
check('the department line still shows for someone under the floor', ben.department.n === 5 && ben.department.overall != null)
check('floor is a parameter', m.memberFeedback({ reviews: REVIEWS, questions: Q, employeeId: 'ben', department: 'Housekeeping', employees: EMP, minCount: 2 }).employee.shown === true)
check('no reviews at all is empty, not a crash', m.memberFeedback({ reviews: [], questions: Q, employeeId: 'x', department: 'Y' }).employee.n === 0)

// --- the pack --------------------------------------------------------------------
const base = { employee: { id: 'anna', first_name: 'Anna', last_name: 'M', department: 'Housekeeping' }, contract: null, position: 'Housekeeper', requirements: null, from: '2026-01-01', to: '2026-12-31', asOf: '2026-12-31' }
const pack = a.buildAppraisalPack({ ...base, memberFeedback: anna })
check('pack carries the member feedback', pack.memberFeedback && pack.memberFeedback.employee.n === 3)
const html = a.appraisalHtml(pack, { companyName: 'LL' })
check('pack prints the section with both columns', /Member reviews of visits/.test(html) && /<th style="width:auto" class="n">Anna M<\/th><th style="width:auto" class="n">Department<\/th>/.test(html))
check('pack prints the averages, not the comments', /Quality of the work<\/td><td class="n">4<\/td><td class="n">3\.6/.test(html) && !/Spotless/.test(html) && !/Rushed/.test(html))
const packBen = a.buildAppraisalPack({ ...base, employee: { ...base.employee, id: 'ben', first_name: 'Ben', last_name: 'K' }, memberFeedback: ben })
const htmlBen = a.appraisalHtml(packBen, {})
check('under the floor the pack says so and withholds the personal column', /fewer than 3, so no personal figure is shown/.test(htmlBen) && /<td class="n">·<\/td>/.test(htmlBen))
check('no member feedback → no section', !/Member reviews of visits/.test(a.appraisalHtml(a.buildAppraisalPack({ ...base }), {})))
check('a company with questions but no reviews yet → no section either', !a.buildAppraisalPack({ ...base, memberFeedback: m.memberFeedback({ reviews: [], questions: Q, employeeId: 'anna', department: 'Housekeeping', employees: EMP }) }).memberFeedback)

// --- wiring -----------------------------------------------------------------------
const app = read('src/App.jsx')
check('loads reviews and questions, tolerant of the migration not having run', /sb\.select\('member_visit_reviews'[\s\S]{0,120}\.catch\(\(\) => \[\]\)/.test(app) && /sb\.select\('member_review_questions'[\s\S]{0,120}\.catch\(\(\) => \[\]\)/.test(app))
check('appraisal pack gets memberFeedback for the employee', /memberFeedback: memberFeedback\(\{ reviews: memberReviews, questions: reviewQuestions, employeeId: employee\.id, department: employee\.department, employees, from, to \}\)/.test(app))
check('appraisal screen shows the card', /Member reviews of visits<\/div>/.test(app))
check('Guest Feedback tab gets the panel, comments and the question editor', /<MemberReviewsPanel /.test(app) && /What members wrote/.test(app) && /Edit questions/.test(app) && /Retire/.test(app) && /Add question/.test(app))
check('the panel hides itself for companies without member billing', /if \(!questions\.length && !reviews\.length\) return null/.test(app))
check('editing questions writes to member_review_questions only (never to reviews)', /sb\.update\('member_review_questions'/.test(app) && /sb\.insert\('member_review_questions'/.test(app) && !/sb\.(update|insert|upsert|remove)\('member_visit_reviews'/.test(app))

console.log(`member_reviews_test: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
