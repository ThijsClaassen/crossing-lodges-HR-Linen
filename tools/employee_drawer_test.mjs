// employee_drawer_test.mjs — the Employees tab redesign (#510, 2026-09-27).
//
// Thijs approved the mock-up (CL Dashboard/mockups/hr-employees.html) and
// asked for exactly that: a slim five-column table, "+ Add employee" as a
// button, and one side drawer with Profile · Work pattern · Uniforms ·
// Licences · Leave tabs. These checks pin the shape so a later edit can't
// quietly bring the long form back into the table.
//
//   node tools/employee_drawer_test.mjs

import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const traverse = traverseModule.default || traverseModule
const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'App.jsx'), 'utf8')
const theme = readFileSync(join(here, '..', 'src', 'theme.js'), 'utf8')

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}

const ast = parse(src, { sourceType: 'module', plugins: ['jsx'] })
const fns = {}
traverse(ast, { FunctionDeclaration(p) { fns[p.node.id.name] = p.node } })
const body = (name) => src.slice(fns[name].start, fns[name].end)

check('Drawer, EmployeesTab and EmployeeDrawer exist', ['Drawer', 'EmployeesTab', 'EmployeeDrawer'].every((n) => fns[n]))

// The theme carries the drawer classes the components rely on.
for (const cls of ['.drawer-scrim', '.drawer{', '.drawer-tabs', '.drawer-body', '.drawer-foot', '.drawer-grid', '.emp-row', '.avatar', '.toolbar'])
  check(`theme.js has ${cls}`, theme.includes(cls))

// Drawer: Esc closes, scrim closes, tabs render with optional counts.
const drawer = body('Drawer')
check('Drawer closes on Escape', /e\.key === 'Escape'/.test(drawer) && /onClose\(\)/.test(drawer))
check('Drawer scrim closes', /className="drawer-scrim" onClick=\{onClose\}/.test(drawer))
check('Drawer tab counts', /t\.count != null/.test(drawer))

// EmployeesTab: five columns, add as button, row click opens, no inline edit selects.
const tab = body('EmployeesTab')
const ths = (tab.match(/<th /g) || []).length
check('EmployeesTab has exactly 5 columns', ths === 5, `${ths} <th>`)
check('"+ Add employee" is a button that opens the drawer', /\+ Add employee/.test(tab) && /setOpenId\('new'\)/.test(tab))
check('employees are grouped by department with a header row', /className="group-row"/.test(tab) && /groups\.map\(\(g\) =>/.test(tab) && /'No department'/.test(tab))
check('row click opens the drawer', /className="emp-row" onClick=\{\(\) => setOpenId\(e\.id\)\}/.test(tab))
check('table has no inline status/pattern selects', !/<select[^>]*onChange=\{\(ev\) => updateEmployee/.test(tab))
check('toolbar: search + department + lodge filters', /placeholder="Search by name/.test(tab) && /All departments/.test(tab) && /All lodges \(this week\)/.test(tab))
check('needs-attention uses licence expiry, contract end and setup gaps', /expiryStatus\(q\) === 'expired'/.test(tab) && /currentContract\(e\.id, contracts\)/.test(tab) && /missingSetup\(/.test(tab))
check('contract flags are hradmin only', /if \(role === 'hradmin'\) \{\s*const c = currentContract/.test(tab))
check('EmployeesTab mounts EmployeeDrawer keyed by openId', /<EmployeeDrawer\s+key=\{openId\}/.test(tab))

// EmployeeDrawer: the five tabs, embedded modals, save/deactivate wiring.
const ed = body('EmployeeDrawer')
check('EMPLOYEE_TABS lists the five agreed tabs in order', /\[\s*\{ id: 'profile'[\s\S]*\{ id: 'pattern'[\s\S]*\{ id: 'uniforms'[\s\S]*\{ id: 'licences'[\s\S]*\{ id: 'leave'/.test(src))
check('new employee shows Profile only until saved', /isNew \? EMPLOYEE_TABS\.filter\(\(t\) => t\.id === 'profile'\)/.test(ed))
check('Uniforms tab embeds EmployeeUniformModal', /<EmployeeUniformModal\s+embedded/.test(ed))
check('Licences tab embeds EmployeeQualificationsModal', /<EmployeeQualificationsModal embedded/.test(ed))
check('profile save inserts or updates hr_employees', /sb\.insert\('hr_employees'/.test(ed) && /sb\.update\('hr_employees', \{ id: employee\.id \}, patch\)/.test(ed))
check('new employee insert carries company_id', /sb\.insert\('hr_employees', \{ \.\.\.patch, company_id: companyId \}\)/.test(ed))
check('deactivate confirms and sets active=false', /window\.confirm\(/.test(ed) && /\{ active: false \}/.test(ed))
check('work pattern saves shift_pattern_id and cycle_anchor_date', /\{ shift_pattern_id: value \|\| null \}/.test(ed) && /\{ cycle_anchor_date: value \|\| null \}/.test(ed))
check('extra off days insert into hr_employee_off_days with note', /sb\.insert\('hr_employee_off_days', \{ company_id: companyId, employee_id: employee\.id, off_date: offDate, note:/.test(ed))
check('leave balances use allBalances with the injected working-day counter', /allBalances\(\{/.test(ed) && /countWorkingDaysInRange\(emp, patternsById, start, end, rosterByEmployee\)/.test(ed))
check('position/department offer "+ New…"', /\+ New position…/.test(ed) && /\+ New department…/.test(ed))
check('footer: Save / Cancel / Deactivate', /Save changes/.test(ed) && /Deactivate<\/button>/.test(ed))

// Embedded modals: both return their content without the overlay when embedded.
for (const m of ['EmployeeUniformModal', 'EmployeeQualificationsModal']) {
  const b = body(m)
  check(`${m} accepts embedded and short-circuits`, /embedded = false/.test(b) && /if \(embedded\) return content/.test(b))
}

// Mount in AuthenticatedApp passes everything the drawer needs.
const mount = src.match(/<EmployeesTab[\s\S]*?\/>/)[0]
for (const prop of ['role=', 'entitlements=', 'contracts=', 'onOffDayAdd=', 'onOffDayRemove=', 'onQualificationAdd=', 'onQualificationRemove=', 'uniformItems=', 'uniformStockByItem=', 'uniformIssues=', 'onStockChange=', 'onIssuesAdd=', 'onIssuesUpdate=', 'onIssuesRemove='])
  check(`EmployeesTab mount passes ${prop}`, mount.includes(prop))
check('old onSelectEmployee/onSelectQualifications props are gone from the mount', !/onSelectEmployee=|onSelectQualifications=/.test(mount))

// Hooks in the drawer come before any early return (none expected).
const drawerFn = fns['EmployeeDrawer']
let earlyReturnBeforeHook = false
traverse(ast, {
  FunctionDeclaration(p) {
    if (p.node !== drawerFn) return
    let sawReturn = false
    for (const st of p.node.body.body) {
      if (st.type === 'ReturnStatement') sawReturn = true
      const txt = src.slice(st.start, st.end)
      if (sawReturn && /\buse(State|Memo|Effect)\(/.test(txt)) earlyReturnBeforeHook = true
    }
  },
})
check('EmployeeDrawer has no hooks after a return', !earlyReturnBeforeHook)

// Round 4 (2026-09-27): uniform and linen items share one table + one-screen drawer.
check('StockItemsTable and StockItemDrawer exist', /function StockItemsTable\(/.test(src) && /function StockItemDrawer\(/.test(src))
const sit = body('StockItemsTable'), sid = body('StockItemDrawer')
check('stock table has 5 columns, grouped by category', (sit.slice(sit.indexOf('<thead>'), sit.indexOf('</thead>')).match(/<th /g) || []).length === 5 && /className="group-row"/.test(sit))
check('stock item drawer is one screen: catalog fields + levels, no tabs', !/tabs=\{/.test(sid) && /Stock levels/.test(sid) && /<form id="stock-item-form" onSubmit=\{save\}>/.test(sid))
check('drawer writes the item then upserts the stock row on the right conflict key', /sb\.insert\(table, \{ \.\.\.patch, company_id: companyId \}\)/.test(sid) && /sb\.upsert\(stockTable, payload, stockConflict\)/.test(sid) && /if \(kind === 'linen'\) payload\.location_id = location/.test(sid))
check('Uniforms mounts it company-wide; Linen per lodge', /kind="uniform" table="hr_uniform_items" stockTable="hr_uniform_stock" stockConflict="item_id"/.test(src) && /kind="linen" table="hr_linen_items" stockTable="hr_linen_stock" stockConflict="item_id,location_id"/.test(src))
check('old inline-input stock tables are gone', !/onBlur=\{\(e\) => saveStock\(/.test(src) && !/onBlur=\{\(e\) => saveStockField\(/.test(src))
check('issue-an-item and log-a-movement forms untouched (staff one-screen forms)', /Issue an item/.test(src) && /Log a movement — \{location\}/.test(src))

console.log(failed ? `\n${failed} check(s) failed` : '\nall employee drawer checks pass')
process.exit(failed ? 1 : 0)
