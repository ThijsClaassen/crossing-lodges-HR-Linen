// Licences & qualifications (#484): the pure helpers are EXECUTED; the SQL,
// the wiring and the security split (row readable company-wide, document
// admin-only) are checked structurally.
//
//   node tools/qualifications_test.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(join(ROOT, f), 'utf8')
let passed = 0
const failures = []
const check = (name, cond, detail) => (cond ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`))

const src = read('src/qualifications.js')
const pure = src.slice(0, src.indexOf('// Storage + REST'))
const m = await import('data:text/javascript;base64,' + Buffer.from(pure).toString('base64'))
const today = new Date('2026-09-27T10:00:00Z')

// licence ranks agree with licence_class_rank() in the SQL
const sql = read('add_hr_qualifications.sql').replace(/--[^\n]*/g, '')
const sqlRanks = Object.fromEntries([...sql.matchAll(/when '([A-Z0-9]+)'\s+then (\d+)/g)].map((x) => [x[1], Number(x[2])]))
check('every JS licence class has the same rank in SQL', m.LICENCE_CLASSES.every((c) => sqlRanks[c] === m.licenceRank(c)), JSON.stringify(sqlRanks))
check('unknown class ranks 0 in both', m.licenceRank('ZZ') === 0 && /else 0 end/.test(sql))
check('EC covers B, B does not cover C1, blank requirement is always covered', m.classCovers('EC', 'B') && !m.classCovers('B', 'C1') && m.classCovers(null, ''))
check('lowercase input is tolerated', m.licenceRank('ec') === 31)

// expiry
check('no expiry = none', m.expiryStatus({ expires_on: null }, today) === 'none' && m.expiryLabel({ expires_on: null }) === 'does not expire')
check('expired yesterday', m.daysToExpiry({ expires_on: '2026-09-26' }, today) === -1 && m.expiryStatus({ expires_on: '2026-09-26' }, today) === 'expired' && m.expiryLabel({ expires_on: '2026-09-26' }, today) === 'expired 1 day ago')
check('expires today', m.expiryStatus({ expires_on: '2026-09-27' }, today) === 'soon' && m.expiryLabel({ expires_on: '2026-09-27' }, today) === 'expires today')
check('within 60 days = soon, beyond = ok', m.expiryStatus({ expires_on: '2026-11-26' }, today) === 'soon' && m.expiryStatus({ expires_on: '2026-11-27' }, today) === 'ok')

// grouping
const g = m.groupByUrgency([
  { id: 1, expires_on: '2026-10-10' },
  { id: 2, expires_on: '2026-09-01' },
  { id: 3, expires_on: null },
  { id: 4, expires_on: '2027-09-01' },
  { id: 5, expires_on: '2026-09-20' },
], today)
check('expired first, most overdue leading', g.expired.map((x) => x.q.id).join() === '2,5')
check('upcoming within window only', g.upcoming.map((x) => x.q.id).join() === '1')

// best licence
const best = m.bestLicence([
  { kind: 'drivers_licence', category: 'EC', expires_on: '2026-01-01' },
  { kind: 'drivers_licence', category: 'B', expires_on: '2028-01-01' },
  { kind: 'first_aid', category: null },
], today)
check('an unexpired lower class beats an expired higher one', best.category === 'B')
check('no licence rows → null', m.bestLicence([{ kind: 'pdp' }]) === null)
check('describe: code + kind when no title', m.describeQualification({ kind: 'drivers_licence', category: 'EC' }) === "Code EC Driver's licence")
check('describe: title wins', m.describeQualification({ kind: 'other', title: 'Rigging ticket' }) === 'Rigging ticket')

// SQL: the split
check('table exists with expiry + storage_path', /create table if not exists hr_qualifications/.test(sql) && /expires_on\s+date/.test(sql) && /storage_path text/.test(sql))
check('row readable by anyone in the company (Ops needs it)', /create policy "read hr_qualifications" on hr_qualifications\s+for select using \(has_company_access\(company_id\)\)/.test(sql))
check('row writable by admin / HR admin only', /create policy "admin write hr_qualifications"[\s\S]*?has_company_role\(company_id, 'admin'\) or is_hr_admin\(company_id\)/.test(sql))
check('bucket is private', /values \('hr-documents', 'hr-documents', false/.test(sql))
check('document read is admin / HR admin only, never plain company access', /"hr admins read hr documents"[\s\S]*?is_hr_admin\(\(storage\.foldername\(name\)\)\[1\]::uuid\)/.test(sql) && !/"hr admins read hr documents"[\s\S]*?for select using \(\s*bucket_id = 'hr-documents'\s+and has_company_access/.test(sql))
check('drivers_for_vehicle checks class, expiry on the date asked, and PDP', /drivers_for_vehicle\(p_company_id uuid, p_required_class text, p_needs_pdp boolean default false, p_on date default current_date\)/.test(sql) && /l\.expires_on < p_on/.test(sql) && /no PDP on file/.test(sql))
check('unlicensed employees are returned with a reason, not dropped', /left join lic l on/.test(sql) && /'no licence on file'/.test(sql))
check('dates sanity constraint', /expires_on >= issued_on/.test(sql))

// wiring
const app = read('src/App.jsx')
check('App loads hr_qualifications with .catch (pre-migration safe)', /select\('hr_qualifications', \{ company_id: companyId \}[\s\S]*?\.catch\(\(\) => \[\]\)/.test(app))
// 2026-09-27 (#510): the Licences column became a drawer tab; the table now
// flags expired/expiring licences under "Needs attention" instead.
check('Employees: Licences is a drawer tab and expiry flags reach the table', /\{ id: 'licences', label: 'Licences' \}/.test(app) && /<EmployeeQualificationsModal embedded/.test(app) && /expiryStatus\(q\) === 'expired'/.test(app))
check('Dashboard card groups expired / coming up', /Licences & qualifications — \$\{qualUrgency\.expired\.length\} expired/.test(app))
check('modal cleans up the uploaded file if the row insert fails', /if \(storagePath\) await removeQualificationFile/.test(app))
check('removing a row removes its scan', /await sb\.remove\('hr_qualifications', \{ id: q\.id \}\)[\s\S]*?removeQualificationFile/.test(app))
check('document is opened through a signed URL', /qualificationFileUrl\(\{ supabase, storagePath: q\.storage_path \}\)/.test(app))
check('upload path is company-scoped for the bucket policy', /`\$\{companyId\}\/hr\/\$\{crypto\.randomUUID\(\)\}\.\$\{ext\}`/.test(src))

console.log(`qualifications_test: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
