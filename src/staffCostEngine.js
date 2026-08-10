// "Real Staff Cost" overview (2026-08-10) — combines each employee's fixed
// contract costs (salary, healthcare, pension, housing) with a live-computed
// share of staff Food and Beverage consumption, so the Staff Cost tab shows
// what an employee actually costs, not just their salary.
//
// Food/Beverage cost is cross-app: this reads food_issues/food_purchases/
// food_stock_periods and bev_issues/bev_purchases/bev_stock_periods
// directly from the same Supabase project (same pattern already used by the
// Finance Dashboard's Company Pulse/Inventory Overview) — every query below
// explicitly filters .company_id even though RLS already restricts access,
// because RLS only proves the signed-in user *can* see a company's data,
// not that it matches the company currently selected here (same lesson
// learned from the Company Pulse cross-tenant leak).
//
// Cost source, per app:
//  - Every food_issues/bev_issues row with reason='Staff' counts, whether
//    it's against a dedicated "Staff Meals"/"Staff Beverages" item (create
//    one via each app's own Add Item screen so staff have something clean
//    to log against) or a regular item issued out for staff use — both are
//    already tagged the same way in each app's own issue form, so there's
//    only one signal to read here, not two.
//  - Qty is priced at that item's weighted-average cost for the month the
//    issue fell in — same convention as the Finance Dashboard's
//    inventoryEngine.js: (opening_units * opening_cost_per_unit +
//    that month's purchases.total_cost_excl_vat) / (opening_units +
//    that month's purchases.units), falling back to opening_cost_per_unit
//    if there's nothing to divide by, and to 0 if the item has no stock
//    period on record at all for that month.
//
// Headcount source: hr_schedule_locations, which already records which
// lodge each rotation employee was assigned to for a given Monday-starting
// week — exactly the "how many staff were working at this location that
// week" figure needed to turn a location's total food/bev cost into a
// cost-per-head. Office/admin staff with no cycle_anchor_date typically
// have no schedule_locations rows at all, so they show "no schedule data"
// for their food/bev share rather than a fabricated number.

import { sb } from './sb.js'

const LOCATIONS_LIST = ['ZC', 'EC', 'SC']

function periodOf(dateStr) {
  return dateStr.slice(0, 7) // 'YYYY-MM'
}

// Monday of the ISO week containing dateStr — matches hr_schedule_locations'
// week_start_date convention exactly.
function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`)
  const day = d.getDay() // 0 = Sunday .. 6 = Saturday
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d.toISOString().slice(0, 10)
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

// Every Monday from startDate's week through endDate's week, inclusive.
function weeksBetween(startDate, endDate) {
  const weeks = []
  let cur = mondayOf(startDate)
  const last = mondayOf(endDate)
  while (cur <= last) {
    weeks.push(cur)
    cur = addDays(cur, 7)
  }
  return weeks
}

// Builds a (item_id, period) -> weighted-avg-cost-per-unit lookup, mirroring
// the Finance Dashboard's inventoryEngine.js convention exactly.
function buildCostLookup(stockPeriods, purchases) {
  const purchaseTotals = {} // `${item_id}|${period}` -> { units, cost }
  for (const p of purchases) {
    const key = `${p.item_id}|${p.period}`
    if (!purchaseTotals[key]) purchaseTotals[key] = { units: 0, cost: 0 }
    purchaseTotals[key].units += Number(p.units || 0)
    purchaseTotals[key].cost += Number(p.total_cost_excl_vat || 0)
  }

  const lookup = {}
  for (const sp of stockPeriods) {
    const key = `${sp.item_id}|${sp.period}`
    const openingUnits = Number(sp.opening_units || 0)
    const openingCost = Number(sp.opening_cost_per_unit || 0)
    const purch = purchaseTotals[key] || { units: 0, cost: 0 }
    const denom = openingUnits + purch.units
    lookup[key] = denom > 0 ? (openingUnits * openingCost + purch.cost) / denom : openingCost
  }
  return lookup
}

// Fetches every reason='Staff' issue for `table` (food_issues or
// bev_issues), plus the purchases/stock-periods needed to price them, and
// returns cost bucketed by (location_id, weekStartMonday).
async function getStaffIssueCostByWeek({ companyId, issuesTable, purchasesTable, stockPeriodsTable, startDate, endDate }) {
  const [issues, purchases, stockPeriods] = await Promise.all([
    sb.select(issuesTable, { company_id: companyId, reason: 'eq.Staff' }, {}),
    sb.select(purchasesTable, { company_id: companyId }, {}),
    sb.select(stockPeriodsTable, { company_id: companyId }, {}),
  ])

  const inRange = (issues || []).filter((r) => r.date >= startDate && r.date <= endDate)
  const costLookup = buildCostLookup(stockPeriods || [], purchases || [])

  // key: `${location_id}|${weekStart}`
  const byWeek = {}
  for (const r of inRange) {
    const key = `${r.location_id}|${mondayOf(r.date)}`
    const unitCost = costLookup[`${r.item_id}|${periodOf(r.date)}`] || 0
    byWeek[key] = (byWeek[key] || 0) + Number(r.qty || 0) * unitCost
  }
  return byWeek
}

// Headcount per (location, week), from already-loaded scheduleLocations
// (App.jsx fetches this for every role already — no extra round trip).
function headcountByWeek(scheduleLocations) {
  const byWeek = {} // `${location_id}|${weekStart}` -> Set of employee_id
  for (const s of scheduleLocations) {
    const key = `${s.location_id}|${s.week_start_date}`
    if (!byWeek[key]) byWeek[key] = new Set()
    byWeek[key].add(s.employee_id)
  }
  const counts = {}
  for (const [key, set] of Object.entries(byWeek)) counts[key] = set.size
  return counts
}

// employee_id -> location_id for a given week, from scheduleLocations.
function locationForEmployeeWeek(scheduleLocations) {
  const lookup = {} // `${employee_id}|${week}` -> location_id
  for (const s of scheduleLocations) {
    lookup[`${s.employee_id}|${s.week_start_date}`] = s.location_id
  }
  return lookup
}

const WEEKS_PER_MONTH = 4.345 // 52 / 12 — used to project a weekly average up to a monthly figure

// Main entry point for the Staff Cost tab. `contracts`/`scheduleLocations`
// are passed in from App.jsx's own already-loaded state (avoids re-fetching
// what's already in memory); Food/Beverage data is fetched fresh here since
// nothing else in this app touches those tables.
export async function getRealStaffCostOverview({ companyId, employees, contracts, scheduleLocations, startDate, endDate }) {
  const [foodByWeek, bevByWeek] = await Promise.all([
    getStaffIssueCostByWeek({
      companyId,
      issuesTable: 'food_issues',
      purchasesTable: 'food_purchases',
      stockPeriodsTable: 'food_stock_periods',
      startDate,
      endDate,
    }),
    getStaffIssueCostByWeek({
      companyId,
      issuesTable: 'bev_issues',
      purchasesTable: 'bev_purchases',
      stockPeriodsTable: 'bev_stock_periods',
      startDate,
      endDate,
    }),
  ])

  const weeks = weeksBetween(startDate, endDate)
  const headcounts = headcountByWeek(scheduleLocations)
  const empLocationByWeek = locationForEmployeeWeek(scheduleLocations)

  // Per-location, per-week cost-per-head — the summary table's own data,
  // and also what each employee's share is looked up from.
  const locationWeeks = []
  const costPerHead = {} // `${location}|${week}` -> number
  for (const loc of LOCATIONS_LIST) {
    for (const week of weeks) {
      const key = `${loc}|${week}`
      const food = foodByWeek[key] || 0
      const bev = bevByWeek[key] || 0
      const headcount = headcounts[key] || 0
      const perHead = headcount > 0 ? (food + bev) / headcount : null
      costPerHead[key] = perHead
      locationWeeks.push({ location: loc, week, food, bev, headcount, perHead })
    }
  }

  const locationSummary = LOCATIONS_LIST.map((loc) => {
    const rows = locationWeeks.filter((r) => r.location === loc)
    const totalFood = rows.reduce((s, r) => s + r.food, 0)
    const totalBev = rows.reduce((s, r) => s + r.bev, 0)
    const weeksWithHeadcount = rows.filter((r) => r.perHead !== null)
    const avgPerHeadWeekly =
      weeksWithHeadcount.length > 0 ? weeksWithHeadcount.reduce((s, r) => s + r.perHead, 0) / weeksWithHeadcount.length : null
    return {
      location: loc,
      totalFood,
      totalBev,
      weeksCovered: rows.length,
      weeksWithHeadcount: weeksWithHeadcount.length,
      avgPerHeadWeekly,
      avgPerHeadMonthly: avgPerHeadWeekly !== null ? avgPerHeadWeekly * WEEKS_PER_MONTH : null,
    }
  })

  // Per-employee — average their own weekly cost-per-head across whichever
  // weeks they actually have a schedule_locations row for in this range,
  // then project to a monthly figure the same way the location summary does.
  const employeeRows = employees.map((emp) => {
    const contract = contracts
      .filter((c) => c.employee_id === emp.id)
      .sort((a, b) => (a.start_date < b.start_date ? 1 : -1))[0]

    const perHeadShares = weeks
      .map((week) => {
        const loc = empLocationByWeek[`${emp.id}|${week}`]
        if (!loc) return null
        const perHead = costPerHead[`${loc}|${week}`]
        return perHead === null || perHead === undefined ? null : perHead
      })
      .filter((v) => v !== null)

    const foodBevWeeklyAvg = perHeadShares.length > 0 ? perHeadShares.reduce((s, v) => s + v, 0) / perHeadShares.length : null
    const foodBevMonthly = foodBevWeeklyAvg !== null ? foodBevWeeklyAvg * WEEKS_PER_MONTH : null

    const salary = Number(contract?.salary || 0)
    const healthcare = Number(contract?.medical_aid_monthly_cost || 0)
    const pension = Number(contract?.pension_fund_monthly_cost || 0)
    const housing = Number(contract?.housing_monthly_cost || 0)
    const foodBev = foodBevMonthly || 0

    return {
      employee: emp,
      contract,
      salary,
      healthcare,
      pension,
      housing,
      foodBevMonthly: foodBevMonthly,
      hasScheduleData: perHeadShares.length > 0,
      totalMonthly: salary + healthcare + pension + housing + foodBev,
    }
  })

  return { weeks, locationWeeks, locationSummary, employeeRows }
}
