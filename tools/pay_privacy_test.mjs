// pay_privacy_test.mjs — pay figures are for the Owner only, also in the HR
// app (2026-10-04, task #544, roles step 4).
//
//   node tools/pay_privacy_test.mjs
//
// Thijs: pay per person is Owner-only; the HR manager keeps Contracts, Leave,
// Loans and Appraisals without pay figures, and "can also enter new
// salaries". Checks, in order:
//   1. the pure rules (payPrivacy.js) on worked cases;
//   2. the SQL: pay columns write-only, Owner read via get_hr_pay, renewals
//      carry pay on the server, Owners count as HR admins;
//   3. the app never reads pay columns directly or writes with a read-back;
//   4. the Contracts screen RENDERED as the HR manager shows no rand figure,
//      and as the Owner still does.
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(join(ROOT, f), 'utf8')
let passed = 0
const failures = []
const check = (name, ok, detail) => (ok ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ''}`))

const P = await import(pathToFileURL(join(ROOT, 'src', 'payPrivacy.js')).href)

// ── 1. The rules ───────────────────────────────────────────────────────────
check('pay: Owner yes, platform admin yes', P.canSeePayFor({ profile: 'owner' }) && P.canSeePayFor({ profile: null, isPlatformAdmin: true }))
check('pay: HR manager, Finance, GM, manager, staff no', ['hr', 'finance', 'gm', 'manager', 'staff', null, undefined].every((p) => !P.canSeePayFor({ profile: p })))
check('HR access: hr_admins row, Owner or platform admin', P.isHrAdminFor({ profile: 'hr', hasHrAdminRow: true }) && P.isHrAdminFor({ profile: 'owner' }) && P.isHrAdminFor({ isPlatformAdmin: true }))
check('HR access: a GM or Finance without an hr_admins row does not get it', !P.isHrAdminFor({ profile: 'gm' }) && !P.isHrAdminFor({ profile: 'finance' }))
check('the HR manager (staff tier + hr_admins) gets the HR tabs — the old rule needed admin too', P.hrRoleFor({ baseRole: 'staff', isHrAdmin: true }) === 'hradmin')
check('admin without HR access stays admin; staff stays staff', P.hrRoleFor({ baseRole: 'admin', isHrAdmin: false }) === 'admin' && P.hrRoleFor({ baseRole: 'staff', isHrAdmin: false }) === 'staff')

const typed = { salary: '18500', medical_aid_monthly_cost: '', pension_fund_monthly_cost: '900', housing_monthly_cost: '' }
const owner = P.contractPayPatch(typed, { canSeePay: true })
check('Owner save: every pay field sent, blank = cleared (null)', owner.salary === 18500 && owner.medical_aid_monthly_cost === null && owner.pension_fund_monthly_cost === 900 && owner.housing_monthly_cost === null && Object.keys(owner).length === 4)
const hr = P.contractPayPatch(typed, { canSeePay: false })
check('HR manager save: only typed pay fields sent — a blank never wipes a stored figure', JSON.stringify(hr) === JSON.stringify({ salary: 18500, pension_fund_monthly_cost: 900 }), JSON.stringify(hr))
check('HR manager fixing only an end date sends no pay at all', Object.keys(P.contractPayPatch({ salary: '', medical_aid_monthly_cost: '', pension_fund_monthly_cost: '', housing_monthly_cost: '' }, { canSeePay: false })).length === 0)

const rows = [{ id: 'a', employee_id: 'e1' }, { id: 'b', employee_id: 'e2' }]
const merged = P.mergePay(rows, [{ id: 'a', salary: 12000, medical_aid_monthly_cost: null, pension_fund_monthly_cost: 500, housing_monthly_cost: 0 }], P.CONTRACT_PAY_FIELDS)
check('mergePay lays the Owner\'s figures over the matching row only', merged[0].salary === 12000 && merged[0].pension_fund_monthly_cost === 500 && merged[0].medical_aid_monthly_cost === null && !('salary' in merged[1]))
check('withoutPay strips the figures', !('salary' in P.withoutPay([{ id: 'a', salary: 1 }], P.CONTRACT_PAY_FIELDS)[0]))
check('newRowId is a v4 uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(P.newRowId()))

// The selectable columns carry no pay field, and every one exists in the schema.
const schemaSql = ['supabase/schema.sql', ...readdirSync(ROOT).filter((f) => f.endsWith('.sql'))].map(read).join('\n')
const contractCols = P.CONTRACT_COLUMNS.split(',')
const bonusCols = P.BONUS_COLUMNS.split(',')
check('CONTRACT_COLUMNS / BONUS_COLUMNS name no pay field', !contractCols.some((c) => P.CONTRACT_PAY_FIELDS.includes(c)) && !bonusCols.includes('amount'))
const tableBlock = (name) => { const i = schemaSql.indexOf(`create table if not exists ${name}`); return i < 0 ? '' : schemaSql.slice(i, schemaSql.indexOf(');', i)) }
const hasCol = (table, c) => new RegExp(`\\n\\s*${c}\\s`).test(tableBlock(table)) || new RegExp(`alter table ${table} add column if not exists ${c}\\b`).test(schemaSql)
check('every contract column in the list exists (a typo would fail the whole read)', contractCols.every((c) => hasCol('hr_contracts', c)), contractCols.filter((c) => !hasCol('hr_contracts', c)).join(','))
check('every bonus column in the list exists', bonusCols.every((c) => hasCol('hr_bonuses', c)), bonusCols.filter((c) => !hasCol('hr_bonuses', c)).join(','))
check('the pay fields are exactly the money columns on hr_contracts', P.CONTRACT_PAY_FIELDS.every((c) => hasCol('hr_contracts', c)))

// staff cost: bonuses come from the app's (merged) copy, not a table read.
const eng = read('src/staffCostEngine.js')
const fnStart = eng.indexOf('export function getBonusesByEmployee')
const fnSrc = eng.slice(fnStart, eng.indexOf('\n}\n', fnStart) + 3).replace('export ', '')
const getBonusesByEmployee = new Function('monthsAgoIso', 'MONTHS_SMOOTHED', `${fnSrc}\nreturn getBonusesByEmployee`)(() => '2025-10-04', 12)
const bTot = getBonusesByEmployee({ bonuses: [{ employee_id: 'e1', bonus_date: '2026-03-01', amount: 5000 }, { employee_id: 'e1', bonus_date: '2025-01-01', amount: 9999 }, { employee_id: 'e2', bonus_date: '2026-05-01' }], since: '2025-10-04' })
check('staff cost bonuses: summed from the given rows, last 12 months only, rows without an amount skipped', bTot.e1 === 5000 && !('e2' in bTot), JSON.stringify(bTot))
check('staffCostEngine no longer reads hr_bonuses itself', !/sb\.select\('hr_bonuses'/.test(eng) && /getBonusesByEmployee\(\{ bonuses \}\)/.test(eng))

// ── 2. The SQL ─────────────────────────────────────────────────────────────
const sql = read('add_hr_pay_privacy.sql')
const body = sql.slice(0, sql.indexOf('THE MIGRATION ENDS HERE'))
check('SQL ends with the "THE MIGRATION ENDS HERE" marker (checks and undo below it stay commented)', body.length < sql.length && !/^\s*grant select on hr_contracts to authenticated;/m.test(body))
check('is_hr_admin counts Owners', /create or replace function is_hr_admin[\s\S]*?uc\.profile = 'owner'/.test(body))
check('hr_contracts: table-wide SELECT revoked, then granted on every column except the four pay fields', /revoke select on hr_contracts from anon, authenticated;/.test(body) && /column_name not in \('salary', 'medical_aid_monthly_cost', 'pension_fund_monthly_cost', 'housing_monthly_cost'\)/.test(body) && /grant select \(%s\) on hr_contracts to authenticated/.test(body))
check('hr_contracts: INSERT and UPDATE stay granted (the HR manager may enter salaries)', /grant insert, update, delete on hr_contracts to authenticated;/.test(body))
check('hr_bonuses: amount write-only the same way, only if the table exists', /to_regclass\('public\.hr_bonuses'\) is null/.test(body) && /column_name <> 'amount'/.test(body))
check('get_hr_pay: Owner only (can_see_pay), security definer, null for anyone else', /function get_hr_pay[\s\S]*?security definer[\s\S]*?if not can_see_pay\(p_company_id\) then\s*return null;/.test(body))
check('carry_contract_pay: blanks only (coalesce), same person and company, HR admins only', /function carry_contract_pay[\s\S]*?coalesce\(n\.salary, o\.salary\)[\s\S]*?o\.employee_id = n\.employee_id[\s\S]*?o\.company_id = n\.company_id[\s\S]*?is_hr_admin\(n\.company_id\)/.test(body))
check('both functions: execute revoked from public, granted to signed-in users', /revoke all on function get_hr_pay\(uuid\) from public;/.test(body) && /revoke all on function carry_contract_pay\(uuid, uuid\) from public;/.test(body))

// ── 3. The app: no direct pay reads, no read-back writes ────────────────────
const app = read('src/App.jsx')
const data = read('src/hrPayData.js')
check('App.jsx never reads or writes hr_contracts / hr_bonuses directly', !/sb\.(select|insert|update|remove|upsert)\('hr_(contracts|bonuses)'/.test(app))
check('hrPayData: column-named reads; the whole-row read only for the Owner when get_hr_pay is missing (SQL not run yet)', /select: CONTRACT_COLUMNS/.test(data) && /select: BONUS_COLUMNS/.test(data) && /if \(!canSeePay\) return/.test(data.slice(0, data.indexOf("sb.select('hr_contracts', { company_id: companyId }, {})"))))
const writes = [...data.matchAll(/sb\.(insert|update|remove)\('hr_(contracts|bonuses)'[^\n]*/g)].map((m) => m[0])
check('hrPayData: every write asks for nothing back (return=minimal)', writes.length === 4 && writes.every((w) => /\{ minimal: true \}\)$/.test(w.trim())), writes.join(' | '))
check('a renewal by the HR manager carries the old pay on the server', /if \(!canSeePay && carryPayFrom\)[\s\S]*?rpc\('carry_contract_pay', \{ p_new_id: id, p_from_id: carryPayFrom \}\)/.test(data))
check('sb.js supports return=minimal on insert, update and remove', (read('src/sb.js').match(/opts\.minimal \? 'return=minimal' : 'return=representation'/g) || []).length === 3)
check('App: role from hrRoleFor; contracts and bonuses loaded through loadContractsAndBonuses', /const role = hrRoleFor\(\{ baseRole, isHrAdmin \}\)/.test(app) && /loadContractsAndBonuses\(\{ companyId, canSeePay \}\)/.test(app))
check('App: canSeePay reaches Contracts and Staff cost', /onUpdate=\{updateLocalContract\}\s*canSeePay=\{canSeePay\}/.test(app) && /<StaffCostTab [^>]*canSeePay=\{canSeePay\}/.test(app))
check('Staff cost: the HR manager gets department totals from the server, not per-person figures', /\{!canSeePay && <StaffCostByDepartment companyId=\{companyId\} \/>\}/.test(app) && /\{canSeePay && \(<>/.test(app) && /rpc\('get_staff_cost_by_department'/.test(app) && /if \(!canSeePay\) return/.test(app))
check('Bonus list: amount column only for the Owner', /\{canSeePay && <th style=\{styles\.th\}>Amount<\/th>\}/.test(app) && /\{canSeePay && <td style=\{styles\.tdNum\}>R \{fmt\(b\.amount\)\}<\/td>\}/.test(app))
const ctx = read('src/CompanyContext.jsx')
check('CompanyContext: profile read on its own and ignored on error; isHrAdmin/canSeePay from payPrivacy', /\.select\('company_id, profile'\)/.test(ctx) && /if \(!profErr\)/.test(ctx) && /isHrAdmin: isHrAdminFor\(/.test(ctx) && /canSeePay: canSeePayFor\(/.test(ctx))
const appr = read('src/appraisal.js')
check('Appraisal pack: a hidden bonus amount reads "amount not shown", never R 0', /amount: b\.amount === undefined \|\| b\.amount === null \? null : Number\(b\.amount\)/.test(appr) && /amount not shown/.test(appr))

// ── 4. Render the Contracts screen as the HR manager and as the Owner ───────
const require = createRequire(join(ROOT, 'package.json'))
const React = require('react')
const { renderToString } = require('react-dom/server')
const babel = require('@babel/core')
const t = require('@babel/types')
const lift = (header) => {
  const start = app.indexOf(header)
  if (start < 0) throw new Error(`not found: ${header}`)
  const rest = app.slice(start + 1)
  const endRel = rest.search(/\n(?:export |function |const |let |class |\/\/ -{10,}|\/\/ =+)/)
  return app.slice(start, endRel < 0 ? undefined : start + 1 + endRel)
}
const jsxName = (n) => t.isJSXIdentifier(n) ? (/^[a-z]/.test(n.name) ? t.stringLiteral(n.name) : t.identifier(n.name)) : t.isJSXMemberExpression(n) ? t.memberExpression(jsxName(n.object), t.identifier(n.property.name)) : t.stringLiteral('unknown')
const attrs = (list) => list.length ? t.objectExpression(list.map((a) => t.isJSXSpreadAttribute(a) ? t.spreadElement(a.argument) : t.objectProperty(t.stringLiteral(a.name.name), a.value == null ? t.booleanLiteral(true) : t.isJSXExpressionContainer(a.value) ? a.value.expression : a.value))) : t.nullLiteral()
const kids = (children) => children.flatMap((c) => {
  if (t.isJSXText(c)) { const s = c.value.replace(/\s*\n\s*/g, ' ').trim(); return s ? [t.stringLiteral(s)] : [] }
  if (t.isJSXExpressionContainer(c)) return t.isJSXEmptyExpression(c.expression) ? [] : [c.expression]
  return [c]
})
const jsxPlugin = () => ({ visitor: {
  JSXElement(path) { const o = path.node.openingElement; path.replaceWith(t.callExpression(t.memberExpression(t.identifier('React'), t.identifier('createElement')), [jsxName(o.name), attrs(o.attributes), ...kids(path.node.children)])) },
  JSXFragment(path) { path.replaceWith(t.callExpression(t.memberExpression(t.identifier('React'), t.identifier('createElement')), [t.memberExpression(t.identifier('React'), t.identifier('Fragment')), t.nullLiteral(), ...kids(path.node.children)])) },
} })
const pieces = ['function fmt(', 'function todayStr(', 'function daysUntil(', 'function currentContract(', 'function Drawer(', 'function initials(', 'const BLANK_CONTRACT_FORM', 'function contractToForm(', 'function contractPatch(', 'function fixedRealCostOf(', 'function contractStatus(', 'function ContractsTab(', 'const CONTRACT_TABS', 'function ContractDrawer(']
const src = pieces.map(lift).join('\n')
const code = babel.transformSync(src, { filename: 'Contracts.jsx', plugins: [jsxPlugin], parserOpts: { plugins: ['jsx'] }, babelrc: false, configFile: false }).code
const anyStyle = new Proxy({}, { get: (_, k) => (k === 'badge' ? () => ({}) : {}) })
const D = await import(pathToFileURL(join(ROOT, 'src', 'dates.js')).href)
const mod = new Function('todayIso', 'isoDate', 'React', 'Fragment', 'useState', 'useMemo', 'useEffect', 'useLayoutEffect', 'useRef', 'styles', 'colors', 'CONTRACT_TYPES', 'contractPayPatch', 'CONTRACT_PAY_FIELDS', 'sb', 'insertContract', 'updateContract',
  `${code}\nreturn { ContractsTab, ContractDrawer }`)(D.todayIso, D.isoDate, React, React.Fragment, React.useState, React.useMemo, React.useEffect, React.useLayoutEffect, React.useRef, anyStyle, new Proxy({}, { get: () => '#888' }), ['Permanent', 'Fixed-term', 'Probation'], P.contractPayPatch, P.CONTRACT_PAY_FIELDS, {}, async () => ({}), async () => ({}))

const employees = [{ id: 'e1', first_name: 'Thandi', last_name: 'Mokoena', position: 'Chef', department: 'Kitchen' }]
const fullRow = { id: 'c1', employee_id: 'e1', contract_type: 'Permanent', start_date: '2025-03-01', end_date: null, salary: 18500, medical_aid: true, medical_aid_monthly_cost: 1200, pension_fund: false, housing_monthly_cost: 650, notes: '' }
const hrRow = P.withoutPay([fullRow], P.CONTRACT_PAY_FIELDS)[0] // what the HR manager's copy looks like
const render = (el) => renderToString(el).replace(/<!-- -->/g, '')
try {
  const asHr = render(React.createElement(mod.ContractsTab, { companyId: 'x', employees, contracts: [hrRow], onAdd() {}, onUpdate() {}, canSeePay: false }))
  // Belt and braces: even if a figure reached the HR manager's copy (it
  // cannot once the SQL has run), the screen itself must not print it.
  const leaked = render(React.createElement(mod.ContractsTab, { companyId: 'x', employees, contracts: [fullRow], onAdd() {}, onUpdate() {}, canSeePay: false }))
  check('Contracts list as the HR manager prints no figure even if one is in the data', !/18[\s,]?500/.test(leaked) && !/20[\s,]?350/.test(leaked))
  const leakedDrawer = render(React.createElement(mod.ContractDrawer, { companyId: 'x', employee: employees[0], contract: fullRow, history: [fullRow], onAdd() {}, onUpdate() {}, onClose() {}, canSeePay: false }))
  check('Contract drawer as the HR manager prints no figure even if one is in the data (boxes blank, no history column)', !/18[\s,]?500/.test(leakedDrawer))
  const asOwner = render(React.createElement(mod.ContractsTab, { companyId: 'x', employees, contracts: [fullRow], onAdd() {}, onUpdate() {}, canSeePay: true }))
  check('Contracts list as the HR manager: no rand figure, no Salary column', !/R\s?[\d ,]+\d/.test(asHr) && !/>Salary</.test(asHr) && /Thandi/.test(asHr) && /owner only/.test(asHr), asHr.slice(0, 300))
  check('Contracts list as the Owner: salary and fixed cost still shown', />Salary</.test(asOwner) && /R 18[\s,]?500/.test(asOwner) && /R 20[\s,]?350/.test(asOwner))
  const drawerHr = render(React.createElement(mod.ContractDrawer, { companyId: 'x', employee: employees[0], contract: hrRow, history: [hrRow], onAdd() {}, onUpdate() {}, onClose() {}, canSeePay: false }))
  const drawerOwner = render(React.createElement(mod.ContractDrawer, { companyId: 'x', employee: employees[0], contract: fullRow, history: [fullRow], onAdd() {}, onUpdate() {}, onClose() {}, canSeePay: true }))
  check('Contract drawer as the HR manager: pay boxes empty with "Hidden — type to replace", no Cost tab', /placeholder="Hidden — type to replace"/.test(drawerHr) && !/value="18500"/.test(drawerHr) && !/>Cost</.test(drawerHr) && /Leave blank to keep what is stored/.test(drawerHr))
  check('Contract drawer as the Owner: the salary is filled in and the Cost tab is there', /value="18500"/.test(drawerOwner) && />Cost</.test(drawerOwner))
} catch (e) {
  check('Contracts screen renders', false, String(e.stack || e).split('\n').slice(0, 3).join(' | '))
}

console.log(`pay_privacy_test: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
