// Appraisal pack (#486). Builders EXECUTED; the HR-admin wall and the wiring
// checked structurally.
//
//   node tools/appraisal_test.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(join(ROOT, f), 'utf8')
let passed = 0
const failures = []
const check = (name, cond, detail) => (cond ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`))

const m = await import('data:text/javascript;base64,' + Buffer.from(read('src/appraisal.js')).toString('base64'))
const q = await import('data:text/javascript;base64,' + Buffer.from(read('src/qualifications.js').split('// Storage + REST')[0]).toString('base64'))

// requirement parsing + checks
const req = m.parseRequiredQualifications('drivers_licence:EC, pdp , first_aid\nfgasa:1;')
check('parse: kinds and classes, any separator', req.length === 4 && req[0].kind === 'drivers_licence' && req[0].category === 'EC' && req[1].kind === 'pdp' && req[1].category === null && req[3].category === '1')
const quals = [
  { kind: 'drivers_licence', category: 'B', expires_on: '2028-01-01' },
  { kind: 'pdp', expires_on: '2026-01-01' },
  { kind: 'first_aid', expires_on: null },
  { kind: 'fgasa', category: '1' },
]
const checks = m.checkRequirements(req, quals, '2026-09-27')
check('licence class below requirement is not met, and says so', checks[0].met === false && /not the class required/.test(checks[0].detail))
check('expired PDP is "expired"', checks[1].met === false && checks[1].detail === 'expired')
check('non-expiring first aid is met', checks[2].met === true)
check('FGASA level match is exact', checks[3].met === true)
check('EC covers a B requirement', m.checkRequirements([{ kind: 'drivers_licence', category: 'B' }], [{ kind: 'drivers_licence', category: 'EC' }], '2026-09-27')[0].met === true)
check('licence rank table agrees with qualifications.js', ['A1', 'A', 'B', 'EB', 'C1', 'C', 'EC1', 'EC'].every((c, i, arr) => i === 0 || (q.licenceRank(arr[i - 1]) < q.licenceRank(c)) === (m.checkRequirements([{ kind: 'drivers_licence', category: c }], [{ kind: 'drivers_licence', category: arr[i - 1] }])[0].met === false)))

// leave in period
const leave = [
  { employee_id: 'e1', leave_type: 'sick', start_date: '2026-03-02', end_date: '2026-03-02', days_used: 1 },
  { employee_id: 'e1', leave_type: 'sick', start_date: '2026-05-10', end_date: '2026-05-14', days_used: 5 },
  { employee_id: 'e1', leave_type: 'annual', start_date: '2025-12-20', end_date: '2026-01-03', days_used: 10 },
  { employee_id: 'e1', leave_type: 'annual', start_date: '2024-12-20', end_date: '2024-12-28', days_used: 6 },
  { employee_id: 'e2', leave_type: 'sick', start_date: '2026-04-01', end_date: '2026-04-01', days_used: 1 },
]
const lp = m.leaveInPeriod(leave, 'e1', '2026-01-01', '2026-09-27')
check('leave: only this employee, only overlapping the period (straddling counts)', lp.rows.length === 3)
check('leave: days by type and sick episodes', lp.byType.sick === 6 && lp.byType.annual === 10 && lp.sickEpisodes === 2)

// full pack
const pack = m.buildAppraisalPack({
  employee: { id: 'e1', first_name: 'Lerato', last_name: 'M', position: 'Ranger', department: 'Guiding', start_date: '2022-02-01' },
  contract: { contract_type: 'Permanent', start_date: '2022-02-01', end_date: null, salary: 18000 },
  position: 'Ranger',
  requirements: { requirements: 'Guides drives\nFirst aid current', required_qualifications: 'drivers_licence:B, first_aid' },
  qualifications: quals, leaveRows: leave,
  offDays: [{ employee_id: 'e1', off_date: '2026-06-16', note: 'Youth Day swap' }, { employee_id: 'e1', off_date: '2025-06-16' }],
  bonuses: [{ employee_id: 'e1', bonus_date: '2026-06-30', amount: 1500, bonus_type: 'guest commendation' }],
  previousAppraisals: [{ id: 'a1', employee_id: 'e1', appraisal_date: '2025-09-01', strengths: 'Calm with guests' }, { id: 'a2', employee_id: 'e2', appraisal_date: '2025-09-01' }],
  patternText: '21 on / 7 off', from: '2026-01-01', to: '2026-09-27', asOf: '2026-09-27',
})
check('pack title and contract line', pack.title === 'Appraisal pack — Lerato M' && /Permanent, 2022-02-01 → open-ended/.test(pack.person[3][1]))
check('salary is NOT in the pack', !JSON.stringify(pack).includes('18000'))
check('requirements split into lines', pack.requirementLines.length === 2)
check('extras, bonuses and previous filtered to person + period', pack.extraOffDays.length === 1 && pack.bonuses.length === 1 && pack.previous.length === 1 && pack.previous[0].id === 'a1')
check('qualification expiry flagged', pack.qualifications.find((x) => /PDP/.test(x.label)).expired === true)

// html
const html = m.appraisalHtml(pack, { companyName: 'Limpopo Lipadi', preparedBy: 'T. Claassen' })
check('html is a full white-page document with the company and period', /<!doctype html>/.test(html) && /Limpopo Lipadi · period 2026-01-01 to 2026-09-27 · prepared by T. Claassen/.test(html))
check('html ticks and crosses requirements', /class="ok">✓ Code B, expires 2028-01-01/.test(html) && /class="no">✗ expired/.test(html) === false && /class="ok">✓ held/.test(html))
check('html escapes user text', m.appraisalHtml({ ...pack, requirementLines: ['<script>x</script>'] }).includes('&lt;script&gt;'))
check('html carries the confidentiality line', /Confidential — HR/.test(html))
check('html has blank boxes for this conversation', (html.match(/class="box"/g) || []).length === 3)

// SQL + wiring
const sql = read('add_hr_appraisals.sql').replace(/--[^\n]*/g, '')
check('appraisals are HR-admin only both ways', /"hr_admin_read_hr_appraisals"[\s\S]*?is_hr_admin\(company_id\)/.test(sql) && /"hr_admin_write_hr_appraisals"[\s\S]*?is_hr_admin\(company_id\)/.test(sql))
check('position requirements unique per company+position', /unique \(company_id, position\)/.test(sql))
const app = read('src/App.jsx')
check('Appraisals tab is in HRADMIN_TABS only', /HRADMIN_TABS = \[[\s\S]*?\{ id: 'appraisals', label: 'Appraisals' \}/.test(app) && !/ADMIN_TABS = \[[^\]]*appraisals/.test(app.slice(app.indexOf('const ADMIN_TABS'), app.indexOf('const HRADMIN_TABS'))))
check('tab is rendered behind role === hradmin', /activeTab === 'appraisals' && role === 'hradmin'/.test(app))
check('print goes to a new white window, not the dark app', /w\.document\.write\(appraisalHtml\(pack/.test(app))
check('requirements upsert on company_id,position', /sb\.upsert\('hr_position_requirements'[\s\S]*?'company_id,position'\)/.test(app))

console.log(`appraisal_test: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
