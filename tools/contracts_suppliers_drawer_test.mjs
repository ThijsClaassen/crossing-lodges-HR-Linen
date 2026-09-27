// contracts_suppliers_drawer_test.mjs — Contracts and Suppliers tabs (#510, 2026-09-27).
//
// Thijs approved CL Dashboard/mockups/hr-contracts-suppliers.html. Contracts:
// six-column table + drawer (Current contract edited in place · Cost ·
// History; "+ New contract" adds a row and keeps the history). Suppliers:
// what each supplier supplies, drawer with Details · Items supplied.
//
//   node tools/contracts_suppliers_drawer_test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@babel/parser'

const here = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(here, '..', 'src', 'App.jsx'), 'utf8')
let failed = 0
function check(name, ok, detail = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`); if (!ok) failed++ }
const fn = (name) => { const i = APP.indexOf(`function ${name}(`); const j = APP.indexOf('\nfunction ', i + 10); return APP.slice(i, j < 0 ? undefined : j) }
const ths = (src) => { const h = src.slice(src.indexOf('<thead>'), src.indexOf('</thead>')); return (h.match(/<th /g) || []).length }

parse(APP, { sourceType: 'module', plugins: ['jsx'] })
check('App.jsx parses', true)

const ct = fn('ContractsTab')
check('Contracts table has 6 columns', ths(ct) === 6, String(ths(ct)))
check('contracts are grouped by department with a header row (headcount + fixed cost subtotal)', /className="group-row"/.test(ct) && /groups\.map\(\(g\) =>/.test(ct) && /'No department'/.test(ct))
check('rows open the contract drawer', /className="emp-row" onClick=\{\(\) => setOpenId\(employee\.id\)\}/.test(ct))
check('toolbar: search, department, status, type', /placeholder="Search employee…"/.test(ct) && /All departments/.test(ct) && /Ending within 60 days/.test(ct) && /All types/.test(ct))
check('status badge: ended / ends in N days / ongoing / no contract', /Ended \$\{Math\.abs\(days\)\}/.test(APP) && /Ends in \$\{days\}/.test(APP) && /text: 'Ongoing'/.test(APP) && /text: 'No contract'/.test(APP))
check('no inline add form or history table on the page', !/Add \/ view contract history/.test(ct) && !/Choose employee…/.test(ct))

const cd = fn('ContractDrawer')
check('drawer tabs: Current contract · Cost · History', /\{ id: 'current', label: 'Current contract' \}/.test(APP) && /\{ id: 'cost', label: 'Cost' \}/.test(APP) && /\{ id: 'history', label: 'History' \}/.test(APP))
check('edit mode amends the SAME row (sb.update), never inserts', /mode === 'edit' && contract\) \{\s*const \[row\] = await sb\.update\('hr_contracts', \{ id: contract\.id \}, contractPatch\(form\)\)/.test(cd))
check('new mode inserts a row with company_id + employee_id', /sb\.insert\('hr_contracts', \{ company_id: companyId, employee_id: employee\.id, \.\.\.contractPatch\(form\) \}\)/.test(cd))
check('"+ New contract" prefills from the current one, starts today, clears the end date', /start_date: todayStr\(\), end_date: ''/.test(cd))
check('form submits from the footer', /<form id="contract-form" onSubmit=\{save\}>/.test(cd) && /type="submit" form="contract-form"/.test(cd))
check('end date before start is refused', /The end date is before the start date\./.test(cd))
check('cost tab totals salary + medical + pension + housing', /Fixed real cost \/ month/.test(cd) && /Number\(form\.salary \|\| 0\) \+ Number\(form\.medical_aid \? form\.medical_aid_monthly_cost \|\| 0 : 0\)/.test(cd))
check('history marks the current row', /c\.id === contract\.id && <> <span style=\{styles\.badge\('good'\)\}>current/.test(cd))
check('contractPatch keeps blank numbers as null (as before)', /const num = \(v\) => \(v === '' \? null : Number\(v\)\)/.test(fn('contractPatch')))

const st = fn('SuppliersTab')
check('Suppliers table has 5 columns', ths(st) === 5, String(ths(st)))
check('supplies column counts uniform items and linen lines by supplier_id', /add\(it\.supplier_id, \{ kind: 'Uniform'/.test(st) && /add\(it\.supplier_id, \{ kind: 'Linen'/.test(st))
check('low count uses the same min rule as Orders', /Number\(stock\.qty_on_hand\) <= Number\(stock\.min_units\)/.test(st) && /Number\(s\.qty_on_hand\) <= Number\(s\.min_units\)/.test(st))
check('no inline inputs in the suppliers table', !/defaultValue=\{s\./.test(st))
check('"+ Add supplier" opens the drawer empty', /onClick=\{\(\) => setOpenId\('new'\)\}>\+ Add supplier/.test(st))
const sd = fn('SupplierDrawer')
check('supplier drawer: Details · Items supplied (count)', /\{ id: 'items', label: 'Items supplied', count: items\.length \}/.test(sd))
check('supplier insert carries company_id; update patches the row', /sb\.insert\('hr_suppliers', \{ \.\.\.patch, company_id: companyId \}\)/.test(sd) && /sb\.update\('hr_suppliers', \{ id: supplier\.id \}, patch\)/.test(sd))
check('copy order list uses the Orders tab maths (orderQty × price)', /orderQty\(r\.stock\) \* Number\(r\.item\.price \|\| 0\)/.test(sd))
check('deactivate confirms', /window\.confirm\(`Remove \$\{supplier\.name\}/.test(sd))
check('mount passes stock so the drawer can list items', /<SuppliersTab[\s\S]*?linenStock=\{linenStock\}[\s\S]*?\/>/.test(APP))
for (const name of ['ContractDrawer', 'SupplierDrawer']) {
  const b = fn(name)
  const lastHook = Math.max(b.lastIndexOf('useState('), b.lastIndexOf('useMemo('), b.lastIndexOf('useEffect('))
  check(`${name} has no hook after its return`, lastHook < b.indexOf('return (\n    <Drawer'))
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall contracts/suppliers drawer checks pass')
process.exit(failed ? 1 : 0)
