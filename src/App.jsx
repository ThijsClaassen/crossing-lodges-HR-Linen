import { Fragment, useEffect, useMemo, useState, useLayoutEffect, useRef } from 'react'
import { sb, LOCATIONS, UNIFORM_CATEGORIES, LINEN_CATEGORIES, MOVEMENT_REASONS, CONTRACT_TYPES } from './sb.js'
import { getRealStaffCostOverview } from './staffCostEngine.js'
import { allBalances, entitlementForEmployee, LEAVE_TYPE_LABELS } from './leaveEngine.js'
import { guestsByLodgeAndDate, requiredCountFor } from './staffingCoverageEngine.js'
import {
  patternFor,
  statusForDate,
  workingDaysInRange,
  describePattern,
  missingSetup,
  parseDateOnly,
  fmtDateOnly,
  addDays,
  WEEKDAY_NAMES,
  rosteredOffByEmployee,
  rosteredDayIsRedundant,
} from './shiftPatterns.js'
import { colors, fonts, css } from './theme.js'
import { supabase } from './supabaseClient.js'
import Login from './Login.jsx'
import SetPassword from './SetPassword.jsx'
import { CompanyProvider, useCompany } from './CompanyContext.jsx'
import { SUPABASE_URL } from './supabaseClient'
import { resolveCompanyLogo, logoStyle } from './companyLogo.js'
import {
  QUALIFICATION_KINDS, KIND_LABEL, LICENCE_CLASSES, expiryStatus, expiryLabel, groupByUrgency,
  describeQualification, bestLicence, uploadQualificationFile, qualificationFileUrl, removeQualificationFile,
} from './qualifications.js'
import { buildAppraisalPack, appraisalHtml } from './appraisal.js'
import { parseCsv, guessColumnMap, normaliseRows, weeklyTrend, rosterForWeek, departmentTrend, CATEGORY_GUESS, memberFeedback, reviewOverall, MEMBER_REVIEW_MIN_COUNT } from './guestFeedback.js'
import { isoDate, todayIso } from './dates.js'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------


// Deep links from the Finance Dashboard (#489, 2026-09-27): ?page=<tab id>
// opens that tab, ?loc=<lodge id> picks that lodge. Read once at mount; an
// unknown id falls back to the default so a stale link never breaks the app.
function urlParam(name) {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(name)
}

function fmt(n, decimals = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return Number(n).toLocaleString('en-ZA', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function todayStr() {
  return todayIso()
}

function daysUntil(dateStr) {
  if (!dateStr) return null
  const ms = new Date(dateStr).getTime() - new Date(todayStr()).getTime()
  return Math.round(ms / 86400000)
}

// "Current" contract per employee is derived — whichever has the latest
// start_date — rather than a stored status flag, so there's nothing to
// keep in sync when a new contract is added.
function currentContract(employeeId, contracts) {
  const mine = contracts.filter((c) => c.employee_id === employeeId)
  if (!mine.length) return null
  return mine.slice().sort((a, b) => (a.start_date < b.start_date ? 1 : -1))[0]
}

// ---------------------------------------------------------------------------
// Work schedule — date math for the 21-days-on / 7-days-off rotation.
// Cycles are NOT locked to calendar-week boundaries — an employee's anchor
// date can be any day, so a single calendar week can show a mix of on/off
// days around the transition. Everything below works at day granularity;
// the schedule grid only groups days into weeks for display.
// ---------------------------------------------------------------------------

// Work schedule — date math now lives in shiftPatterns.js, which holds every
// shape of working life this app understands (#453). Before that it was two
// constants here: 21 days on, 7 off, for everybody.
//
// parseDateOnly / fmtDateOnly / addDays are imported from there rather than
// defined here as well. Two copies of a date convention is two chances for
// them to drift, and a day's drift moves somebody's off day.

// Start of the display "week" containing `date`, per a configurable start
// day (0 = Sun .. 6 = Sat, same convention as Date.getDay()). Defaults to
// Monday, matching the old hardcoded behaviour. This is purely a display
// grouping — nothing about on/off status consults it, so changing it cannot
// affect anyone's actual schedule, only how the grid buckets days.
function startOfWeek(date, weekStartDay = 1) {
  const day = date.getDay()
  const diff = (day - weekStartDay + 7) % 7
  return addDays(date, -diff)
}

// { status: 'on' | 'off' | 'none', blockStart? } for one employee on one day.
//
// Takes the EMPLOYEE, not just their anchor date, because which pattern
// applies is a property of the person now. An employee with no pattern falls
// back to the legacy 21/7 rotation, so this returns exactly what it used to
// for anyone not yet migrated.
function cycleStatusForDate(employee, patternsById, date, rosterByEmployee = null) {
  return statusForDate(
    patternFor(employee, patternsById),
    employee?.cycle_anchor_date,
    date,
    rosterByEmployee?.[employee?.id] || null,
  )
}

// How many days in [startStr, endStr] inclusive fall on a day this employee
// was already scheduled to work — used to snapshot the leave deduction when
// it is logged, so days that were already off cost nothing.
//
// The snapshot matters: hr_leave.days_used stores the figure at log time, so
// changing somebody's pattern later does NOT retroactively rewrite what their
// past leave cost. That is deliberate — a balance that moves under you is
// worse than one that is slightly out of date.
function countWorkingDaysInRange(employee, patternsById, startStr, endStr, rosterByEmployee = null) {
  return workingDaysInRange(
    patternFor(employee, patternsById),
    employee?.cycle_anchor_date,
    startStr,
    endStr,
    rosterByEmployee?.[employee?.id] || null,
  )
}

// Is `date` covered by any logged leave period for this employee? Leave
// always overrides the calculated on/off status for display purposes.
function leaveOnDate(leaveRows, employeeId, date) {
  const ds = fmtDateOnly(date)
  return leaveRows.find((l) => l.employee_id === employeeId && l.start_date <= ds && l.end_date >= ds) || null
}

// ---------------------------------------------------------------------------
// Shared styles (inline CSS-in-JS, same tokens as the other three apps)
// ---------------------------------------------------------------------------

const styles = {
  app: {
    fontFamily: fonts.body,
    background: colors.bg,
    minHeight: '100vh',
    color: colors.cream,
    paddingBottom: 72,
  },
  header: {
    background: colors.panel,
    borderBottom: `1px solid ${colors.border}`,
    color: colors.cream,
    padding: '14px 16px 10px',
    position: 'sticky',
    top: 0,
    zIndex: 10,
  },
  headerTitle: {
    fontFamily: fonts.heading,
    fontSize: 22,
    fontWeight: 600,
    marginBottom: 10,
    color: colors.cream,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  logo: { height: 28, width: 'auto', display: 'block' },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  pillGroup: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  pill: (active, locId) => ({
    padding: '6px 12px',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    border: `1px solid ${locId ? colors.loc[locId] : colors.border}`,
    background: active ? (locId ? colors.loc[locId] : colors.navy) : 'transparent',
    color: active ? colors.bg : locId ? colors.loc[locId] : colors.cream,
    cursor: 'pointer',
  }),
  content: { padding: 14, maxWidth: 1100, margin: '0 auto', boxSizing: 'border-box' },
  desktopTabRow: {
    display: 'flex',
    gap: 4,
    padding: '0 20px',
    background: colors.panel,
    borderBottom: `1px solid ${colors.border}`,
    overflowX: 'auto',
  },
  desktopTab: (active) => ({
    padding: '12px 16px',
    fontSize: 13,
    fontWeight: active ? 700 : 500,
    color: active ? colors.goldLt : colors.muted,
    background: 'none',
    border: 'none',
    borderBottom: active ? `2px solid ${colors.gold}` : '2px solid transparent',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }),
  card: {
    background: colors.panel,
    // --card-border resolves to a hairline on dark and to transparent on
    // light, where the shadow does the work instead. An inline style can't
    // express a per-mode rule, which is why this is a token.
    border: '1px solid var(--card-border)',
    borderRadius: 'var(--radius-md)',
    boxShadow: 'var(--shadow-md)',
    padding: 14,
    marginBottom: 12,
    maxWidth: '100%',
    boxSizing: 'border-box',
  },
  tableWrap: {
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    marginLeft: -14,
    marginRight: -14,
    paddingLeft: 14,
    paddingRight: 14,
  },
  cardTitle: {
    fontFamily: fonts.heading,
    fontSize: 19,
    fontWeight: 600,
    marginBottom: 10,
    color: colors.goldLt,
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    textAlign: 'left',
    padding: '6px 8px',
    borderBottom: `2px solid ${colors.border}`,
    color: colors.muted,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  td: { padding: '6px 8px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' },
  tdNum: {
    padding: '6px 8px',
    borderBottom: `1px solid ${colors.border}`,
    whiteSpace: 'nowrap',
    fontFamily: fonts.mono,
  },
  input: {
    width: '100%',
    padding: '7px 9px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    background: colors.bg,
    color: colors.cream,
    fontSize: 13,
    boxSizing: 'border-box',
  },
  smallInput: {
    width: 80,
    padding: '5px 7px',
    borderRadius: 6,
    border: `1px solid ${colors.border}`,
    background: colors.bg,
    color: colors.cream,
    fontFamily: fonts.mono,
    fontSize: 13,
  },
  button: {
    padding: '9px 14px',
    borderRadius: 8,
    border: 'none',
    background: colors.navy,
    color: colors.cream,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
  },
  buttonGhost: {
    padding: '9px 14px',
    borderRadius: 8,
    border: `1px solid ${colors.gold}`,
    background: 'transparent',
    color: colors.goldLt,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
  },
  buttonDanger: {
    padding: '5px 9px',
    borderRadius: 6,
    border: 'none',
    background: 'rgba(192,88,88,0.16)',
    color: colors.danger,
    fontWeight: 600,
    fontSize: 12,
    cursor: 'pointer',
  },
  banner: {
    background: 'rgba(184,147,90,0.12)',
    border: `1px solid ${colors.gold}`,
    color: colors.goldLt,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    fontSize: 13,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  formGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: 8,
    marginBottom: 10,
  },
  label: { fontSize: 11, color: colors.muted, marginBottom: 3, display: 'block' },
  // Bottom nav is a single "Menu" button (see navMenuButton) rather than a
  // row of tabs — with 8-9 tabs on some roles, a horizontal-scroll bar
  // either clips tabs off-screen or needs a swipe gesture nobody discovers
  // on their own. Tapping the button opens navSheet, a bottom-anchored
  // list of every tab, so every tab is always one predictable tap away
  // regardless of how many exist.
  navBar: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    background: colors.panel,
    borderTop: `1px solid ${colors.border}`,
    padding: 8,
    zIndex: 10,
    boxSizing: 'border-box',
  },
  navMenuButton: {
    width: '100%',
    maxWidth: 1100,
    margin: '0 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '11px 14px',
    borderRadius: 10,
    border: `1px solid ${colors.gold}`,
    background: 'rgba(184,147,90,0.12)',
    color: colors.goldLt,
    fontWeight: 700,
    fontSize: 14,
    cursor: 'pointer',
  },
  navOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    zIndex: 20,
  },
  navSheet: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '75vh',
    overflowY: 'auto',
    background: colors.panel,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    border: `1px solid ${colors.border}`,
    borderBottom: 'none',
    boxSizing: 'border-box',
  },
  navSheetHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '14px 16px',
    borderBottom: `1px solid ${colors.border}`,
    position: 'sticky',
    top: 0,
    background: colors.panel,
  },
  navSheetTitle: {
    fontFamily: fonts.heading,
    fontSize: 18,
    fontWeight: 600,
    color: colors.goldLt,
  },
  navSheetClose: {
    padding: '4px 10px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    background: 'transparent',
    color: colors.cream,
    fontSize: 14,
    cursor: 'pointer',
  },
  navSheetItem: (active) => ({
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '14px 16px',
    borderBottom: `1px solid ${colors.border}`,
    background: active ? 'rgba(184,147,90,0.12)' : 'none',
    color: active ? colors.goldLt : colors.cream,
    fontWeight: active ? 700 : 500,
    fontSize: 15,
    cursor: 'pointer',
  }),
  badge: (tone) => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    fontFamily: fonts.mono,
    background:
      tone === 'bad' ? 'rgba(192,88,88,0.16)' : tone === 'good' ? 'rgba(90,155,114,0.16)' : 'rgba(138,136,153,0.16)',
    color: tone === 'bad' ? colors.danger : tone === 'good' ? colors.ok : colors.muted,
  }),
}

// Staff: day-to-day operational tasks only.
// Admin: all of Staff, plus employees, item catalogs, suppliers, orders.
// HR Admin: all of Admin, plus Contracts (salary/medical aid/pension).
const STAFF_TABS = [
  { id: 'uniforms', label: 'Uniforms' },
  { id: 'linen', label: 'Linen' },
]
const ADMIN_TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'employees', label: 'Employees' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'leave', label: 'Leave' },
  { id: 'uniforms', label: 'Uniforms' },
  { id: 'linen', label: 'Linen' },
  { id: 'suppliers', label: 'Suppliers' },
  { id: 'orders', label: 'Orders' },
  { id: 'feedback', label: 'Guest Feedback' },
]
const HRADMIN_TABS = [
  ...ADMIN_TABS,
  { id: 'contracts', label: 'Contracts' },
  { id: 'staffcost', label: 'Staff Cost' },
  { id: 'loans', label: 'Staff Loans' },
  { id: 'appraisals', label: 'Appraisals' },
]

function tabsForRole(role) {
  if (role === 'hradmin') return HRADMIN_TABS
  if (role === 'admin') return ADMIN_TABS
  return STAFF_TABS
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const ROLE_LABELS = { staff: 'Staff', admin: 'Admin', hradmin: 'HR Admin' }

// Real Supabase Auth replaces the old shared staff/admin/hradmin password
// checked against hr_access (2026-08-08 — HR/Linen 3b of the multi-tenant
// rebuild). hr_access is deliberately left in the schema, unused, same
// decision as food_access — cleanup is a later call.
//
// Supabase's invite/recovery links land back here with a #type=invite or
// #type=recovery hash fragment when someone lands back in the app from an
// email link — read once, synchronously, on first render, before
// supabase-js has a chance to process and clear it.
function getAuthHashType() {
  if (typeof window === 'undefined' || !window.location.hash) return null
  return new URLSearchParams(window.location.hash.slice(1)).get('type')
}

const authScreenStyle = {
  fontFamily: fonts.body,
  background: colors.bg,
  minHeight: '100vh',
  color: colors.cream,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

function AuthMessageScreen({ children }) {
  return (
    <div style={authScreenStyle}>
      <div style={{ textAlign: 'center', maxWidth: 320 }}>{children}</div>
    </div>
  )
}

export default function App() {
  // undefined = still checking for an existing session, null = signed out
  const [session, setSession] = useState(undefined)
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(() => {
    const type = getAuthHashType()
    return type === 'invite' || type === 'recovery'
  })

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) {
    return (
      <AuthMessageScreen>
        <p>Loading…</p>
      </AuthMessageScreen>
    )
  }

  if (!session) {
    return <Login />
  }

  if (needsPasswordSetup) {
    return <SetPassword onDone={() => setNeedsPasswordSetup(false)} />
  }

  // key forces CompanyProvider to reload from scratch if a different user
  // signs in without a full page refresh.
  return (
    <CompanyProvider key={session.user.id}>
      <AuthenticatedApp />
    </CompanyProvider>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function AuthenticatedApp() {
  const {
    loading: companyLoading,
    error: companyError,
    availableCompanies,
    companyId,
    companyName,
    role: baseRole,
    isHrAdmin,
    switchCompany,
    company,
} = useCompany()

  // The client's logo if they have one, ours if they don't (2026-09-22).
  // This is the read the logo feature shipped without: the settings page wrote
  // logo_path and nothing anywhere consumed it, so a client could upload their
  // logo and still see Crossing Lodges on every screen.
  const brand = resolveCompanyLogo({
    company,
    supabaseUrl: SUPABASE_URL,
    fallback: '/logo.png',
    fallbackAlt: 'Crossing Lodges',
  });

  // The app's existing tab-gating logic everywhere checks role === 'admin'
  // or role === 'hradmin' — deriving the same three-value string here means
  // none of that logic below needed to change, only where the value comes
  // from.
  const role = baseRole === 'admin' && isHrAdmin ? 'hradmin' : baseRole

  async function logout() {
    await supabase.auth.signOut()
  }

  const [tab, setTab] = useState(() => urlParam('page') || 'dashboard')
  const [menuOpen, setMenuOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [uniformEmployeeId, setUniformEmployeeId] = useState(null)
  // Licences & qualifications (#484). Which employee's modal is open, and the rows.
  const [qualEmployeeId, setQualEmployeeId] = useState(null)
  const [qualifications, setQualifications] = useState([])
  // Guest feedback (#487): imported GuestRevu exports + the company's mapping.
  const [guestFeedback, setGuestFeedback] = useState([])
  const [memberReviews, setMemberReviews] = useState([])          // #519, LL only
  const [reviewQuestions, setReviewQuestions] = useState([])
  const [feedbackSettings, setFeedbackSettings] = useState(null)

  const [employees, setEmployees] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [uniformItems, setUniformItems] = useState([])
  const [uniformStock, setUniformStock] = useState([])
  const [uniformIssues, setUniformIssues] = useState([])
  // Linen is the one part of this app that's still per-lodge — items and
  // suppliers are shared, but stock/movements are loaded for ALL lodges at
  // once here, and the Linen tab filters by its own local location switcher.
  const [linenItems, setLinenItems] = useState([])
  const [linenStock, setLinenStock] = useState([])
  const [linenMovements, setLinenMovements] = useState([])
  const [contracts, setContracts] = useState([])
  // Staff loans (2026-08-17) — HR-Admin-only reference log, same visibility
  // as Contracts. No deduction automation: just a place for Thijs to record
  // an amount + a monthly deduction figure and see it later.
  const [loans, setLoans] = useState([])
  // Bonuses (2026-08-27) — HR-Admin-only, same visibility wall as loans and
  // contracts, since amounts are as sensitive as salary.
  const [bonuses, setBonuses] = useState([])
  const [scheduleLocations, setScheduleLocations] = useState([])
  const [leave, setLeave] = useState([])
  const [leaveEntitlements, setLeaveEntitlements] = useState([])
  // Which day the Schedule tab's display weeks start on (0=Sun..6=Sat).
  // Defaults to Monday until a company sets its own via hr_settings.
  const [weekStartDay, setWeekStartDay] = useState(1)
  const [staffingRatios, setStaffingRatios] = useState([])
  const [shiftPatterns, setShiftPatterns] = useState([])
  const [rosteredOffDays, setRosteredOffDays] = useState([])

  function addLocalOffDay(row) {
    if (!row) return
    setRosteredOffDays((prev) => (prev.some((r) => r.id === row.id) ? prev : [...prev, row]))
  }

  function removeLocalOffDay(id) {
    setRosteredOffDays((prev) => prev.filter((r) => r.id !== id))
  }

  async function loadAll() {
    setLoading(true)
    setError(null)
    try {
      const base = [
        sb.select('hr_employees', { company_id: companyId, active: true }, { order: 'first_name.asc' }),
        sb.select('hr_suppliers', { company_id: companyId, active: true }, { order: 'name.asc' }),
        sb.select('hr_uniform_items', { company_id: companyId, active: true }, { order: 'category.asc,name.asc' }),
        sb.select('hr_uniform_stock', { company_id: companyId }, {}),
        sb.select('hr_uniform_issues', { company_id: companyId }, { order: 'created_at.desc' }),
        sb.select('hr_linen_items', { company_id: companyId, active: true }, { order: 'category.asc,name.asc' }),
        sb.select('hr_linen_stock', { company_id: companyId }, {}),
        sb.select('hr_linen_movements', { company_id: companyId }, { order: 'date.desc' }),
        sb.select('hr_schedule_locations', { company_id: companyId }, {}),
        sb.select('hr_leave', { company_id: companyId }, { order: 'start_date.desc' }),
        sb.select('hr_settings', { company_id: companyId }, {}),
        sb.select('hr_staffing_ratios', { company_id: companyId }, { order: 'position.asc,min_guests.asc' }),
      ]
      // Contracts (and now Loans, same reasoning) hold sensitive pay-related
      // data — only ever fetched for the HR Admin role, so it never transits
      // to a Staff/Admin session.
      const results = await Promise.all(
        role === 'hradmin'
          ? [
              ...base,
              sb.select('hr_contracts', { company_id: companyId }, {}),
              sb.select('hr_staff_loans', { company_id: companyId }, { order: 'loan_date.desc' }),
              // .catch so a company that hasn't run add_hr_bonuses.sql yet
              // still loads the rest of the app.
              sb.select('hr_bonuses', { company_id: companyId }, { order: 'bonus_date.desc' }).catch(() => []),
            ]
          : base
      )
      const [
        empRes,
        supRes,
        uItemsRes,
        uStockRes,
        uIssuesRes,
        lItemsRes,
        lStockRes,
        lMoveRes,
        schedLocRes,
        leaveRes,
        settingsRes,
        ratiosRes,
        conRes,
        loanRes,
        bonusRes,
      ] = results

      setEmployees(empRes || [])
      setSuppliers(supRes || [])
      setUniformItems(uItemsRes || [])
      setUniformStock(uStockRes || [])
      setUniformIssues(uIssuesRes || [])
      setLinenItems(lItemsRes || [])
      setLinenStock(lStockRes || [])
      setLinenMovements(lMoveRes || [])
      setScheduleLocations(schedLocRes || [])
      setLeave(leaveRes || [])
      // No row yet for this company (fresh install before add_hr_settings.sql
      // has ever been upserted) — fall back to Monday, the old behaviour.
      setWeekStartDay(settingsRes?.[0]?.week_start_day ?? 1)
      setStaffingRatios(ratiosRes || [])

      // Fetched separately rather than added to the Promise.all above, for
      // the reason spelled out below it: that array has a conditional branch
      // and inserting into a positional structure like that is how a previous
      // change silently shifted every result by one. .catch so a company that
      // has not run add_hr_shift_patterns.sql yet still loads the app — with
      // no patterns, every employee falls back to the legacy 21/7 rotation,
      // which is exactly what they had before.
      const patternsRes = await sb
        .select('hr_shift_patterns', { company_id: companyId, active: true }, { order: 'name.asc' })
        .catch(() => [])
      setShiftPatterns(patternsRes || [])

      // Rostered extra days off (#458). Same .catch for the same reason: a
      // company that has not run add_hr_rostered_off_days.sql yet still loads,
      // with nobody having any extra days — which is exactly right, because
      // nobody does until somebody rosters them.
      const offDaysRes = await sb
        .select('hr_employee_off_days', { company_id: companyId }, { order: 'off_date.asc' })
        .catch(() => [])
      setRosteredOffDays(offDaysRes || [])

      // Licences & qualifications (#484). .catch for the same reason as the
      // two above: before add_hr_qualifications.sql has run, nobody has any.
      const qualRes = await sb
        .select('hr_qualifications', { company_id: companyId }, { order: 'expires_on.asc' })
        .catch(() => [])
      setQualifications(qualRes || [])

      // Guest feedback (#487). Same .catch: nothing until add_guest_feedback.sql.
      const fbRes = await sb.select('guest_feedback', { company_id: companyId }, { order: 'stay_date.desc' }).catch(() => [])
      setGuestFeedback(fbRes || [])
      const fbSet = await sb.select('guest_feedback_settings', { company_id: companyId }, {}).catch(() => [])
      setFeedbackSettings(fbSet?.[0] || null)
      // Member reviews of staff visits (#519). Only companies with member
      // billing have any; .catch until add_member_visit_reviews.sql has run.
      const mrRes = await sb.select('member_visit_reviews', { company_id: companyId }, { order: 'visit_date.desc' }).catch(() => [])
      setMemberReviews(mrRes || [])
      const rqRes = await sb.select('member_review_questions', { company_id: companyId }, { order: 'sort_order.asc' }).catch(() => [])
      setReviewQuestions(rqRes || [])
      setContracts(conRes || [])
      setLoans(loanRes || [])
      setBonuses(bonusRes || [])

      // Fetched on its own rather than added to the Promise.all above. That
      // array has a conditional branch (hradmin gets three extra queries),
      // and inserting into a positional structure like that is precisely how
      // a previous change silently shifted every result by one — names still
      // matched, wrong data behind each. The extra round-trip costs nothing;
      // getting this wrong would be invisible. .catch so a company that
      // hasn't run add_hr_leave_types.sql yet still loads the app, falling
      // back to the BCEA defaults baked into leaveEngine.
      const entRes = await sb
        .select('hr_leave_entitlements', { company_id: companyId }, { order: 'sort_order.asc' })
        .catch(() => [])
      setLeaveEntitlements(entRes || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (role && companyId) loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, companyId])

  // ---------------------------------------------------------------------------
  // Local (optimistic) state updates — patch just the affected row(s) from
  // what the server handed back instead of re-fetching everything.
  // ---------------------------------------------------------------------------
  function addLocalEmployee(row) {
    setEmployees((prev) => [...prev, row])
  }
  function updateLocalEmployee(row) {
    setEmployees((prev) => prev.map((e) => (e.id === row.id ? row : e)))
  }
  function removeLocalEmployee(id) {
    setEmployees((prev) => prev.filter((e) => e.id !== id))
  }

  function addLocalSupplier(row) {
    setSuppliers((prev) => [...prev, row])
  }
  function updateLocalSupplier(row) {
    setSuppliers((prev) => prev.map((s) => (s.id === row.id ? row : s)))
  }
  function removeLocalSupplier(id) {
    setSuppliers((prev) => prev.filter((s) => s.id !== id))
  }

  function addLocalUniformItem(row) {
    setUniformItems((prev) => [...prev, row])
  }
  function updateLocalUniformItem(row) {
    setUniformItems((prev) => prev.map((it) => (it.id === row.id ? row : it)))
  }
  function removeLocalUniformItem(id) {
    setUniformItems((prev) => prev.filter((it) => it.id !== id))
  }
  function upsertLocalUniformStock(rows) {
    const list = Array.isArray(rows) ? rows : [rows]
    setUniformStock((prev) => {
      const map = new Map(prev.map((s) => [s.item_id, s]))
      for (const row of list) map.set(row.item_id, row)
      return Array.from(map.values())
    })
  }
  function addLocalUniformIssues(rows) {
    const list = Array.isArray(rows) ? rows : [rows]
    setUniformIssues((prev) => [...list, ...prev])
  }
  function updateLocalUniformIssues(rows) {
    const list = Array.isArray(rows) ? rows : [rows]
    setUniformIssues((prev) => prev.map((i) => list.find((r) => r.id === i.id) || i))
  }
  function removeLocalUniformIssue(id) {
    setUniformIssues((prev) => prev.filter((i) => i.id !== id))
  }

  function addLocalLinenItem(row) {
    setLinenItems((prev) => [...prev, row])
  }
  function updateLocalLinenItem(row) {
    setLinenItems((prev) => prev.map((it) => (it.id === row.id ? row : it)))
  }
  function removeLocalLinenItem(id) {
    setLinenItems((prev) => prev.filter((it) => it.id !== id))
  }
  function upsertLocalLinenStock(rows) {
    const list = Array.isArray(rows) ? rows : [rows]
    setLinenStock((prev) => {
      const map = new Map(prev.map((s) => [`${s.item_id}|${s.location_id}`, s]))
      for (const row of list) map.set(`${row.item_id}|${row.location_id}`, row)
      return Array.from(map.values())
    })
  }
  function addLocalLinenMovement(row) {
    setLinenMovements((prev) => [row, ...prev])
  }

  function addLocalContract(row) {
    setContracts((prev) => [...prev, row])
  }
  function updateLocalContract(row) {
    setContracts((prev) => prev.map((c) => (c.id === row.id ? row : c)))
  }

  function addLocalLoan(row) {
    setLoans((prev) => [row, ...prev])
  }
  function updateLocalLoan(row) {
    setLoans((prev) => prev.map((l) => (l.id === row.id ? row : l)))
  }
  function removeLocalLoan(id) {
    setLoans((prev) => prev.filter((l) => l.id !== id))
  }

  function upsertLocalScheduleLocation(row) {
    setScheduleLocations((prev) => {
      const idx = prev.findIndex((s) => s.employee_id === row.employee_id && s.week_start_date === row.week_start_date)
      if (idx === -1) return [...prev, row]
      const copy = prev.slice()
      copy[idx] = row
      return copy
    })
  }
  function addLocalLeave(row) {
    setLeave((prev) => [row, ...prev])
  }
  function removeLocalLeave(id) {
    setLeave((prev) => prev.filter((l) => l.id !== id))
  }

  async function saveWeekStartDay(day) {
    setWeekStartDay(day) // optimistic — the grid should snap immediately
    const [row] = await sb.upsert('hr_settings', { company_id: companyId, week_start_day: day }, 'company_id')
    if (row) setWeekStartDay(row.week_start_day)
  }

  async function addStaffingRatio(tier) {
    const [row] = await sb.insert('hr_staffing_ratios', { ...tier, company_id: companyId })
    setStaffingRatios((prev) => [...prev, row].sort((a, b) => a.position.localeCompare(b.position) || a.min_guests - b.min_guests))
  }
  async function removeStaffingRatio(id) {
    await sb.remove('hr_staffing_ratios', { id })
    setStaffingRatios((prev) => prev.filter((r) => r.id !== id))
  }

  const employeeById = useMemo(() => {
    const map = {}
    for (const e of employees) map[e.id] = e
    return map
  }, [employees])

  const supplierById = useMemo(() => {
    const map = {}
    for (const s of suppliers) map[s.id] = s
    return map
  }, [suppliers])

  const uniformStockByItem = useMemo(() => {
    const map = {}
    for (const s of uniformStock) map[s.item_id] = s
    return map
  }, [uniformStock])

  // Company-access guards — placed here, after every hook above, rather
  // than before them: React requires the same hooks to run on every render
  // in the same order, so an early return can't come before a useState.
  if (companyLoading) {
    return (
      <AuthMessageScreen>
        <p>Loading your account…</p>
      </AuthMessageScreen>
    )
  }

  if (companyError) {
    return (
      <AuthMessageScreen>
        <p style={{ color: colors.danger, marginBottom: 12 }}>Could not load your company access: {companyError}</p>
        <button style={styles.button} onClick={logout}>
          Log out
        </button>
      </AuthMessageScreen>
    )
  }

  if (!companyId) {
    return (
      <AuthMessageScreen>
        <p style={{ marginBottom: 12 }}>
          Your account isn't linked to any company yet. Contact your administrator to get access.
        </p>
        <button style={styles.button} onClick={logout}>
          Log out
        </button>
      </AuthMessageScreen>
    )
  }

  const TABS = tabsForRole(role)
  const activeTab = TABS.some((t) => t.id === tab) ? tab : TABS[0].id

  return (
    <div className="shell">
      <style>{css}</style>

      {/* ── DESKTOP SIDEBAR — same shell/sidebar/nav pattern as Ops/Maintenance,
          tabs listed top-to-bottom on the left (2026-08-17). Hidden <=768px;
          the topbar + bottom-nav sheet below cover mobile. */}
      <div className="sidebar">
        <div className="sidebar-logo">
          <img
            src={brand.src}
            alt={brand.alt}
            style={{ width: '100%', ...logoStyle(brand.isClientLogo) }}
            onError={(e) => { if (e.target.src !== '/logo.png') e.target.src = '/logo.png'; }}
          />
          <div className="sidebar-sub">HR &amp; Housekeeping</div>
          <div className="sidebar-company">{companyName}</div>
        </div>

        {availableCompanies.length > 1 && (
          <div className="sidebar-select-wrap">
            <select className="sidebar-select" value={companyId} onChange={(e) => switchCompany(e.target.value)}>
              {availableCompanies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <nav className="nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`nav-item${activeTab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span style={styles.badge('neutral')}>{ROLE_LABELS[role]}</span>
          <div className="sidebar-footer-row">
            <button className="sidebar-footer-btn" onClick={loadAll}>
              Refresh
            </button>
            <button className="sidebar-footer-btn" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
      </div>

      <div className="main">
        <div className="topbar">
          <div className="page-title">{companyName} — {TABS.find((t) => t.id === activeTab)?.label}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {availableCompanies.length > 1 && (
              <select className="topbar-select" value={companyId} onChange={(e) => switchCompany(e.target.value)}>
                {availableCompanies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <span style={styles.badge('neutral')}>{ROLE_LABELS[role]}</span>
            <button className="topbar-signout" onClick={logout}>
              Log out
            </button>
          </div>
        </div>

        <div style={styles.content}>
        {error && (
          <div
            style={{
              ...styles.banner,
              background: 'rgba(192,88,88,0.12)',
              borderColor: colors.danger,
              color: colors.danger,
            }}
          >
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ padding: 20, color: colors.muted }}>Loading…</div>
        ) : (
          <>
            {activeTab === 'dashboard' && (role === 'admin' || role === 'hradmin') && (
              <DashboardTab
                role={role}
                uniformItems={uniformItems}
                uniformStockByItem={uniformStockByItem}
                uniformIssues={uniformIssues}
                linenItems={linenItems}
                linenStock={linenStock}
                linenMovements={linenMovements}
                employees={employees}
                contracts={contracts}
                qualifications={qualifications}
                onOpenQualifications={setQualEmployeeId}
              />
            )}
            {activeTab === 'employees' && (role === 'admin' || role === 'hradmin') && (
              <EmployeesTab
                companyId={companyId}
                role={role}
                employees={employees}
                shiftPatterns={shiftPatterns}
                rosteredOffDays={rosteredOffDays}
                scheduleLocations={scheduleLocations}
                leave={leave}
                entitlements={leaveEntitlements}
                contracts={contracts}
                onAdd={addLocalEmployee}
                onUpdate={updateLocalEmployee}
                onRemove={removeLocalEmployee}
                onOffDayAdd={addLocalOffDay}
                onOffDayRemove={removeLocalOffDay}
                qualifications={qualifications}
                onQualificationAdd={(row) => setQualifications((prev) => [...prev, row])}
                onQualificationRemove={(id) => setQualifications((prev) => prev.filter((q) => q.id !== id))}
                uniformItems={uniformItems}
                uniformStockByItem={uniformStockByItem}
                uniformIssues={uniformIssues}
                onStockChange={upsertLocalUniformStock}
                onIssuesAdd={addLocalUniformIssues}
                onIssuesUpdate={updateLocalUniformIssues}
                onIssuesRemove={removeLocalUniformIssue}
              />
            )}
            {activeTab === 'schedule' && (role === 'admin' || role === 'hradmin') && (
              <ScheduleTab
                companyId={companyId}
                employees={employees}
                shiftPatterns={shiftPatterns}
                rosteredOffDays={rosteredOffDays}
                onOffDayAdd={addLocalOffDay}
                onOffDayRemove={removeLocalOffDay}
                scheduleLocations={scheduleLocations}
                leave={leave}
                weekStartDay={weekStartDay}
                onWeekStartDayChange={saveWeekStartDay}
                staffingRatios={staffingRatios}
                onAddStaffingRatio={addStaffingRatio}
                onRemoveStaffingRatio={removeStaffingRatio}
                onUpdateEmployee={updateLocalEmployee}
                onScheduleLocationChange={upsertLocalScheduleLocation}
              />
            )}
            {activeTab === 'leave' && (role === 'admin' || role === 'hradmin') && (
              <LeaveTab
                companyId={companyId}
                employees={employees}
                shiftPatterns={shiftPatterns}
                rosteredOffDays={rosteredOffDays}
                leave={leave}
                entitlements={leaveEntitlements}
                onUpdateEmployee={updateLocalEmployee}
                onLeaveAdd={addLocalLeave}
                onLeaveRemove={removeLocalLeave}
              />
            )}
            {activeTab === 'uniforms' && (
              <UniformsTab
                role={role}
                companyId={companyId}
                items={uniformItems}
                stockByItem={uniformStockByItem}
                issues={uniformIssues}
                employees={employees}
                suppliers={suppliers}
                onItemAdd={addLocalUniformItem}
                onItemUpdate={updateLocalUniformItem}
                onItemRemove={removeLocalUniformItem}
                onStockChange={upsertLocalUniformStock}
                onIssuesAdd={addLocalUniformIssues}
                onSelectEmployee={setUniformEmployeeId}
              />
            )}
            {activeTab === 'linen' && (
              <LinenTab
                role={role}
                companyId={companyId}
                items={linenItems}
                stock={linenStock}
                movements={linenMovements}
                suppliers={suppliers}
                onItemAdd={addLocalLinenItem}
                onItemUpdate={updateLocalLinenItem}
                onItemRemove={removeLocalLinenItem}
                onStockChange={upsertLocalLinenStock}
                onMovementAdd={addLocalLinenMovement}
              />
            )}
            {activeTab === 'suppliers' && (role === 'admin' || role === 'hradmin') && (
              <SuppliersTab
                companyId={companyId}
                suppliers={suppliers}
                onAdd={addLocalSupplier}
                onUpdate={updateLocalSupplier}
                onRemove={removeLocalSupplier}
                uniformItems={uniformItems}
                uniformStockByItem={uniformStockByItem}
                linenItems={linenItems}
                linenStock={linenStock}
              />
            )}
            {activeTab === 'orders' && (role === 'admin' || role === 'hradmin') && (
              <OrdersTab
                uniformItems={uniformItems}
                uniformStockByItem={uniformStockByItem}
                linenItems={linenItems}
                linenStock={linenStock}
                supplierById={supplierById}
              />
            )}
            {activeTab === 'contracts' && role === 'hradmin' && (
              <ContractsTab
                companyId={companyId}
                employees={employees}
                contracts={contracts}
                onAdd={addLocalContract}
                onUpdate={updateLocalContract}
              />
            )}
            {activeTab === 'staffcost' && role === 'hradmin' && (
              <StaffCostTab companyId={companyId} employees={employees} contracts={contracts} scheduleLocations={scheduleLocations} bonuses={bonuses} setBonuses={setBonuses} />
            )}
            {activeTab === 'feedback' && (role === 'admin' || role === 'hradmin') && (
              <GuestFeedbackTab
                companyId={companyId}
                employees={employees}
                scheduleLocations={scheduleLocations}
                feedback={guestFeedback}
                setFeedback={setGuestFeedback}
                settings={feedbackSettings}
                setSettings={setFeedbackSettings}
                memberReviews={memberReviews}
                reviewQuestions={reviewQuestions}
                setReviewQuestions={setReviewQuestions}
                role={role}
              />
            )}
            {activeTab === 'appraisals' && role === 'hradmin' && (
              <AppraisalsTab
                companyId={companyId}
                companyName={companyName}
                employees={employees}
                contracts={contracts}
                qualifications={qualifications}
                leave={leave}
                rosteredOffDays={rosteredOffDays}
                bonuses={bonuses}
                shiftPatterns={shiftPatterns}
                scheduleLocations={scheduleLocations}
                guestFeedback={guestFeedback}
                feedbackSettings={feedbackSettings}
                memberReviews={memberReviews}
                reviewQuestions={reviewQuestions}
              />
            )}
            {activeTab === 'loans' && role === 'hradmin' && (
              <LoansTab
                companyId={companyId}
                employees={employees}
                loans={loans}
                onAdd={addLocalLoan}
                onUpdate={updateLocalLoan}
                onRemove={removeLocalLoan}
              />
            )}
          </>
        )}
      </div>

        <div className="bottom-nav">
          <button style={styles.navMenuButton} onClick={() => setMenuOpen(true)}>
            <span>☰</span>
            <span>{TABS.find((t) => t.id === activeTab)?.label || 'Menu'}</span>
          </button>
        </div>

        {menuOpen && (
          <div style={styles.navOverlay} onClick={() => setMenuOpen(false)}>
            <div style={styles.navSheet} onClick={(e) => e.stopPropagation()}>
              <div style={styles.navSheetHeader}>
                <span style={styles.navSheetTitle}>Menu</span>
                <button style={styles.navSheetClose} onClick={() => setMenuOpen(false)}>
                  Close
                </button>
              </div>
              {TABS.map((t) => (
                <button
                  key={t.id}
                  style={styles.navSheetItem(activeTab === t.id)}
                  onClick={() => {
                    setTab(t.id)
                    setMenuOpen(false)
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {uniformEmployeeId && employeeById[uniformEmployeeId] && (
          <EmployeeUniformModal
            role={role}
            companyId={companyId}
            employee={employeeById[uniformEmployeeId]}
            items={uniformItems}
            stockByItem={uniformStockByItem}
            issues={uniformIssues}
            onClose={() => setUniformEmployeeId(null)}
            onStockChange={upsertLocalUniformStock}
            onIssuesAdd={addLocalUniformIssues}
            onIssuesUpdate={updateLocalUniformIssues}
            onIssuesRemove={removeLocalUniformIssue}
          />
        )}

        {qualEmployeeId && employeeById[qualEmployeeId] && (
          <EmployeeQualificationsModal
            companyId={companyId}
            employee={employeeById[qualEmployeeId]}
            rows={qualifications.filter((q) => q.employee_id === qualEmployeeId)}
            onClose={() => setQualEmployeeId(null)}
            onAdd={(row) => setQualifications((prev) => [...prev, row])}
            onRemove={(id) => setQualifications((prev) => prev.filter((q) => q.id !== id))}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dashboard tab — Admin/HR Admin: low-stock alerts across uniforms and
// linen, plus (HR Admin only) contracts expiring soon.
// ---------------------------------------------------------------------------

function lowStockRows(items, stockByItem) {
  return items
    .map((it) => ({ item: it, stock: stockByItem[it.id] }))
    .filter((x) => x.stock && Number(x.stock.qty_on_hand) <= Number(x.stock.min_units))
}

// Linen stock has one row per item PER LODGE, so low-stock is evaluated
// per (item, lodge) pair rather than per item.
function lowStockRowsLinen(items, stock) {
  const itemById = {}
  for (const it of items) itemById[it.id] = it
  return stock
    .filter((s) => Number(s.qty_on_hand) <= Number(s.min_units) && itemById[s.item_id])
    .map((s) => ({ item: itemById[s.item_id], stock: s }))
}

function DashboardTab({ role, uniformItems, uniformStockByItem, uniformIssues, linenItems, linenStock, linenMovements, employees, contracts, qualifications = [], onOpenQualifications }) {
  const [writeOffYear, setWriteOffYear] = useState(new Date().getFullYear())

  const lowUniforms = useMemo(() => lowStockRows(uniformItems, uniformStockByItem), [uniformItems, uniformStockByItem])
  const lowLinen = useMemo(() => lowStockRowsLinen(linenItems, linenStock), [linenItems, linenStock])

  const uniformStockValue = useMemo(
    () => uniformItems.reduce((sum, it) => sum + Number(it.price || 0) * Number(uniformStockByItem[it.id]?.qty_on_hand ?? 0), 0),
    [uniformItems, uniformStockByItem]
  )

  const linenItemById = useMemo(() => {
    const map = {}
    for (const it of linenItems) map[it.id] = it
    return map
  }, [linenItems])

  const linenStockValue = useMemo(
    () => linenStock.reduce((sum, s) => sum + Number(linenItemById[s.item_id]?.price || 0) * Number(s.qty_on_hand || 0), 0),
    [linenStock, linenItemById]
  )

  const uniformItemById = useMemo(() => {
    const map = {}
    for (const it of uniformItems) map[it.id] = it
    return map
  }, [uniformItems])

  const availableYears = useMemo(() => {
    const years = new Set([new Date().getFullYear()])
    for (const i of uniformIssues) if (i.status === 'broken' && i.resolved_date) years.add(new Date(i.resolved_date).getFullYear())
    for (const m of linenMovements) if (m.date) years.add(new Date(m.date).getFullYear())
    return Array.from(years).sort((a, b) => b - a)
  }, [uniformIssues, linenMovements])

  const uniformWriteOffs = useMemo(() => {
    const rows = uniformIssues.filter(
      (i) => i.status === 'broken' && i.resolved_date && new Date(i.resolved_date).getFullYear() === writeOffYear
    )
    const value = rows.reduce((sum, i) => sum + Number(uniformItemById[i.item_id]?.price || 0), 0)
    return { count: rows.length, value }
  }, [uniformIssues, uniformItemById, writeOffYear])

  const linenWriteOffs = useMemo(() => {
    const rows = linenMovements.filter(
      (m) => (m.reason === 'Lost' || m.reason === 'Damaged') && m.date && new Date(m.date).getFullYear() === writeOffYear
    )
    const count = rows.reduce((sum, m) => sum + Math.abs(Number(m.qty_change || 0)), 0)
    const value = rows.reduce((sum, m) => sum + Math.abs(Number(m.qty_change || 0)) * Number(linenItemById[m.item_id]?.price || 0), 0)
    return { count, value }
  }, [linenMovements, linenItemById, writeOffYear])

  // Only ever look at each employee's CURRENT (latest-start_date) contract —
  // otherwise a superseded old contract that happened to have a near-term
  // end_date keeps showing up here forever even after a new contract with a
  // later/blank end_date was added for that same employee (2026-08-19 fix,
  // reported by Thijs: "contracts that expired are not going away after
  // adding a new contract").
  const expiringSoon = useMemo(() => {
    if (role !== 'hradmin') return []
    const employeeIds = Array.from(new Set(contracts.map((c) => c.employee_id)))
    return employeeIds
      .map((id) => currentContract(id, contracts))
      .filter(Boolean)
      .map((c) => ({ contract: c, days: daysUntil(c.end_date) }))
      .filter((x) => x.contract.end_date && x.days !== null && x.days <= 60)
      .sort((a, b) => a.days - b.days)
  }, [role, contracts])

  // Already run out vs still running. Kept as one sorted list above and split
  // here so the ordering rule stays in one place.
  const expired = useMemo(() => expiringSoon.filter((x) => x.days < 0), [expiringSoon])
  const upcoming = useMemo(() => expiringSoon.filter((x) => x.days >= 0), [expiringSoon])

  // Licences & qualifications running out (#484). Only for people still on
  // the books — a licence on a departed employee's record is not a problem.
  const qualUrgency = useMemo(() => {
    const active = new Set(employees.map((e) => e.id))
    return groupByUrgency(qualifications.filter((q) => active.has(q.employee_id)))
  }, [qualifications, employees])

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>At a glance</div>
        <div style={{ ...styles.row, gap: 20 }}>
          <div>
            <div style={{ fontSize: 22, fontFamily: fonts.mono, color: colors.goldLt }}>{employees.length}</div>
            <div style={{ fontSize: 11, color: colors.muted }}>Active employees</div>
          </div>
          <div>
            <div style={{ fontSize: 22, fontFamily: fonts.mono, color: colors.goldLt }}>{lowUniforms.length}</div>
            <div style={{ fontSize: 11, color: colors.muted }}>Uniform items low on stock</div>
          </div>
          <div>
            <div style={{ fontSize: 22, fontFamily: fonts.mono, color: colors.goldLt }}>{lowLinen.length}</div>
            <div style={{ fontSize: 11, color: colors.muted }}>Linen items low on stock (any lodge)</div>
          </div>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Stock value</div>
        <div style={{ ...styles.row, gap: 20 }}>
          <div>
            <div style={{ fontSize: 22, fontFamily: fonts.mono, color: colors.goldLt }}>R {fmt(uniformStockValue)}</div>
            <div style={{ fontSize: 11, color: colors.muted }}>Uniforms (company-wide)</div>
          </div>
          <div>
            <div style={{ fontSize: 22, fontFamily: fonts.mono, color: colors.goldLt }}>R {fmt(linenStockValue)}</div>
            <div style={{ fontSize: 11, color: colors.muted }}>Linen (all lodges combined)</div>
          </div>
        </div>
      </div>

      <div style={styles.card}>
        <div style={{ ...styles.row, justifyContent: 'space-between' }}>
          <div style={styles.cardTitle}>Write-offs — for budgeting</div>
          <select style={{ ...styles.smallInput, width: 90 }} value={writeOffYear} onChange={(e) => setWriteOffYear(Number(e.target.value))}>
            {availableYears.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Uniforms: items marked broken and replaced this year. Linen: items logged as Lost or Damaged
          this year. Both valued at the item's price.
        </div>
        <div style={{ ...styles.row, gap: 20 }}>
          <div>
            <div style={{ fontSize: 22, fontFamily: fonts.mono, color: colors.danger }}>
              {uniformWriteOffs.count} / R {fmt(uniformWriteOffs.value)}
            </div>
            <div style={{ fontSize: 11, color: colors.muted }}>Uniforms written off in {writeOffYear}</div>
          </div>
          <div>
            <div style={{ fontSize: 22, fontFamily: fonts.mono, color: colors.danger }}>
              {fmt(linenWriteOffs.count, 0)} / R {fmt(linenWriteOffs.value)}
            </div>
            <div style={{ fontSize: 11, color: colors.muted }}>Linen written off in {writeOffYear}</div>
          </div>
        </div>
      </div>

      {(qualUrgency.expired.length > 0 || qualUrgency.upcoming.length > 0) && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>
            {qualUrgency.expired.length > 0
              ? `Licences & qualifications — ${qualUrgency.expired.length} expired${qualUrgency.upcoming.length ? `, ${qualUrgency.upcoming.length} coming up` : ''}`
              : `Licences & qualifications — ${qualUrgency.upcoming.length} expiring within 60 days`}
          </div>
          <div style={{ fontSize: 11, color: colors.muted, marginBottom: 8 }}>
            A driver on an expired licence is an insurance problem, not an admin one — the vehicle log will not offer them.
          </div>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Employee</th>
                  <th style={styles.th}>Document</th>
                  <th style={styles.th}>Expiry</th>
                  <th style={styles.th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { key: 'expired', label: 'Expired', rows: qualUrgency.expired },
                  { key: 'upcoming', label: 'Coming up', rows: qualUrgency.upcoming },
                ]
                  .filter((g) => g.rows.length)
                  .map((g) => (
                    <Fragment key={g.key}>
                      {qualUrgency.expired.length > 0 && qualUrgency.upcoming.length > 0 && (
                        <tr>
                          <td colSpan={4} style={{ ...styles.td, fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', fontWeight: 700, color: g.key === 'expired' ? colors.danger : colors.muted }}>
                            {g.label} ({g.rows.length})
                          </td>
                        </tr>
                      )}
                      {g.rows.map(({ q, days }) => {
                        const emp = employees.find((e) => e.id === q.employee_id)
                        return (
                          <tr key={q.id}>
                            <td style={styles.td}>
                              <button style={styles.buttonGhost} onClick={() => onOpenQualifications?.(q.employee_id)}>
                                {emp ? `${emp.first_name} ${emp.last_name}` : 'Unknown'}
                              </button>
                            </td>
                            <td style={styles.td}>{describeQualification(q)}</td>
                            <td style={styles.td}>{q.expires_on}</td>
                            <td style={styles.td}>
                              <span style={styles.badge(days < 0 ? 'bad' : 'neutral')}>{expiryLabel(q)}</span>
                            </td>
                          </tr>
                        )
                      })}
                    </Fragment>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {role === 'hradmin' && (
        <div style={styles.card}>
          {/* Grouped by urgency rather than listed flat. The old version put
              a contract that ran out eight days ago on the same footing as
              one with fifty-one days to run, which buries the only row that
              needs doing something about today. expiringSoon is already
              sorted ascending by days, so expired rows lead naturally. */}
          <div style={styles.cardTitle}>
            {expired.length > 0
              ? `Contracts — ${expired.length} expired${upcoming.length ? `, ${upcoming.length} coming up` : ''}`
              : `Contracts — ${upcoming.length} expiring within 60 days`}
          </div>
          <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Employee</th>
                <th style={styles.th}>Type</th>
                <th style={styles.th}>End date</th>
                <th style={styles.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {[
                { key: 'expired', label: 'Expired', rows: expired },
                { key: 'upcoming', label: 'Coming up', rows: upcoming },
              ]
                .filter((g) => g.rows.length)
                .map((g) => (
                  <Fragment key={g.key}>
                    {expired.length > 0 && upcoming.length > 0 && (
                      <tr>
                        <td
                          colSpan={4}
                          style={{
                            ...styles.td,
                            fontSize: 10,
                            letterSpacing: '.1em',
                            textTransform: 'uppercase',
                            fontWeight: 700,
                            color: g.key === 'expired' ? colors.danger : colors.muted,
                          }}
                        >
                          {g.label} ({g.rows.length})
                        </td>
                      </tr>
                    )}
                    {g.rows.map(({ contract, days }) => {
                      const emp = employees.find((e) => e.id === contract.employee_id)
                      return (
                        <tr key={contract.id}>
                          <td style={styles.td}>{emp ? `${emp.first_name} ${emp.last_name}` : 'Unknown'}</td>
                          <td style={styles.td}>{contract.contract_type}</td>
                          <td style={styles.td}>{contract.end_date}</td>
                          <td style={styles.td}>
                            {/* Words, not a bare signed number. "-8 days" asks
                                the reader to work out what the minus means;
                                "expired 8 days ago" does not, and it still
                                reads correctly in greyscale or to someone who
                                can't separate the red from the grey. */}
                            <span style={styles.badge(days < 0 ? 'bad' : 'neutral')}>
                              {days < 0
                                ? `expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
                                : days === 0
                                  ? 'expires today'
                                  : `in ${days} day${days === 1 ? '' : 's'}`}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
              {expiringSoon.length === 0 && (
                <tr>
                  <td style={styles.td} colSpan={4}>
                    Nothing expiring in the next 60 days.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.cardTitle}>Low stock — Uniforms</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>On hand</th>
              <th style={styles.th}>Min</th>
            </tr>
          </thead>
          <tbody>
            {lowUniforms.map(({ item, stock }) => (
              <tr key={item.id}>
                <td style={styles.td}>
                  {item.name} {item.size ? `(${item.size})` : ''}
                </td>
                <td style={styles.tdNum}>{fmt(stock.qty_on_hand, 0)}</td>
                <td style={styles.tdNum}>{fmt(stock.min_units, 0)}</td>
              </tr>
            ))}
            {lowUniforms.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={3}>
                  All uniform stock is above its minimum.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Low stock — Linen</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>Lodge</th>
              <th style={styles.th}>On hand</th>
              <th style={styles.th}>Min</th>
            </tr>
          </thead>
          <tbody>
            {lowLinen.map(({ item, stock }) => (
              <tr key={stock.id}>
                <td style={styles.td}>
                  {item.name} {item.size ? `(${item.size})` : ''}
                </td>
                <td style={styles.td}>{stock.location_id}</td>
                <td style={styles.tdNum}>{fmt(stock.qty_on_hand, 0)}</td>
                <td style={styles.tdNum}>{fmt(stock.min_units, 0)}</td>
              </tr>
            ))}
            {lowLinen.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={4}>
                  All linen stock is above its minimum.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Schedule tab — Admin/HR Admin: set each employee's 21-on/7-off cycle
// anchor date, and assign which lodge they're working at for each working
// block. The grid works at day granularity (cycles don't have to align to
// calendar weeks) grouped into weekly columns for readability — a week can
// show a mix of on/off/leave around a transition.
// ---------------------------------------------------------------------------

const WEEKS_SHOWN = 6

function dayStatusColor(status) {
  if (status === 'leave') return colors.gold
  if (status === 'on') return colors.ok
  if (status === 'off') return colors.border
  return 'transparent' // 'none' — no cycle set for this employee
}

// Foldable card wrapper (2026-08-17) — used for the Schedule tab's less-
// frequently-needed blocks (Weekly schedule controls, Staffing ratios,
// Allocate lodge, Cycles) so the page opens straight to the two blocks
// Thijs actually wants at a glance (Staffing coverage, Headcount by
// position) instead of a long always-expanded scroll. `defaultOpen` is
// false everywhere it's used, per "so they won't always open automatically."
// `headerExtra` is for header-row controls (e.g. a lodge picker) that must
// stay clickable without toggling the fold — stopPropagation keeps clicks
// on it from bubbling to the header's own onClick.
function CollapsibleCard({ title, defaultOpen = false, headerExtra, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={styles.card}>
      <div
        style={{ ...styles.row, justifyContent: 'space-between', flexWrap: 'wrap', cursor: 'pointer' }}
        onClick={() => setOpen((o) => !o)}
      >
        <div style={{ ...styles.row, gap: 8 }}>
          <span
            style={{
              fontSize: 10,
              color: colors.muted,
              display: 'inline-block',
              transition: 'transform .15s',
              transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >
            ▶
          </span>
          <div style={styles.cardTitle}>{title}</div>
        </div>
        {headerExtra && <div onClick={(e) => e.stopPropagation()}>{headerExtra}</div>}
      </div>
      {open && <div style={{ marginTop: 10 }}>{children}</div>}
    </div>
  )
}

function ScheduleTab({
  companyId,
  employees,
  shiftPatterns,
  rosteredOffDays,
  onOffDayAdd,
  onOffDayRemove,
  scheduleLocations,
  leave,
  weekStartDay,
  onWeekStartDayChange,
  staffingRatios,
  onAddStaffingRatio,
  onRemoveStaffingRatio,
  onUpdateEmployee,
  onScheduleLocationChange,
}) {
  const today = parseDateOnly(todayStr())
  const [weekStart, setWeekStart] = useState(() => startOfWeek(today, weekStartDay))
  const [positionFilter, setPositionFilter] = useState('')
  const [coverageLodge, setCoverageLodge] = useState(LOCATIONS[0]?.id || '')
  const [bookings, setBookings] = useState([])
  const [bookingsLoading, setBookingsLoading] = useState(false)
  const [bookingsError, setBookingsError] = useState('')
  const [ratioForm, setRatioForm] = useState({ position: '', min_guests: '', max_guests: '', required_count: '' })
  const [savingRatio, setSavingRatio] = useState(false)

  // Re-snap the visible grid whenever the company's block-start day changes
  // (loaded async after mount, or changed live from the dropdown below) so
  // the display stays aligned to real rotation boundaries instead of the
  // stale Monday-based grid computed before hr_settings came back.
  useEffect(() => {
    setWeekStart(startOfWeek(today, weekStartDay))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStartDay])

  const weeks = useMemo(
    () =>
      Array.from({ length: WEEKS_SHOWN }, (_, i) => {
        const start = addDays(weekStart, i * 7)
        return { start, days: Array.from({ length: 7 }, (_, d) => addDays(start, d)) }
      }),
    [weekStart]
  )

  const locationByKey = useMemo(() => {
    const map = {}
    for (const s of scheduleLocations) map[`${s.employee_id}|${s.week_start_date}`] = s
    return map
  }, [scheduleLocations])

  // Patterns by id, so every status lookup below is a map hit rather than a
  // scan. Built here rather than passed in because each tab needs it and the
  // list is small.
  const patternsById = useMemo(() => {
    const m = {}
    for (const pt of shiftPatterns || []) m[pt.id] = pt
    return m
  }, [shiftPatterns])

  // Rostered extra days, grouped once per render. The schedule grid asks about
  // every employee on every visible day, so filtering the flat list per cell
  // would be a full scan of the table thousands of times per render.
  const rosterByEmployee = useMemo(() => rosteredOffByEmployee(rosteredOffDays || []), [rosteredOffDays])

  function dayInfo(employee, date) {
    if (leaveOnDate(leave, employee.id, date)) return { status: 'leave' }
    return cycleStatusForDate(employee, patternsById, date, rosterByEmployee)
  }

  function positionOf(employee) {
    return employee.position?.trim() || 'No position set'
  }

  async function saveAnchor(employeeId, value) {
    const [row] = await sb.update('hr_employees', { id: employeeId }, { cycle_anchor_date: value || null })
    onUpdateEmployee(row)
  }

  // Rostered extra days (#458). Kept as its own card rather than folded into
  // the pattern table: a pattern is a rule set once, a roster is a decision
  // made every month, and putting a month picker inside a settings table
  // makes the settings look like they change monthly too.
  const [rosterEmployeeId, setRosterEmployeeId] = useState('')
  const [rosterMonth, setRosterMonth] = useState(() => todayStr().slice(0, 7))
  const [rosterBusy, setRosterBusy] = useState(false)

  async function toggleRosteredDay(employeeId, dateStr, existingId) {
    if (!employeeId || rosterBusy) return
    setRosterBusy(true)
    try {
      if (existingId) {
        await sb.remove('hr_employee_off_days', { id: existingId })
        onOffDayRemove(existingId)
      } else {
        const [row] = await sb.insert('hr_employee_off_days', {
          company_id: companyId,
          employee_id: employeeId,
          off_date: dateStr,
        })
        onOffDayAdd(row)
      }
    } finally {
      setRosterBusy(false)
    }
  }

  async function savePattern(employeeId, value) {
    // Empty means "no pattern", which the engine reads as the legacy 21/7
    // rotation — the same thing everyone had before patterns existed, rather
    // than no schedule at all.
    const [row] = await sb.update('hr_employees', { id: employeeId }, { shift_pattern_id: value || null })
    onUpdateEmployee(row)
  }

  // Keyed by calendar week (Monday) rather than by working block — a lodge
  // can now change week to week within the same 21-day stretch. Always
  // Monday-anchored regardless of the display's own weekStartDay setting
  // (see mondayKeyOf below) — staffCostEngine.js independently computes
  // this same Monday key from food/bev issue dates to join headcount
  // against this table, so the stored convention must never move.
  async function saveWeekLocation(employeeId, weekStartStr, locationId) {
    if (!locationId) return
    const [row] = await sb.upsert(
      'hr_schedule_locations',
      { employee_id: employeeId, week_start_date: weekStartStr, location_id: locationId, company_id: companyId },
      'employee_id,week_start_date'
    )
    onScheduleLocationChange(row)
  }

  // Converts any display week's start date to the Monday-anchored key
  // hr_schedule_locations is actually keyed by — a Friday-start display
  // week still maps to exactly one stable Monday key, so this stays 1:1
  // with the visible blocks no matter what weekStartDay is set to.
  function mondayKeyOf(date) {
    return fmtDateOnly(startOfWeek(date))
  }

  const positions = useMemo(() => Array.from(new Set(employees.map(positionOf))).sort(), [employees])

  // Guest counts only need to cover whatever's currently on screen —
  // refetched whenever the visible window moves (Earlier/Later/Today) or
  // re-aligns to a new weekStartDay. revenue_bookings lives in this same
  // shared Supabase project (populated by the Finance Dashboard's Revenue
  // Importer) — read cross-app the same way staffCostEngine.js already
  // reads food_issues/bev_issues for the Staff Cost tab.
  useEffect(() => {
    const windowStart = fmtDateOnly(weeks[0].start)
    const windowEnd = fmtDateOnly(addDays(weeks[weeks.length - 1].start, 6))
    setBookingsLoading(true)
    setBookingsError('')
    sb.select(
      'revenue_bookings',
      { company_id: companyId, departure_date: `gte.${windowStart}`, arrival_date: `lte.${windowEnd}` },
      {}
    )
      .then((rows) => setBookings(rows || []))
      .catch((err) => setBookingsError(err.message || 'Could not load revenue data for the coverage check.'))
      .finally(() => setBookingsLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, weeks])

  const guestsMap = useMemo(() => guestsByLodgeAndDate(bookings), [bookings])

  const ratioPositions = useMemo(() => Array.from(new Set((staffingRatios || []).map((r) => r.position))).sort(), [staffingRatios])

  // Only counts staff explicitly assigned to `lodge` for the week
  // containing `date` (via the lodge picker on the day-strips above) — an
  // employee with no lodge picked that week doesn't count toward any
  // lodge's coverage, since we genuinely don't know where they are.
  //
  // `storageKey` must be passed in as mondayKeyOf(w.start) — the display
  // week's own start — NOT recomputed from `date` here. When weekStartDay
  // isn't Monday, a display week's later days (e.g. the Mon/Tue tail of a
  // Wed-start week) fall in a *different* calendar-Monday bucket than the
  // week's own start date. Recomputing mondayKeyOf(date) per day used to
  // look up a storage key that saveWeekLocation never wrote to (it always
  // writes under mondayKeyOf(w.start)), so those tail days silently saw no
  // lodge assignment and got flagged "short" even with staff allocated —
  // the bug Thijs reported on 2026-08-17. Always derive storageKey once
  // per week from w.start, same as renderDayStrip does when saving.
  function actualCountFor(position, lodge, date, storageKey) {
    let count = 0
    for (const e of employees) {
      if (positionOf(e) !== position) continue
      if (dayInfo(e, date).status !== 'on') continue
      const loc = locationByKey[`${e.id}|${storageKey}`]
      if (loc?.location_id === lodge) count++
    }
    return count
  }

  async function submitRatio(e) {
    e.preventDefault()
    if (!ratioForm.position || ratioForm.min_guests === '' || ratioForm.required_count === '') return
    setSavingRatio(true)
    try {
      await onAddStaffingRatio({
        position: ratioForm.position,
        min_guests: Number(ratioForm.min_guests),
        max_guests: ratioForm.max_guests === '' ? null : Number(ratioForm.max_guests),
        required_count: Number(ratioForm.required_count),
      })
      // Keep the position selected so adding the next tier in the same
      // ladder (e.g. 10-20 right after 1-9) doesn't need re-picking it.
      setRatioForm({ position: ratioForm.position, min_guests: '', max_guests: '', required_count: '' })
    } finally {
      setSavingRatio(false)
    }
  }

  function renderCoverageDayStrip(position, w) {
    // Computed once per displayed week (not per day) — must match the
    // storage key saveWeekLocation actually wrote under, see the comment
    // on actualCountFor above.
    const storageKey = mondayKeyOf(w.start)
    const cells = w.days.map((d) => {
      const dateKey = fmtDateOnly(d)
      const guests = guestsMap[`${coverageLodge}|${dateKey}`] || 0
      const required = requiredCountFor(staffingRatios, position, guests)
      const actual = actualCountFor(position, coverageLodge, d, storageKey)
      const short = required !== null && actual < required
      const color = required === null || guests <= 0 ? 'transparent' : short ? colors.danger : colors.ok
      const title =
        required === null
          ? `${dateKey} — no ratio configured for ${position}`
          : `${dateKey} — ${Math.round(guests)} guest${Math.round(guests) === 1 ? '' : 's'} at ${coverageLodge}, need ${required}, have ${actual}${short ? ' — SHORT' : ''}`
      return { dateKey, guests, required, actual, short, color, title }
    })
    const anyShort = cells.some((c) => c.short)
    return (
      <td style={styles.td} key={fmtDateOnly(w.start)}>
        <div style={{ display: 'flex', gap: 2, marginBottom: anyShort ? 4 : 0 }}>
          {cells.map((c, i) => (
            <div
              key={i}
              title={c.title}
              style={{
                width: 10,
                height: 16,
                borderRadius: 2,
                background: c.color,
                border: c.color === 'transparent' ? `1px dashed ${colors.border}` : 'none',
              }}
            />
          ))}
        </div>
        {anyShort && <span style={{ ...styles.badge('bad'), fontSize: 10 }}>{cells.filter((c) => c.short).length} short</span>}
      </td>
    )
  }

  const groupedEmployees = useMemo(() => {
    const pool = positionFilter ? employees.filter((e) => positionOf(e) === positionFilter) : employees
    const groups = {}
    for (const e of pool) (groups[positionOf(e)] ||= []).push(e)
    return Object.entries(groups)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([position, list]) => ({
        position,
        list: list.slice().sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`)),
      }))
  }, [employees, positionFilter])

  // Always across every employee (ignores the filter above) so this stays a
  // full overview regardless of what the detailed grid below is filtered to.
  const headcountByPosition = useMemo(() => {
    const groups = {}
    for (const e of employees) (groups[positionOf(e)] ||= []).push(e)
    return Object.entries(groups)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([position, list]) => ({
        position,
        counts: weeks.map((w) => list.filter((e) => w.days.some((d) => dayInfo(e, d).status === 'on')).length),
      }))
  }, [employees, weeks, leave])

  function renderDayStrip(e, w) {
    const dayStatuses = w.days.map((d) => ({ date: d, ...dayInfo(e, d) }))
    const hasOn = dayStatuses.some((d) => d.status === 'on')
    const displayKey = fmtDateOnly(w.start)
    const storageKey = mondayKeyOf(w.start)
    const loc = locationByKey[`${e.id}|${storageKey}`]
    return (
      <td style={styles.td} key={displayKey}>
        <div style={{ display: 'flex', gap: 2, marginBottom: hasOn ? 4 : 0 }}>
          {dayStatuses.map((d, i) => (
            <div
              key={i}
              title={`${fmtDateOnly(d.date)} — ${d.status}`}
              style={{
                width: 10,
                height: 16,
                borderRadius: 2,
                background: dayStatusColor(d.status),
                border: d.status === 'none' ? `1px dashed ${colors.border}` : 'none',
              }}
            />
          ))}
        </div>
        {hasOn && (
          <select
            style={{ ...styles.smallInput, width: 68, padding: '3px 5px', fontSize: 11 }}
            value={loc?.location_id || ''}
            onChange={(ev) => saveWeekLocation(e.id, storageKey, ev.target.value)}
          >
            <option value="">—</option>
            {LOCATIONS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.id}
              </option>
            ))}
          </select>
        )}
      </td>
    )
  }

  return (
    <>
      {/* Order + fold state (2026-08-17, per Thijs): Staffing coverage and
          Headcount by position stay first and always open — they're the
          at-a-glance blocks. Everything else (Allocate lodge, Weekly
          schedule controls, Staffing ratios, Cycles) is folded shut by
          default via CollapsibleCard, so the tab doesn't open to a long
          scroll of stuff that's only occasionally touched. */}
      <div style={styles.card}>
        <div style={{ ...styles.row, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={styles.cardTitle}>Staffing coverage</div>
          <select style={{ ...styles.smallInput, width: 90 }} value={coverageLodge} onChange={(e) => setCoverageLodge(e.target.value)}>
            {LOCATIONS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.id}
              </option>
            ))}
          </select>
        </div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Per day, per position: guest counts come from imported revenue bookings (Confirmed/Checked
          Out, split evenly across each stay's nights), staff counts come from who's on and assigned
          to {coverageLodge || 'this lodge'} that week above. Red = short-staffed that night, green =
          covered, dashed = no guests that night or no ratio configured for that position.
        </div>
        {bookingsLoading && <p className="message">Loading guest counts…</p>}
        {bookingsError && <p style={{ color: colors.danger }}>{bookingsError}</p>}
        {!bookingsLoading && ratioPositions.length === 0 && (
          <p className="message">Add at least one staffing ratio above to see coverage flags.</p>
        )}
        {!bookingsLoading && ratioPositions.length > 0 && (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Position</th>
                  {weeks.map((w) => (
                    <th style={styles.th} key={fmtDateOnly(w.start)}>
                      {w.start.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ratioPositions.map((position) => (
                  <tr key={position}>
                    <td style={styles.td}>{position}</td>
                    {weeks.map((w) => renderCoverageDayStrip(position, w))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Headcount by position</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          How many people of each position have at least one working day in that week.
        </div>
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Position</th>
                {weeks.map((w) => (
                  <th style={styles.th} key={fmtDateOnly(w.start)}>
                    {w.start.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {headcountByPosition.map((row) => (
                <tr key={row.position}>
                  <td style={styles.td}>{row.position}</td>
                  {row.counts.map((c, i) => (
                    <td style={styles.tdNum} key={i}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
              {headcountByPosition.length === 0 && (
                <tr>
                  <td style={styles.td} colSpan={WEEKS_SHOWN + 1}>
                    No employees yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <CollapsibleCard title="Allocate lodge">
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Who's working where — pick a lodge for any working week (below, under Weekly schedule) and
          it shows here grouped by position.
        </div>
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Employee</th>
                {weeks.map((w) => (
                  <th style={styles.th} key={fmtDateOnly(w.start)}>
                    {w.start.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groupedEmployees.map((group) => (
                <Fragment key={group.position}>
                  <tr>
                    <td
                      style={{ ...styles.td, fontWeight: 700, color: colors.goldLt, background: 'rgba(184,147,90,0.08)' }}
                      colSpan={WEEKS_SHOWN + 1}
                    >
                      {group.position} ({group.list.length})
                    </td>
                  </tr>
                  {group.list.map((e) => (
                    <tr key={e.id}>
                      <td style={styles.td}>
                        {e.first_name} {e.last_name}
                      </td>
                      {weeks.map((w) => renderDayStrip(e, w))}
                    </tr>
                  ))}
                </Fragment>
              ))}
              {groupedEmployees.length === 0 && (
                <tr>
                  <td style={styles.td} colSpan={WEEKS_SHOWN + 1}>
                    No employees yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CollapsibleCard>

      <CollapsibleCard
        title="Weekly schedule"
        headerExtra={
          <div style={{ ...styles.row, gap: 6 }}>
            <button style={styles.buttonGhost} onClick={() => setWeekStart((w) => addDays(w, -WEEKS_SHOWN * 7))}>
              ← Earlier
            </button>
            <button style={styles.buttonGhost} onClick={() => setWeekStart(startOfWeek(today, weekStartDay))}>
              Today
            </button>
            <button style={styles.buttonGhost} onClick={() => setWeekStart((w) => addDays(w, WEEKS_SHOWN * 7))}>
              Later →
            </button>
          </div>
        }
      >
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Each strip is one week, {WEEKDAY_NAMES[weekStartDay]} → {WEEKDAY_NAMES[(weekStartDay + 6) % 7]}, one
          square per day. Green = working, grey = off, gold = on leave. Pick a lodge for any working
          week and it applies to that whole week — it can be changed week to week within the same
          rotation.
        </div>
        <div style={{ ...styles.row, alignItems: 'flex-end' }}>
          <div>
            <label style={styles.label}>Filter by position</label>
            <select style={{ ...styles.input, maxWidth: 220 }} value={positionFilter} onChange={(e) => setPositionFilter(e.target.value)}>
              <option value="">All positions</option>
              {positions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Week starts on</label>
            <select
              style={{ ...styles.input, maxWidth: 160 }}
              value={weekStartDay}
              onChange={(e) => onWeekStartDayChange(Number(e.target.value))}
            >
              {WEEKDAY_NAMES.map((name, idx) => (
                <option key={idx} value={idx}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ fontSize: 11, color: colors.muted, marginTop: 6 }}>
          Align this to the day your rotation blocks actually start (e.g. Friday) so the weekly
          headcount below reflects real on/off blocks instead of always showing everyone as
          available.
        </div>
      </CollapsibleCard>

      <CollapsibleCard title="Staffing ratios">
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Define how many of each position you need for a given number of guests (e.g. 1 Ranger for
          1-9 guests, 2 for 10-20). The Staffing coverage card above flags any day that falls short,
          per lodge.
        </div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Position</label>
            <select
              style={styles.input}
              value={ratioForm.position}
              onChange={(e) => setRatioForm({ ...ratioForm, position: e.target.value })}
            >
              <option value="">Choose position…</option>
              {positions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Min guests</label>
            <input
              type="number" inputMode="decimal"
              min="0"
              style={styles.input}
              value={ratioForm.min_guests}
              onChange={(e) => setRatioForm({ ...ratioForm, min_guests: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Max guests (blank = and above)</label>
            <input
              type="number" inputMode="decimal"
              min="0"
              style={styles.input}
              value={ratioForm.max_guests}
              onChange={(e) => setRatioForm({ ...ratioForm, max_guests: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Staff required</label>
            <input
              type="number" inputMode="decimal"
              min="0"
              style={styles.input}
              value={ratioForm.required_count}
              onChange={(e) => setRatioForm({ ...ratioForm, required_count: e.target.value })}
            />
          </div>
        </div>
        <button
          style={styles.button}
          onClick={submitRatio}
          disabled={savingRatio || !ratioForm.position || ratioForm.min_guests === '' || ratioForm.required_count === ''}
        >
          {savingRatio ? 'Saving…' : 'Add tier'}
        </button>

        {ratioPositions.length > 0 && (
          <div style={{ ...styles.tableWrap, marginTop: 14 }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Position</th>
                  <th style={styles.th}>Guests</th>
                  <th style={styles.th}>Staff required</th>
                  <th style={styles.th}></th>
                </tr>
              </thead>
              <tbody>
                {ratioPositions.map((pos) => (
                  <Fragment key={pos}>
                    {staffingRatios
                      .filter((r) => r.position === pos)
                      .sort((a, b) => a.min_guests - b.min_guests)
                      .map((r) => (
                        <tr key={r.id}>
                          <td style={styles.td}>{r.position}</td>
                          <td style={styles.td}>
                            {r.min_guests}
                            {r.max_guests == null ? '+' : `–${r.max_guests}`}
                          </td>
                          <td style={styles.td}>{r.required_count}</td>
                          <td style={styles.td}>
                            <button style={styles.buttonGhost} onClick={() => onRemoveStaffingRatio(r.id)}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Working patterns">
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Each person works to a pattern. A <strong>rotation</strong> (21 on / 7 off and the like)
          also needs a cycle start date — any date that fell on day 1 of a working block; on/off is
          calculated forward and backward from there, so it does not have to be in the future. A{' '}
          <strong>fixed week</strong> pattern needs no date at all: the day of the week decides.
        </div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Anyone left on &ldquo;No pattern set&rdquo; is treated as 21 on / 7 off — what everybody
          was on before patterns existed — so nobody&rsquo;s schedule changes until you move them.
        </div>
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Employee</th>
                <th style={styles.th}>Pattern</th>
                <th style={styles.th}>Cycle start date</th>
                <th style={styles.th}>Today</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => {
                const info = dayInfo(e, today)
                const pattern = patternFor(e, patternsById)
                const missing = missingSetup(e, pattern)
                const label =
                  info.status === 'on'
                    ? 'Working'
                    : info.status === 'leave'
                      ? 'On leave'
                      : info.status === 'off'
                        ? 'Off'
                        : 'No schedule'
                const tone = info.status === 'on' ? 'good' : 'neutral'
                return (
                  <tr key={e.id}>
                    <td style={styles.td}>
                      {e.first_name} {e.last_name}
                    </td>
                    <td style={styles.td}>
                      <select
                        style={styles.smallInput}
                        value={e.shift_pattern_id || ''}
                        onChange={(ev) => savePattern(e.id, ev.target.value)}
                      >
                        <option value="">No pattern set — 21 on / 7 off</option>
                        {(shiftPatterns || []).map((pt) => (
                          <option key={pt.id} value={pt.id}>
                            {pt.name} ({describePattern(pt)})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={styles.td}>
                      {/* A fixed-week pattern needs no anchor, so the field is
                          not offered — an input that has no effect is worse
                          than no input, because someone will fill it in and
                          expect something to happen. */}
                      {pattern.kind === 'fixed_week' ? (
                        <span style={{ fontSize: 12, color: colors.muted }}>Not needed</span>
                      ) : (
                        <>
                          <input
                            type="date"
                            style={styles.smallInput}
                            defaultValue={e.cycle_anchor_date || ''}
                            onBlur={(ev) => saveAnchor(e.id, ev.target.value)}
                          />
                          {missing && (
                            <div style={{ fontSize: 11, color: colors.warn || colors.muted, marginTop: 4 }}>
                              {missing} — no on/off can be worked out
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td style={styles.td}>
                      <span style={styles.badge(tone)}>{label}</span>
                    </td>
                  </tr>
                )
              })}
              {employees.length === 0 && (
                <tr>
                  <td style={styles.td} colSpan={4}>
                    No employees yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CollapsibleCard>

      <CollapsibleCard title="Rostered extra days off">
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Days given off on top of whatever the person&rsquo;s pattern already says — the three a
          month your local staff get beyond their Sundays. Pick a person and a month, then click
          the days. Saved as you click.
        </div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          These only ever <strong>take days away</strong>. Clicking a day the pattern already has
          off changes nothing, and is marked as such rather than quietly accepted — a day given
          on an existing off day is a day the person loses without noticing.
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <select
            style={styles.smallInput}
            value={rosterEmployeeId}
            onChange={(e) => setRosterEmployeeId(e.target.value)}
          >
            <option value="">Choose an employee…</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.first_name} {e.last_name}
              </option>
            ))}
          </select>
          <input
            type="month"
            style={styles.smallInput}
            value={rosterMonth}
            onChange={(e) => setRosterMonth(e.target.value)}
          />
        </div>

        {!rosterEmployeeId && (
          <div style={{ fontSize: 12, color: colors.muted }}>Choose an employee to set their days.</div>
        )}

        {rosterEmployeeId && (() => {
          const emp = employees.find((e) => e.id === rosterEmployeeId)
          const pattern = patternFor(emp, patternsById)
          const [yy, mm] = rosterMonth.split('-').map(Number)
          if (!yy || !mm) return null
          const daysInMonth = new Date(yy, mm, 0).getDate()
          const rowsForEmp = (rosteredOffDays || []).filter((r) => r.employee_id === rosterEmployeeId)
          const byDate = {}
          for (const r of rowsForEmp) byDate[String(r.off_date).slice(0, 10)] = r
          const inMonth = rowsForEmp.filter((r) => String(r.off_date).slice(0, 7) === rosterMonth)

          return (
            <>
              <div style={{ fontSize: 12, marginBottom: 8 }}>
                <strong>{inMonth.length}</strong> extra day{inMonth.length === 1 ? '' : 's'} set for{' '}
                {rosterMonth}
                {inMonth.length !== 3 && (
                  <span style={{ color: colors.muted }}> — the usual allowance is three</span>
                )}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {Array.from({ length: daysInMonth }, (_, i) => {
                  const day = i + 1
                  const dateStr = `${rosterMonth}-${String(day).padStart(2, '0')}`
                  const dateObj = parseDateOnly(dateStr)
                  const existing = byDate[dateStr]
                  const alreadyOff = rosteredDayIsRedundant(pattern, emp?.cycle_anchor_date, dateObj)
                  const weekday = WEEKDAY_NAMES[dateObj.getDay()].slice(0, 2)
                  return (
                    <button
                      key={dateStr}
                      type="button"
                      disabled={rosterBusy}
                      onClick={() => toggleRosteredDay(rosterEmployeeId, dateStr, existing?.id)}
                      title={
                        alreadyOff
                          ? 'Already off under this pattern — giving this day changes nothing'
                          : existing
                            ? 'Rostered off — click to remove'
                            : 'Click to give this day off'
                      }
                      style={{
                        width: 46,
                        padding: '6px 0',
                        borderRadius: 6,
                        cursor: rosterBusy ? 'wait' : 'pointer',
                        fontSize: 11,
                        lineHeight: 1.3,
                        border: `1px solid ${existing ? colors.gold || colors.cream : colors.border}`,
                        // Three states, and the text says which — colour alone
                        // would leave "already off" and "rostered" looking
                        // similar on a projector.
                        background: existing
                          ? colors.gold || colors.border
                          : alreadyOff
                            ? colors.border
                            : 'transparent',
                        color: existing ? colors.panel : colors.cream,
                        opacity: alreadyOff && !existing ? 0.5 : 1,
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{day}</div>
                      <div style={{ fontSize: 9 }}>{alreadyOff && !existing ? 'off' : weekday}</div>
                    </button>
                  )
                })}
              </div>
            </>
          )
        })()}
      </CollapsibleCard>
    </>
  )
}

// ---------------------------------------------------------------------------
// Leave tab — Admin/HR Admin: set each employee's annual leave allowance,
// log leave periods (auto-marks those days unavailable on the Schedule tab
// via leaveOnDate), and see the running balance for whichever year you're
// looking at. Only days that fell on an already-scheduled working day are
// deducted — a leave day that lands on a regular off-cycle week costs
// nothing, since it wasn't going to be worked anyway.
// ---------------------------------------------------------------------------

function LeaveTab({ companyId, employees, shiftPatterns, rosteredOffDays, leave, entitlements, onUpdateEmployee, onLeaveAdd, onLeaveRemove }) {
  const [leaveForm, setLeaveForm] = useState({
    employee_id: '',
    leave_type: 'annual',
    start_date: '',
    end_date: '',
    note: '',
  })
  const [balanceEmployeeId, setBalanceEmployeeId] = useState('')
  const [logging, setLogging] = useState(false)
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear())
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  const employeeById = useMemo(() => {
    const map = {}
    for (const e of employees) map[e.id] = e
    return map
  }, [employees])

  const availableYears = useMemo(() => {
    const set = new Set([new Date().getFullYear()])
    for (const l of leave) set.add(Number(l.start_date.slice(0, 4)))
    return Array.from(set).sort((a, b) => b - a)
  }, [leave])

  // ANNUAL ONLY. This table is the annual-leave allowance, so counting sick
  // or family responsibility days here would show someone's holiday as used
  // up because they were off sick — and the number would look perfectly
  // plausible. Legacy rows have no leave_type and were all annual.
  const usedByEmployee = useMemo(() => {
    const map = {}
    for (const l of leave) {
      if (Number(l.start_date.slice(0, 4)) !== selectedYear) continue
      if ((l.leave_type || 'annual') !== 'annual') continue
      map[l.employee_id] = (map[l.employee_id] || 0) + Number(l.days_used || 0)
    }
    return map
  }, [leave, selectedYear])

  const yearEntries = useMemo(
    () =>
      leave
        .filter((l) => Number(l.start_date.slice(0, 4)) === selectedYear)
        .sort((a, b) => (a.start_date < b.start_date ? 1 : -1)),
    [leave, selectedYear]
  )

  // Same entries, grouped by employee so each person's periods sit together
  // instead of interleaved by date across the whole team.
  const entriesByEmployee = useMemo(() => {
    const groups = {}
    for (const l of yearEntries) {
      if (!groups[l.employee_id]) groups[l.employee_id] = []
      groups[l.employee_id].push(l)
    }
    return Object.entries(groups)
      .map(([employeeId, entries]) => {
        const e = employeeById[employeeId]
        return {
          employeeId,
          name: e ? `${e.first_name} ${e.last_name}` : 'Unknown employee',
          entries,
          totalDays: entries.reduce((s, l) => s + Number(l.days_used || 0), 0),
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [yearEntries, employeeById])

  // Patterns by id, so every status lookup below is a map hit rather than a
  // scan. Built here rather than passed in because each tab needs it and the
  // list is small.
  const patternsById = useMemo(() => {
    const m = {}
    for (const pt of shiftPatterns || []) m[pt.id] = pt
    return m
  }, [shiftPatterns])

  // Rostered extra days, grouped once per render. The schedule grid asks about
  // every employee on every visible day, so filtering the flat list per cell
  // would be a full scan of the table thousands of times per render.
  const rosterByEmployee = useMemo(() => rosteredOffByEmployee(rosteredOffDays || []), [rosteredOffDays])

  // BCEA balances for the employee selected in the Statutory balances card.
  // countWorkingDaysInRange is passed through rather than re-implemented in
  // leaveEngine, so the 21-on/7-off rotation logic exists in exactly one
  // place — two copies would drift and the copy driving balances is the one
  // nobody would notice was wrong.
  const balancesForSelected = useMemo(() => {
    const emp = employeeById[balanceEmployeeId]
    if (!emp) return []
    const scoped = (entitlements || []).map((ent) => entitlementForEmployee(ent, emp))
    return allBalances({
      employee: emp,
      entitlements: scoped,
      leaveRows: leave,
      asOf: todayIso(),
      // Adapted rather than passed raw: leaveEngine hands this the EMPLOYEE
      // now, not just an anchor date, because which pattern applies is a
      // property of the person.
      workingDaysBetween: (employee, start, end) =>
        countWorkingDaysInRange(employee, patternsById, start, end, rosterByEmployee),
    })
  }, [balanceEmployeeId, employeeById, entitlements, leave])

  async function saveAllocation(employeeId, value) {
    const [row] = await sb.update('hr_employees', { id: employeeId }, { annual_leave_days: Number(value) || 0 })
    onUpdateEmployee(row)
  }

  async function logLeave() {
    if (!leaveForm.employee_id || !leaveForm.start_date || !leaveForm.end_date) return
    if (leaveForm.end_date < leaveForm.start_date) return
    setLogging(true)
    const emp = employeeById[leaveForm.employee_id]
    const daysUsed = countWorkingDaysInRange(emp, patternsById, leaveForm.start_date, leaveForm.end_date, rosterByEmployee)
    const [row] = await sb.insert('hr_leave', {
      company_id: companyId,
      employee_id: leaveForm.employee_id,
      leave_type: leaveForm.leave_type || 'annual',
      start_date: leaveForm.start_date,
      end_date: leaveForm.end_date,
      days_used: daysUsed,
      note: leaveForm.note || null,
    })
    onLeaveAdd(row)
    setLeaveForm({
      employee_id: leaveForm.employee_id,
      leave_type: leaveForm.leave_type,
      start_date: '',
      end_date: '',
      note: '',
    })
    setLogging(false)
  }

  async function deleteLeave(id) {
    await sb.remove('hr_leave', { id })
    onLeaveRemove(id)
    setConfirmDeleteId(null)
  }

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Log leave</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Only the days in this range that fall on the employee's regular working days count against
          their balance — days that were already a scheduled off week are free. Those dates also show
          as "On leave" on the Schedule tab.
        </div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Employee</label>
            <select
              style={styles.input}
              value={leaveForm.employee_id}
              onChange={(e) => setLeaveForm({ ...leaveForm, employee_id: e.target.value })}
            >
              <option value="">Choose employee…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.first_name} {e.last_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Leave type</label>
            <select
              style={styles.input}
              value={leaveForm.leave_type}
              onChange={(e) => setLeaveForm({ ...leaveForm, leave_type: e.target.value })}
            >
              <option value="annual">Annual leave</option>
              <option value="sick">Sick leave</option>
              <option value="family_responsibility">Family responsibility leave</option>
              <option value="maternity">Maternity leave</option>
            </select>
          </div>
          <div>
            <label style={styles.label}>Start date</label>
            <input
              type="date"
              style={styles.input}
              value={leaveForm.start_date}
              onChange={(e) => setLeaveForm({ ...leaveForm, start_date: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>End date</label>
            <input
              type="date"
              style={styles.input}
              value={leaveForm.end_date}
              onChange={(e) => setLeaveForm({ ...leaveForm, end_date: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Note (optional)</label>
            <input style={styles.input} value={leaveForm.note} onChange={(e) => setLeaveForm({ ...leaveForm, note: e.target.value })} />
          </div>
        </div>
        <button
          style={styles.button}
          onClick={logLeave}
          disabled={logging || !leaveForm.employee_id || !leaveForm.start_date || !leaveForm.end_date}
        >
          {logging ? 'Saving…' : 'Log leave'}
        </button>
      </div>

      {/* Statutory balances, per employee, per BCEA cycle.
          Deliberately per-employee rather than a grid of everyone: each type
          runs on its own cycle anchored to that person's start date, so a
          single shared column header ("Used 2026") would be a lie for three
          of the four types. */}
      <div style={styles.card}>
        <div style={{ ...styles.row, justifyContent: 'space-between' }}>
          <div style={styles.cardTitle}>Statutory balances</div>
          <select
            style={{ ...styles.smallInput, width: 200 }}
            value={balanceEmployeeId}
            onChange={(e) => setBalanceEmployeeId(e.target.value)}
          >
            <option value="">Choose employee…</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.first_name} {e.last_name}
              </option>
            ))}
          </select>
        </div>
        {!balanceEmployeeId ? (
          <div style={{ fontSize: 12, color: colors.muted }}>
            Pick an employee to see their BCEA balances.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
              Cycles run from the employee's own start date. Sick leave is 30 days per{' '}
              <strong>36 months</strong>, not per year — the cycle window is shown against each row.
            </div>
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Leave type</th>
                    <th style={styles.th}>Cycle</th>
                    <th style={styles.th}>Entitled</th>
                    <th style={styles.th}>Used</th>
                    <th style={styles.th}>Remaining</th>
                    <th style={styles.th}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {balancesForSelected.map((b) => (
                    <tr key={b.leaveType}>
                      <td style={styles.td}>{LEAVE_TYPE_LABELS[b.leaveType] || b.leaveType}</td>
                      <td style={styles.td}>
                        {b.cycleStart ? `${b.cycleStart} → ${b.cycleEnd}` : '—'}
                      </td>
                      <td style={styles.tdNum}>{b.hasBalance ? fmt(b.entitled, 0) : '—'}</td>
                      <td style={styles.tdNum}>{fmt(b.used, 0)}</td>
                      <td style={styles.tdNum}>
                        {b.hasBalance ? (
                          <strong style={{ color: b.remaining < 0 ? colors.danger : colors.cream }}>
                            {fmt(b.remaining, 0)}
                          </strong>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td style={{ ...styles.td, fontSize: 11, color: colors.muted }}>
                        {[
                          b.note,
                          !b.hasBalance ? b.reason : null,
                          b.hasBalance && !b.eligible
                            ? `Not yet eligible — needs ${b.minServiceMonths} months' service (has ${b.serviceMonths})`
                            : null,
                          b.lapses ? 'Lapses at cycle end — does not carry over' : null,
                          !b.paid ? 'Unpaid by employer (UIF claim)' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div style={styles.card}>
        <div style={{ ...styles.row, justifyContent: 'space-between' }}>
          <div style={styles.cardTitle}>Balances — {selectedYear}</div>
          <select style={{ ...styles.smallInput, width: 90 }} value={selectedYear} onChange={(e) => setSelectedYear(Number(e.target.value))}>
            {availableYears.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Annual leave used in {selectedYear}, by calendar year. The statutory balances above are
          the authoritative ones — those run on each employee's own BCEA cycle, not the calendar
          year.
        </div>
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Employee</th>
                <th style={styles.th}>Annual allowance</th>
                <th style={styles.th}>Used ({selectedYear})</th>
                <th style={styles.th}>Remaining</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => {
                const used = usedByEmployee[e.id] || 0
                const remaining = Number(e.annual_leave_days || 0) - used
                return (
                  <tr key={e.id}>
                    <td style={styles.td}>
                      {e.first_name} {e.last_name}
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number" inputMode="decimal"
                        style={styles.smallInput}
                        defaultValue={e.annual_leave_days ?? 0}
                        onBlur={(ev) => saveAllocation(e.id, ev.target.value)}
                      />
                    </td>
                    <td style={styles.tdNum}>{fmt(used, 0)}</td>
                    <td style={styles.tdNum}>
                      <strong style={{ color: remaining < 0 ? colors.danger : colors.cream }}>{fmt(remaining, 0)}</strong>
                    </td>
                  </tr>
                )
              })}
              {employees.length === 0 && (
                <tr>
                  <td style={styles.td} colSpan={4}>
                    No employees yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Logged leave — {selectedYear}</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Grouped by employee, each person's periods listed together.
        </div>
        {entriesByEmployee.map((group) => (
          <div key={group.employeeId} style={{ marginBottom: 18 }}>
            <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: 6 }}>
              <strong style={{ color: colors.cream }}>{group.name}</strong>
              <span style={{ fontSize: 12, color: colors.muted }}>
                {fmt(group.totalDays, 0)} day{group.totalDays === 1 ? '' : 's'} · {group.entries.length} period
                {group.entries.length === 1 ? '' : 's'}
              </span>
            </div>
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Type</th>
                    <th style={styles.th}>From</th>
                    <th style={styles.th}>To</th>
                    <th style={styles.th}>Days used</th>
                    <th style={styles.th}>Note</th>
                    <th style={styles.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {group.entries.map((l) => (
                    <tr key={l.id}>
                      {/* Rows written before leave_type existed were all
                          annual leave, so a missing type reads as annual
                          rather than "unknown". */}
                      <td style={styles.td}>{LEAVE_TYPE_LABELS[l.leave_type || 'annual'] || l.leave_type}</td>
                      <td style={styles.td}>{l.start_date}</td>
                      <td style={styles.td}>{l.end_date}</td>
                      <td style={styles.tdNum}>{fmt(l.days_used, 0)}</td>
                      <td style={styles.td}>{l.note || '—'}</td>
                      <td style={styles.td}>
                        {confirmDeleteId === l.id ? (
                          <div style={{ ...styles.row, gap: 4 }}>
                            <button style={styles.buttonDanger} onClick={() => deleteLeave(l.id)}>
                              Confirm delete?
                            </button>
                            <button style={styles.buttonGhost} onClick={() => setConfirmDeleteId(null)}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button style={styles.buttonGhost} onClick={() => setConfirmDeleteId(l.id)}>
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        {entriesByEmployee.length === 0 && (
          <div style={{ fontSize: 13, color: colors.muted }}>No leave logged for {selectedYear} yet.</div>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Drawer — the detail pattern (readability pass, 2026-09-27). Thijs chose
// tabs inside a side drawer over a centred pop-up: title + meta, tabs, a
// scrolling body and a fixed footer. Same classes and behaviour as the Ops
// app's Drawer so a vehicle and an employee feel like one product. Esc and
// the scrim close it.
// ---------------------------------------------------------------------------
function Drawer({ title, meta, tabs, tab, onTab, onClose, footer, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // Fit the content (2026-09-28, Thijs: "if not all information fits, I
  // want the drawer to be bigger, so all info fits in one screen"). The
  // body is measured after every render; if anything would need a sideways
  // scroll — a wide table, mostly — the drawer grows by exactly that much,
  // up to the screen minus the sidebar. It only grows while open, so tabs
  // don't jump; paragraphs wrap, so they never widen it.
  const bodyRef = useRef(null)
  const [fitWidth, setFitWidth] = useState(null)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      if (window.innerWidth <= 768) return   // a tablet/phone drawer is already full width
      const overflow = el.scrollWidth - el.clientWidth
      if (overflow <= 1) return
      const cap = Math.max(640, window.innerWidth - 250)
      setFitWidth((w) => Math.min(cap, Math.ceil((w || el.parentElement.getBoundingClientRect().width) + overflow + 2)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const mo = new MutationObserver(measure)
    mo.observe(el, { childList: true, subtree: true, attributes: true })
    return () => { ro.disconnect(); mo.disconnect() }
  }, [tab])
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={title} style={fitWidth ? { width: fitWidth } : undefined}>
        <div className="drawer-head">
          <div className="drawer-title">
            <div><h2>{title}</h2>{meta && <div className="drawer-meta">{meta}</div>}</div>
            <button className="drawer-x" onClick={onClose} title="Close (Esc)">×</button>
          </div>
          {tabs && (
            <div className="drawer-tabs">
              {tabs.map((t) => (
                <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => onTab(t.id)}>
                  {t.label}{t.count != null && <span className="n">{t.count}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="drawer-body" ref={bodyRef}>{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>
  )
}

// ---------------------------------------------------------------------------
// Employees tab — Admin/HR Admin. Slimmed 2026-09-27 (readability pass): the
// table shows who, how they are today, where they are this week and what
// needs attention; everything else lives in the employee drawer (Profile ·
// Work pattern · Uniforms · Licences · Leave). The add form is a button.
// ---------------------------------------------------------------------------

const EMPLOYEE_TABS = [
  { id: 'profile', label: 'Profile' },
  { id: 'pattern', label: 'Work pattern' },
  { id: 'uniforms', label: 'Uniforms' },
  { id: 'licences', label: 'Licences' },
  { id: 'leave', label: 'Leave' },
]

function initials(e) {
  return `${(e.first_name || '')[0] || ''}${(e.last_name || '')[0] || ''}`.toUpperCase() || '?'
}

function EmployeesTab({
  companyId, role, employees, shiftPatterns, rosteredOffDays, scheduleLocations, leave, entitlements = [], contracts = [],
  onAdd, onUpdate, onRemove, onOffDayAdd, onOffDayRemove,
  qualifications = [], onQualificationAdd, onQualificationRemove,
  uniformItems = [], uniformStockByItem = {}, uniformIssues = [], onStockChange, onIssuesAdd, onIssuesUpdate, onIssuesRemove,
}) {
  const today = parseDateOnly(todayStr())
  // hr_schedule_locations.week_start_date is always Monday-anchored no matter
  // what display "week starts on" is set to (see ScheduleTab's mondayKeyOf).
  const thisWeekKey = fmtDateOnly(startOfWeek(today))
  const locationByKey = useMemo(() => {
    const map = {}
    for (const s of scheduleLocations) map[`${s.employee_id}|${s.week_start_date}`] = s
    return map
  }, [scheduleLocations])
  const patternsById = useMemo(() => {
    const m = {}
    for (const pt of shiftPatterns || []) m[pt.id] = pt
    return m
  }, [shiftPatterns])
  const rosterByEmployee = useMemo(() => rosteredOffByEmployee(rosteredOffDays || []), [rosteredOffDays])
  function todayInfo(employee) {
    if (leaveOnDate(leave, employee.id, today)) return { status: 'leave' }
    return cycleStatusForDate(employee, patternsById, today, rosterByEmployee)
  }

  const [search, setSearch] = useState('')
  const [deptFilter, setDeptFilter] = useState('')
  const [lodgeFilter, setLodgeFilter] = useState('')
  const [openId, setOpenId] = useState(null)      // employee id, or 'new'

  const departments = useMemo(() => Array.from(new Set(employees.map((e) => e.department?.trim()).filter(Boolean))).sort(), [employees])
  const positions = useMemo(() => Array.from(new Set(employees.map((e) => e.position?.trim()).filter(Boolean))).sort(), [employees])

  // What needs a look, per person — the only thing the table says beyond who
  // and where. Same rules the Dashboard cards use.
  function attention(e) {
    const flags = []
    const mine = qualifications.filter((q) => q.employee_id === e.id)
    const expired = mine.filter((q) => expiryStatus(q) === 'expired')
    const soon = mine.filter((q) => expiryStatus(q) === 'soon')
    for (const q of expired) flags.push({ tone: 'bad', text: `${describeQualification(q)} expired` })
    for (const q of soon) flags.push({ tone: 'neutral', text: `${describeQualification(q)} ${expiryLabel(q)}` })
    if (role === 'hradmin') {
      const c = currentContract(e.id, contracts)
      if (c?.end_date) {
        const d = daysUntil(c.end_date)
        if (d !== null && d < 0) flags.push({ tone: 'bad', text: `Contract ended ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} ago` })
        else if (d !== null && d <= 60) flags.push({ tone: 'neutral', text: `Contract ends in ${d} day${d === 1 ? '' : 's'}` })
      }
    }
    const missing = missingSetup(e, patternFor(e, patternsById))
    if (missing) flags.push({ tone: 'neutral', text: missing })
    return flags
  }

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return employees
      .filter((e) => !q || `${e.first_name} ${e.last_name} ${e.position || ''} ${e.department || ''}`.toLowerCase().includes(q))
      .filter((e) => !deptFilter || (e.department || '') === deptFilter)
      .filter((e) => !lodgeFilter || locationByKey[`${e.id}|${thisWeekKey}`]?.location_id === lodgeFilter)
      .sort((a, b) => (a.department?.trim() || 'zzz').localeCompare(b.department?.trim() || 'zzz') || `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`))
  }, [employees, search, deptFilter, lodgeFilter, locationByKey, thisWeekKey])

  // Grouped by department with a header row each (headcount, how many are
  // working today) — Thijs, 2026-09-27, same as the Contracts tab. Employees
  // with no department sit in their own group at the end.
  const groups = []
  for (const e of rows) {
    const key = e.department?.trim() || 'No department'
    let g = groups[groups.length - 1]
    if (!g || g.key !== key) { g = { key, rows: [], working: 0 }; groups.push(g) }
    g.rows.push(e)
    if (todayInfo(e).status === 'on') g.working++
  }

  const onLeaveToday = employees.filter((e) => leaveOnDate(leave, e.id, today)).length
  const expiringCount = qualifications.filter((q) => employees.some((e) => e.id === q.employee_id) && expiryStatus(q) !== 'ok' && expiryStatus(q) !== 'none').length

  const openEmployee = openId && openId !== 'new' ? employees.find((e) => e.id === openId) : null

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 13, color: colors.muted }}>
            {employees.length} active · {onLeaveToday} on leave today{expiringCount ? ` · ${expiringCount} licence${expiringCount === 1 ? '' : 's'} expiring or expired` : ''}
          </div>
        </div>
        <button style={{ ...styles.button, marginLeft: 'auto' }} onClick={() => setOpenId('new')}>+ Add employee</button>
      </div>
      <div className="toolbar">
        <input placeholder="Search by name, position or department…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
          <option value="">All departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={lodgeFilter} onChange={(e) => setLodgeFilter(e.target.value)}>
          <option value="">All lodges (this week)</option>
          {LOCATIONS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>

      <div style={styles.card}>
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Employee</th>
                <th style={styles.th}>Today</th>
                <th style={styles.th}>This week</th>
                <th style={styles.th}>Needs attention</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.key}>
                  <tr className="group-row">
                    <td style={styles.td} colSpan={5}>
                      <strong>{g.key}</strong> <span style={{ color: colors.muted, fontSize: 12 }}>({g.rows.length}{g.working ? ` · ${g.working} working today` : ''})</span>
                    </td>
                  </tr>
                  {g.rows.map((e) => {
                const info = todayInfo(e)
                const weekLoc = locationByKey[`${e.id}|${thisWeekKey}`]
                const label = info.status === 'on' ? 'Working' : info.status === 'leave' ? 'On leave' : info.status === 'off' ? 'Off' : '—'
                const flags = attention(e)
                return (
                  <tr key={e.id} className="emp-row" onClick={() => setOpenId(e.id)}>
                    <td style={{ ...styles.td, whiteSpace: 'normal' }}>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <span className="avatar">{initials(e)}</span>
                        <span>
                          <strong>{e.first_name} {e.last_name}</strong>
                          <span className="emp-sub">{[e.position, e.department].filter(Boolean).join(' · ') || 'No position set'}{e.start_date ? ` · since ${e.start_date.slice(0, 7)}` : ''}</span>
                        </span>
                      </div>
                    </td>
                    <td style={styles.td}><span style={styles.badge(info.status === 'on' ? 'good' : 'neutral')}>{label}</span></td>
                    <td style={styles.td}>{weekLoc ? (LOCATIONS.find((l) => l.id === weekLoc.location_id)?.name || weekLoc.location_id) : <span style={{ color: colors.muted }}>—</span>}</td>
                    <td style={{ ...styles.td, whiteSpace: 'normal' }}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {flags.slice(0, 3).map((f, i) => <span key={i} style={styles.badge(f.tone)}>{f.text}</span>)}
                        {flags.length > 3 && <span style={styles.badge('neutral')}>+{flags.length - 3}</span>}
                      </div>
                    </td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>
                      <button style={styles.buttonGhost} onClick={(ev) => { ev.stopPropagation(); setOpenId(e.id) }}>Open</button>
                    </td>
                  </tr>
                )
                  })}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr><td style={styles.td} colSpan={5}>{employees.length === 0 ? 'No employees yet — add one with the button above.' : 'Nobody matches that search.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11, color: colors.muted, marginTop: 8 }}>
          Showing {rows.length} of {employees.length}. Phone, email, pattern, uniforms, licences and leave live in the employee panel — click a row.
        </div>
      </div>

      {(openId === 'new' || openEmployee) && (
        <EmployeeDrawer
          key={openId}
          companyId={companyId}
          role={role}
          employee={openEmployee}
          positions={positions}
          departments={departments}
          shiftPatterns={shiftPatterns}
          patternsById={patternsById}
          rosteredOffDays={rosteredOffDays}
          rosterByEmployee={rosterByEmployee}
          leave={leave}
          entitlements={entitlements}
          contracts={contracts}
          qualifications={qualifications}
          uniformItems={uniformItems}
          uniformStockByItem={uniformStockByItem}
          uniformIssues={uniformIssues}
          onStockChange={onStockChange}
          onIssuesAdd={onIssuesAdd}
          onIssuesUpdate={onIssuesUpdate}
          onIssuesRemove={onIssuesRemove}
          onQualificationAdd={onQualificationAdd}
          onQualificationRemove={onQualificationRemove}
          onOffDayAdd={onOffDayAdd}
          onOffDayRemove={onOffDayRemove}
          onAdd={(row) => { onAdd(row); setOpenId(row.id) }}
          onUpdate={onUpdate}
          onRemove={(id) => { onRemove(id); setOpenId(null) }}
          onClose={() => setOpenId(null)}
          thisWeekLodge={openEmployee ? locationByKey[`${openEmployee.id}|${thisWeekKey}`]?.location_id : null}
          todayStatus={openEmployee ? todayInfo(openEmployee).status : null}
        />
      )}
    </>
  )
}

const BLANK_EMPLOYEE = { first_name: '', last_name: '', position: '', department: '', start_date: todayStr(), phone: '', email: '', status: 'Active', notes: '' }

function EmployeeDrawer({
  companyId, role, employee, positions, departments, shiftPatterns, patternsById, rosteredOffDays, rosterByEmployee, leave, entitlements, contracts,
  qualifications, uniformItems, uniformStockByItem, uniformIssues, onStockChange, onIssuesAdd, onIssuesUpdate, onIssuesRemove,
  onQualificationAdd, onQualificationRemove, onOffDayAdd, onOffDayRemove, onAdd, onUpdate, onRemove, onClose, thisWeekLodge, todayStatus,
}) {
  const isNew = !employee
  const [tab, setTab] = useState('profile')
  const [form, setForm] = useState(() => isNew ? BLANK_EMPLOYEE : {
    first_name: employee.first_name || '', last_name: employee.last_name || '', position: employee.position || '', department: employee.department || '',
    start_date: employee.start_date || '', phone: employee.phone || '', email: employee.email || '', status: employee.status || 'Active', notes: employee.notes || '',
  })
  const [newPosition, setNewPosition] = useState(false)
  const [newDepartment, setNewDepartment] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const dirty = !isNew && Object.keys(form).some((k) => (form[k] || '') !== (employee[k] || (k === 'status' ? 'Active' : '')))
  const f = (k) => (e) => setForm((x) => ({ ...x, [k]: e.target.value }))

  async function save() {
    setError(''); setMsg('')
    if (!form.first_name.trim() || !form.last_name.trim()) { setError('First and last name are needed.'); return }
    setSaving(true)
    try {
      const patch = { ...form, first_name: form.first_name.trim(), last_name: form.last_name.trim(), position: form.position.trim() || null, department: form.department.trim() || null, start_date: form.start_date || null, phone: form.phone.trim() || null, email: form.email.trim() || null, notes: form.notes.trim() || null }
      if (isNew) {
        const [row] = await sb.insert('hr_employees', { ...patch, company_id: companyId })
        onAdd(row)
        setMsg('Added. The other tabs are now available.')
      } else {
        const [row] = await sb.update('hr_employees', { id: employee.id }, patch)
        onUpdate(row)
        setMsg('Saved.')
      }
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }
  async function deactivate() {
    if (!window.confirm(`Deactivate ${employee.first_name} ${employee.last_name}? They stay in history but leave the active list.`)) return
    await sb.update('hr_employees', { id: employee.id }, { active: false })
    onRemove(employee.id)
  }

  // Work pattern
  async function savePattern(value) {
    const [row] = await sb.update('hr_employees', { id: employee.id }, { shift_pattern_id: value || null })
    onUpdate(row)
  }
  async function saveAnchor(value) {
    const [row] = await sb.update('hr_employees', { id: employee.id }, { cycle_anchor_date: value || null })
    onUpdate(row)
  }
  const [offDate, setOffDate] = useState(todayStr())
  const [offNote, setOffNote] = useState('')
  async function giveOffDay() {
    if (!offDate) return
    const [row] = await sb.insert('hr_employee_off_days', { company_id: companyId, employee_id: employee.id, off_date: offDate, note: offNote.trim() || null })
    onOffDayAdd(row); setOffNote('')
  }
  async function takeOffDay(id) {
    await sb.remove('hr_employee_off_days', { id }); onOffDayRemove(id)
  }
  const myOffDays = (rosteredOffDays || []).filter((d) => employee && d.employee_id === employee.id).sort((a, b) => String(b.off_date).localeCompare(String(a.off_date)))
  const next14 = useMemo(() => {
    if (!employee) return []
    const start = parseDateOnly(todayStr())
    return Array.from({ length: 14 }, (_, i) => {
      const d = addDays(start, i)
      const st = leaveOnDate(leave, employee.id, d) ? 'leave' : cycleStatusForDate(employee, patternsById, d, rosterByEmployee).status
      return { date: d, st }
    })
  }, [employee, leave, patternsById, rosterByEmployee])

  // Leave
  const balances = useMemo(() => {
    if (!employee) return []
    const scoped = (entitlements || []).map((ent) => entitlementForEmployee(ent, employee))
    return allBalances({
      employee, entitlements: scoped, leaveRows: leave, asOf: todayStr(),
      workingDaysBetween: (emp, start, end) => countWorkingDaysInRange(emp, patternsById, start, end, rosterByEmployee),
    })
  }, [employee, entitlements, leave, patternsById, rosterByEmployee])
  const myLeave = (leave || []).filter((l) => employee && l.employee_id === employee.id).sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)))

  const myQuals = qualifications.filter((q) => employee && q.employee_id === employee.id)
  const myIssues = uniformIssues.filter((i) => employee && i.employee_id === employee.id && i.status === 'issued')
  const contract = employee && role === 'hradmin' ? currentContract(employee.id, contracts) : null
  const tabs = isNew ? EMPLOYEE_TABS.filter((t) => t.id === 'profile') : EMPLOYEE_TABS.map((t) =>
    t.id === 'uniforms' ? { ...t, count: myIssues.length } : t.id === 'licences' ? { ...t, count: myQuals.length } : t)

  const meta = employee ? (
    <>
      <span>{[employee.position, employee.department].filter(Boolean).join(' · ') || 'No position set'}{thisWeekLodge ? ` · ${LOCATIONS.find((l) => l.id === thisWeekLodge)?.name || thisWeekLodge} this week` : ''}</span>
      {todayStatus && <span style={styles.badge(todayStatus === 'on' ? 'good' : 'neutral')}>{todayStatus === 'on' ? 'Working today' : todayStatus === 'leave' ? 'On leave' : 'Off today'}</span>}
    </>
  ) : 'Name, position and department first; pattern, uniforms and licences once they exist.'

  return (
    <Drawer
      title={isNew ? 'New employee' : `${employee.first_name} ${employee.last_name}`}
      meta={meta} tabs={tabs} tab={tab} onTab={setTab} onClose={onClose}
      footer={<>
        <button style={styles.button} onClick={save} disabled={saving}>{saving ? 'Saving…' : isNew ? 'Add employee' : 'Save changes'}</button>
        <button style={styles.buttonGhost} onClick={onClose}>{dirty ? 'Cancel' : 'Close'}</button>
        {!isNew && <button style={{ ...styles.buttonDanger, marginLeft: 6 }} onClick={deactivate}>Deactivate</button>}
        <span className="hint">{error ? <span style={{ color: colors.danger }}>{error}</span> : msg || (dirty ? 'Unsaved changes' : '')}</span>
      </>}
    >
      {tab === 'profile' && (
        <>
          <div className="drawer-grid">
            <div className="field"><label style={styles.label}>First name</label><input style={styles.input} value={form.first_name} onChange={f('first_name')} /></div>
            <div className="field"><label style={styles.label}>Last name</label><input style={styles.input} value={form.last_name} onChange={f('last_name')} /></div>
            <div className="field"><label style={styles.label}>Position</label>
              {newPosition ? (
                <input style={styles.input} autoFocus placeholder="New position" value={form.position} onChange={f('position')} onBlur={() => setNewPosition(false)} />
              ) : (
                <select style={styles.input} value={form.position} onChange={(e) => { if (e.target.value === '__new') { setForm((x) => ({ ...x, position: '' })); setNewPosition(true) } else setForm((x) => ({ ...x, position: e.target.value })) }}>
                  <option value="">—</option>
                  {Array.from(new Set([...positions, form.position].filter(Boolean))).sort().map((p) => <option key={p} value={p}>{p}</option>)}
                  <option value="__new">+ New position…</option>
                </select>
              )}
            </div>
            <div className="field"><label style={styles.label}>Department</label>
              {newDepartment ? (
                <input style={styles.input} autoFocus placeholder="New department" value={form.department} onChange={f('department')} onBlur={() => setNewDepartment(false)} />
              ) : (
                <select style={styles.input} value={form.department} onChange={(e) => { if (e.target.value === '__new') { setForm((x) => ({ ...x, department: '' })); setNewDepartment(true) } else setForm((x) => ({ ...x, department: e.target.value })) }}>
                  <option value="">—</option>
                  {Array.from(new Set([...departments, form.department].filter(Boolean))).sort().map((d) => <option key={d} value={d}>{d}</option>)}
                  <option value="__new">+ New department…</option>
                </select>
              )}
            </div>
            <div className="field"><label style={styles.label}>Start date</label><input type="date" style={styles.input} value={form.start_date} onChange={f('start_date')} /></div>
            <div className="field"><label style={styles.label}>Status</label>
              <select style={styles.input} value={form.status} onChange={f('status')}><option value="Active">Active</option><option value="Inactive">Inactive</option></select>
            </div>
            <div className="field"><label style={styles.label}>Phone</label><input style={styles.input} value={form.phone} onChange={f('phone')} /></div>
            <div className="field"><label style={styles.label}>Email</label><input type="email" style={styles.input} value={form.email} onChange={f('email')} /></div>
            <div className="field full"><label style={styles.label}>Notes</label><input style={styles.input} value={form.notes} onChange={f('notes')} /></div>
          </div>
          {!isNew && role === 'hradmin' && (
            <>
              <div className="drawer-sect">Contract</div>
              <div style={{ fontSize: 13 }}>
                {contract ? `${contract.contract_type || 'Contract'}, ${contract.start_date || '?'} → ${contract.end_date || 'open-ended'}` : 'No contract on file.'}
                <span style={{ color: colors.muted }}> · managed under Contracts</span>
              </div>
            </>
          )}
        </>
      )}

      {tab === 'pattern' && employee && (
        <>
          <div className="drawer-grid">
            <div className="field"><label style={styles.label}>Shift pattern</label>
              <select style={styles.input} value={employee.shift_pattern_id || ''} onChange={(e) => savePattern(e.target.value)}>
                <option value="">No pattern set — 21 on / 7 off</option>
                {(shiftPatterns || []).map((pt) => <option key={pt.id} value={pt.id}>{pt.name} — {describePattern(pt)}</option>)}
              </select>
            </div>
            <div className="field"><label style={styles.label}>Cycle start date</label>
              <input type="date" style={styles.input} defaultValue={employee.cycle_anchor_date || ''} onBlur={(e) => saveAnchor(e.target.value)} />
              <div style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>{describePattern(patternFor(employee, patternsById))}{missingSetup(employee, patternFor(employee, patternsById)) ? ` — ${missingSetup(employee, patternFor(employee, patternsById))}` : ''}</div>
            </div>
          </div>
          <div className="drawer-sect">Next 14 days</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {next14.map(({ date, st }) => (
              <span key={fmtDateOnly(date)} style={styles.badge(st === 'on' ? 'good' : 'neutral')}>
                {WEEKDAY_NAMES[date.getDay()]?.slice(0, 3)} {date.getDate()}{st === 'off' ? ' off' : st === 'leave' ? ' leave' : ''}
              </span>
            ))}
          </div>
          <div className="drawer-sect">Extra off days given</div>
          <table style={styles.table}><tbody>
            {myOffDays.map((d) => (
              <tr key={d.id}><td style={styles.td}>{d.off_date}</td><td style={styles.td}>{d.note || ''}</td><td style={{ ...styles.td, textAlign: 'right' }}><button style={styles.buttonGhost} onClick={() => takeOffDay(d.id)}>Remove</button></td></tr>
            ))}
            {myOffDays.length === 0 && <tr><td style={styles.td} colSpan={3}>None.</td></tr>}
          </tbody></table>
          <div style={{ display: 'flex', gap: 8, alignItems: 'end', marginTop: 10, flexWrap: 'wrap' }}>
            <div><label style={styles.label}>Date</label><input type="date" style={styles.input} value={offDate} onChange={(e) => setOffDate(e.target.value)} /></div>
            <div style={{ flex: 1, minWidth: 160 }}><label style={styles.label}>Note</label><input style={styles.input} value={offNote} onChange={(e) => setOffNote(e.target.value)} placeholder="e.g. Youth Day swap" /></div>
            <button style={styles.buttonGhost} onClick={giveOffDay}>+ Give an extra off day</button>
          </div>
        </>
      )}

      {tab === 'uniforms' && employee && (
        <EmployeeUniformModal
          embedded role={role} companyId={companyId} employee={employee} items={uniformItems} stockByItem={uniformStockByItem} issues={uniformIssues}
          onClose={() => {}} onStockChange={onStockChange} onIssuesAdd={onIssuesAdd} onIssuesUpdate={onIssuesUpdate} onIssuesRemove={onIssuesRemove}
        />
      )}

      {tab === 'licences' && employee && (
        <EmployeeQualificationsModal embedded companyId={companyId} employee={employee} rows={myQuals} onClose={() => {}} onAdd={onQualificationAdd} onRemove={onQualificationRemove} />
      )}

      {tab === 'leave' && employee && (
        <>
          <div style={{ ...styles.row, gap: 20, flexWrap: 'wrap', marginBottom: 10 }}>
            {balances.map((b) => (
              <div key={b.leaveType}>
                <div style={{ fontSize: 20, fontFamily: fonts.mono, color: colors.goldLt }}>{b.remaining != null ? b.remaining : '—'}</div>
                <div style={{ fontSize: 11, color: colors.muted }}>{LEAVE_TYPE_LABELS[b.leaveType] || b.leaveType} left{b.used != null ? ` · ${b.used} used` : ''}</div>
              </div>
            ))}
          </div>
          <table style={styles.table}>
            <thead><tr><th style={styles.th}>Dates</th><th style={styles.th}>Type</th><th style={{ ...styles.th, textAlign: 'right' }}>Days</th><th style={styles.th}>Note</th></tr></thead>
            <tbody>
              {myLeave.map((l) => (
                <tr key={l.id}><td style={styles.td}>{l.start_date}{l.end_date && l.end_date !== l.start_date ? ` → ${l.end_date}` : ''}</td><td style={styles.td}>{LEAVE_TYPE_LABELS[l.leave_type || 'annual'] || l.leave_type}</td><td style={{ ...styles.td, textAlign: 'right' }}>{l.days_used}</td><td style={{ ...styles.td, whiteSpace: 'normal' }}>{l.note || ''}</td></tr>
              ))}
              {myLeave.length === 0 && <tr><td style={styles.td} colSpan={4}>No leave recorded.</td></tr>}
            </tbody>
          </table>
          <div style={{ fontSize: 11, color: colors.muted, marginTop: 8 }}>Leave is recorded under the Leave tab, where the balances and rules live.</div>
        </>
      )}
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// Uniforms tab — shared catalog (Admin+ manage), per-lodge stock, and the
// Issue / Replace (broken) / Return workflow (Staff can do this part too).
// ---------------------------------------------------------------------------

function UniformsTab({
  role,
  companyId,
  items,
  stockByItem,
  issues,
  employees,
  suppliers,
  onItemAdd,
  onItemUpdate,
  onItemRemove,
  onStockChange,
  onIssuesAdd,
  onSelectEmployee,
}) {
  const isAdmin = role === 'admin' || role === 'hradmin'
  const [openItem, setOpenItem] = useState(null) // uniform item, or 'new'
  const [issueForm, setIssueForm] = useState({ item_id: '', employee_id: '' })
  const [issuing, setIssuing] = useState(false)

  // Staff sizes & stock recommendation (2026-08-19) — what current
  // (active) staff are actually wearing, broken down by size, compared
  // against what's on hand, so Thijs can see which sizes to keep more of.
  // Sizes are their own catalog rows already (per the "add each size as
  // its own item" convention above), so stockByItem[it.id] IS the
  // per-size stock level — no extra join needed beyond what's already
  // passed into this component. "short" is flagged two ways: on_hand at
  // or below the min_units threshold already used elsewhere in this app
  // (see lowStockRows), OR fewer on hand than are currently issued to
  // active staff — a size where, if a few break/wear out at once, there's
  // nothing to replace them with.
  const sizeBreakdown = useMemo(() => {
    const activeIds = new Set(employees.filter((e) => e.active).map((e) => e.id))
    const groups = {}
    for (const it of items) {
      const key = `${it.name}|${it.category}`
      if (!groups[key]) groups[key] = { name: it.name, category: it.category, sizes: [] }
      const demand = issues.filter((i) => i.item_id === it.id && i.status === 'issued' && activeIds.has(i.employee_id)).length
      const stock = stockByItem[it.id]
      const onHand = Number(stock?.qty_on_hand ?? 0)
      const minUnits = Number(stock?.min_units ?? 0)
      groups[key].sizes.push({
        id: it.id,
        size: it.size || '—',
        demand,
        onHand,
        minUnits,
        short: onHand < demand || onHand <= minUnits,
      })
    }
    return Object.values(groups)
      .map((g) => ({
        ...g,
        sizes: g.sizes.sort((a, b) => b.demand - a.demand),
        totalDemand: g.sizes.reduce((s, x) => s + x.demand, 0),
      }))
      .filter((g) => g.totalDemand > 0)
      .sort((a, b) => b.totalDemand - a.totalDemand)
  }, [items, issues, employees, stockByItem])

  async function issueNew() {
    if (!issueForm.item_id || !issueForm.employee_id) return
    setIssuing(true)
    const stock = stockByItem[issueForm.item_id]
    const [issueRow] = await sb.insert('hr_uniform_issues', {
      item_id: issueForm.item_id,
      employee_id: issueForm.employee_id,
      company_id: companyId,
      status: 'issued',
      issued_date: todayStr(),
    })
    const [stockRow] = await sb.upsert(
      'hr_uniform_stock',
      {
        item_id: issueForm.item_id,
        company_id: companyId,
        qty_on_hand: (stock?.qty_on_hand ?? 0) - 1,
        min_units: stock?.min_units ?? 0,
        max_units: stock?.max_units ?? 0,
      },
      'item_id'
    )
    onIssuesAdd(issueRow)
    onStockChange(stockRow)
    setIssuing(false)
  }

  return (
    <>
      <CollapsibleCard title="Issue an item" defaultOpen>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Employee</label>
            <select style={styles.input} value={issueForm.employee_id} onChange={(e) => setIssueForm({ ...issueForm, employee_id: e.target.value })}>
              <option value="">Choose employee…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.first_name} {e.last_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Item</label>
            <select style={styles.input} value={issueForm.item_id} onChange={(e) => setIssueForm({ ...issueForm, item_id: e.target.value })}>
              <option value="">Choose item…</option>
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name} {it.size ? `(${it.size})` : ''} — on hand: {fmt(stockByItem[it.id]?.qty_on_hand ?? 0, 0)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button style={styles.button} onClick={issueNew} disabled={issuing || !issueForm.item_id || !issueForm.employee_id}>
          {issuing ? 'Issuing…' : 'Issue item'}
        </button>
      </CollapsibleCard>

      <CollapsibleCard title="Employees" defaultOpen>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Click a name to see everything they've been issued, and to mark items broken/replaced or
          returned.
        </div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Employee</th>
              <th style={styles.th}>Currently has</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => {
              const count = issues.filter((i) => i.employee_id === e.id && i.status === 'issued').length
              return (
                <tr key={e.id}>
                  <td style={styles.td}>
                    {e.first_name} {e.last_name}
                  </td>
                  <td style={styles.tdNum}>{count}</td>
                  <td style={styles.td}>
                    <button style={styles.buttonGhost} onClick={() => onSelectEmployee(e.id)}>
                      View items
                    </button>
                  </td>
                </tr>
              )
            })}
            {employees.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={3}>
                  No employees yet — add them on the Employees tab.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </CollapsibleCard>

      {isAdmin && sizeBreakdown.length > 0 && (
        <CollapsibleCard title="Staff Sizes & Stock Recommendations">
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
            What active staff currently have issued, broken down by size, against what's on hand. "Stock up"
            means either you're at or below your own reorder minimum, or there are fewer on hand than are
            currently out being worn — worth keeping more of these sizes on the shelf.
          </div>
          {sizeBreakdown.map((g) => (
            <div key={`${g.name}|${g.category}`} style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                {g.name} <span style={{ color: colors.muted, fontWeight: 400, fontSize: 12 }}>({g.category})</span>
              </div>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Size</th>
                      <th style={styles.th}>Currently worn</th>
                      <th style={styles.th}>On hand</th>
                      <th style={styles.th}>Min</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.sizes.map((s) => (
                      <tr key={s.id}>
                        <td style={styles.td}>{s.size}</td>
                        <td style={styles.tdNum}>{s.demand}</td>
                        <td style={styles.tdNum}>{fmt(s.onHand, 0)}</td>
                        <td style={styles.tdNum}>{fmt(s.minUnits, 0)}</td>
                        <td style={styles.td}>
                          {s.short && s.demand > 0 ? (
                            <span style={styles.badge('bad')}>Stock up</span>
                          ) : s.demand > 0 ? (
                            <span style={styles.badge('good')}>OK</span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </CollapsibleCard>
      )}

      {isAdmin && (
        <StockItemsTable kind="uniform" items={items} stockByItem={stockByItem} suppliers={suppliers} isAdmin={isAdmin}
          onOpen={(it) => setOpenItem(it)} onAdd={() => setOpenItem('new')} />
      )}
      {isAdmin && openItem && (
        <StockItemDrawer
          key={openItem === 'new' ? 'new' : openItem.id}
          kind="uniform" table="hr_uniform_items" stockTable="hr_uniform_stock" stockConflict="item_id"
          item={openItem === 'new' ? null : items.find((x) => x.id === openItem.id) || openItem}
          stock={openItem === 'new' ? null : stockByItem[openItem.id]}
          companyId={companyId}
          categoryOptions={Array.from(new Set([...UNIFORM_CATEGORIES, ...items.map((x) => x.category).filter(Boolean)]))}
          suppliers={suppliers}
          onSaved={(row, isNew) => { if (isNew) { onItemAdd(row); setOpenItem(row) } else onItemUpdate(row) }}
          onStockSaved={onStockChange}
          onDeactivated={(id) => { onItemRemove(id); setOpenItem(null) }}
          onClose={() => setOpenItem(null)}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Linen tab — shared catalog (Admin+ manage), per-lodge stock, movement log
// (Staff can log received/lost/damaged too).
// ---------------------------------------------------------------------------

function LinenTab({ role, companyId, items, stock, movements, suppliers, onItemAdd, onItemUpdate, onItemRemove, onStockChange, onMovementAdd }) {
  const isAdmin = role === 'admin' || role === 'hradmin'
  const [location, setLocation] = useState(() => urlParam('loc') || 'ZC')
  // Read from the context here: the dependency below named companyLoading,
  // which only existed in App's scope, so opening Linen threw a
  // ReferenceError and blanked the page (caught 2026-09-29 by
  // tools/unbound_identifiers_test.mjs).
  const { loading: companyLoading } = useCompany()
  // 'ZC' is only a first guess: this state initialises before the lodge list
  // has loaded (CompanyContext fetches it), and another company won't have a
  // lodge called ZC at all. Once LOCATIONS is populated — and again whenever
  // it changes on a company switch — snap to the first real lodge if the
  // current pick isn't in the list (2026-08-26).
  useEffect(() => {
    if (LOCATIONS.length === 0) return
    if (!LOCATIONS.some((l) => l.id === location)) setLocation(LOCATIONS[0].id)
    // companyLoading is a dependency on purpose (2026-09-26). LOCATIONS is a
    // mutable module array, invisible to React: this effect first runs while
    // the lodge list is still empty (returns early), and on a company switch
    // it runs BEFORE the new list has arrived (old list, old pick still valid,
    // nothing to do). Neither run snaps. companyLoading flips false exactly
    // when the list is in place, so it is the signal to re-check. Without it
    // the Ops app crashed on the new tenant: locId stayed 'ZC', locData had
    // no such key, and the dashboard read loc.dieselIssues off undefined.
  }, [companyId, location, companyLoading])
  const [openItem, setOpenItem] = useState(null) // linen item, or 'new'
  const [moveForm, setMoveForm] = useState({ item_id: '', qty: '', reason: 'Received', note: '' })
  const [logging, setLogging] = useState(false)

  // Starter categories plus whatever's already in use on real items, so a
  // category someone typed in last week is a normal dropdown choice.
  const categoryOptions = useMemo(() => {
    const set = new Set(LINEN_CATEGORIES)
    for (const it of items) if (it.category) set.add(it.category)
    return Array.from(set).sort()
  }, [items])

  const stockByItem = useMemo(() => {
    const map = {}
    for (const s of stock) if (s.location_id === location) map[s.item_id] = s
    return map
  }, [stock, location])

  const locationMovements = useMemo(() => movements.filter((m) => m.location_id === location), [movements, location])

  async function logMovement() {
    if (!moveForm.item_id || !moveForm.qty) return
    setLogging(true)
    const qtyChange = moveForm.reason === 'Received' ? Number(moveForm.qty) : -Number(moveForm.qty)
    const [moveRow] = await sb.insert('hr_linen_movements', {
      item_id: moveForm.item_id,
      location_id: location,
      company_id: companyId,
      date: todayStr(),
      qty_change: qtyChange,
      reason: moveForm.reason,
      note: moveForm.note,
    })
    const s = stockByItem[moveForm.item_id]
    const [stockRow] = await sb.upsert(
      'hr_linen_stock',
      {
        item_id: moveForm.item_id,
        location_id: location,
        company_id: companyId,
        qty_on_hand: (s?.qty_on_hand ?? 0) + qtyChange,
        min_units: s?.min_units ?? 0,
        max_units: s?.max_units ?? 0,
      },
      'item_id,location_id'
    )
    onMovementAdd(moveRow)
    onStockChange(stockRow)
    setMoveForm({ item_id: moveForm.item_id, qty: '', reason: 'Received', note: '' })
    setLogging(false)
  }

  const itemName = (id) => {
    const it = items.find((i) => i.id === id)
    return it ? `${it.name}${it.size ? ` (${it.size})` : ''}` : 'Unknown item'
  }

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Lodge</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Linen stock is tracked separately per lodge — everything else in this app (employees,
          uniforms) is company-wide.
        </div>
        <div style={styles.pillGroup}>
          {LOCATIONS.map((l) => (
            <button key={l.id} style={styles.pill(location === l.id, l.id)} onClick={() => setLocation(l.id)}>
              {l.id}
            </button>
          ))}
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Log a movement — {location}</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          "Received" adds to stock; Lost, Damaged, and Other all subtract from stock.
        </div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Item</label>
            <select style={styles.input} value={moveForm.item_id} onChange={(e) => setMoveForm({ ...moveForm, item_id: e.target.value })}>
              <option value="">Choose item…</option>
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name} {it.size ? `(${it.size})` : ''} — on hand: {fmt(stockByItem[it.id]?.qty_on_hand ?? 0, 0)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Reason</label>
            <select style={styles.input} value={moveForm.reason} onChange={(e) => setMoveForm({ ...moveForm, reason: e.target.value })}>
              {MOVEMENT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Qty</label>
            <input type="number" inputMode="decimal" style={styles.input} value={moveForm.qty} onChange={(e) => setMoveForm({ ...moveForm, qty: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Note (optional)</label>
            <input style={styles.input} value={moveForm.note} onChange={(e) => setMoveForm({ ...moveForm, note: e.target.value })} />
          </div>
        </div>
        <button style={styles.button} onClick={logMovement} disabled={logging || !moveForm.item_id || !moveForm.qty}>
          {logging ? 'Saving…' : 'Log movement'}
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Recent movements — {location}</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Date</th>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>Reason</th>
              <th style={styles.th}>Qty change</th>
              <th style={styles.th}>Note</th>
            </tr>
          </thead>
          <tbody>
            {locationMovements.slice(0, 30).map((m) => (
              <tr key={m.id}>
                <td style={styles.td}>{m.date}</td>
                <td style={styles.td}>{itemName(m.item_id)}</td>
                <td style={styles.td}>{m.reason}</td>
                <td style={styles.tdNum}>
                  <span style={styles.badge(m.qty_change < 0 ? 'bad' : 'good')}>{fmt(m.qty_change, 0)}</span>
                </td>
                <td style={styles.td}>{m.note || '—'}</td>
              </tr>
            ))}
            {locationMovements.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={5}>
                  No movements logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {isAdmin && (
        <StockItemsTable kind="linen" items={items} stockByItem={stockByItem} suppliers={suppliers} location={location} isAdmin={isAdmin}
          onOpen={(it) => setOpenItem(it)} onAdd={() => setOpenItem('new')} />
      )}
      {isAdmin && openItem && (
        <StockItemDrawer
          key={`${openItem === 'new' ? 'new' : openItem.id}|${location}`}
          kind="linen" table="hr_linen_items" stockTable="hr_linen_stock" stockConflict="item_id,location_id"
          item={openItem === 'new' ? null : items.find((x) => x.id === openItem.id) || openItem}
          stock={openItem === 'new' ? null : stockByItem[openItem.id]}
          location={location}
          companyId={companyId}
          categoryOptions={categoryOptions}
          suppliers={suppliers}
          onSaved={(row, isNew) => { if (isNew) { onItemAdd(row); setOpenItem(row) } else onItemUpdate(row) }}
          onStockSaved={onStockChange}
          onDeactivated={(id) => { onItemRemove(id); setOpenItem(null) }}
          onClose={() => setOpenItem(null)}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Stock items (uniforms and linen) — readability pass (2026-09-27). One
// grouped-by-category table for the catalog + stock, one drawer per item
// with the catalog fields and the stock levels on ONE screen. Replaces the
// "Add … item" form card and the every-cell-an-input "Stock levels" table
// in both tabs. `kind` is 'uniform' (one company-wide stock row per item)
// or 'linen' (one stock row per item per lodge — `location` says which).
// ---------------------------------------------------------------------------
function StockItemsTable({ kind, items, stockByItem, suppliers, location, isAdmin, onOpen, onAdd }) {
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [flag, setFlag] = useState('')
  const supplierName = (id) => suppliers.find((s) => s.id === id)?.name || null
  const categories = useMemo(() => Array.from(new Set(items.map((it) => it.category).filter(Boolean))).sort(), [items])
  const q = search.trim().toLowerCase()
  const rows = items
    .map((it) => {
      const stock = stockByItem[it.id]
      const onHand = Number(stock?.qty_on_hand ?? 0)
      const min = Number(stock?.min_units ?? 0)
      return { it, stock, onHand, min, max: Number(stock?.max_units ?? 0), value: Number(it.price || 0) * onHand, low: min > 0 && onHand <= min }
    })
    .filter((r) => !q || `${r.it.name} ${r.it.size || ''} ${supplierName(r.it.supplier_id) || ''}`.toLowerCase().includes(q))
    .filter((r) => !catFilter || r.it.category === catFilter)
    .filter((r) => !flag || (flag === 'low' ? r.low : !r.it.supplier_id))
    .sort((a, b) => (a.it.category || '').localeCompare(b.it.category || '') || a.it.name.localeCompare(b.it.name) || String(a.it.size || '').localeCompare(String(b.it.size || ''), undefined, { numeric: true }))
  const groups = []
  for (const r of rows) {
    const key = r.it.category || 'Uncategorised'
    let g = groups[groups.length - 1]
    if (!g || g.key !== key) { g = { key, rows: [], value: 0, low: 0 }; groups.push(g) }
    g.rows.push(r); g.value += r.value; if (r.low) g.low++
  }
  const lowCount = rows.filter((r) => r.low).length
  const totalValue = rows.reduce((s, r) => s + r.value, 0)
  return (
    <div style={styles.card}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 10 }}>
        <div>
          <div style={styles.cardTitle}>Stock{kind === 'linen' && location ? ` — ${location}` : ''}</div>
          <div style={{ fontSize: 12, color: colors.muted }}>{items.length} item{items.length === 1 ? '' : 's'} · R {fmt(totalValue)} on the shelf{lowCount ? ` · ${lowCount} at or below minimum` : ''}</div>
        </div>
        {isAdmin && <button style={{ ...styles.button, marginLeft: 'auto' }} onClick={onAdd}>+ Add {kind} item</button>}
      </div>
      <div className="toolbar">
        <input placeholder="Search item, size or supplier…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={flag} onChange={(e) => setFlag(e.target.value)}>
          <option value="">Everything</option>
          <option value="low">At or below minimum</option>
          <option value="nosupplier">No supplier</option>
        </select>
      </div>
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>On hand</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Price</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Value</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.key}>
                <tr className="group-row">
                  <td style={styles.td} colSpan={3}><strong>{g.key}</strong> <span style={{ color: colors.muted, fontSize: 12 }}>({g.rows.length}{g.low ? ` · ${g.low} low` : ''})</span></td>
                  <td style={styles.tdNum}><strong>R {fmt(g.value)}</strong></td>
                  <td style={styles.td} />
                </tr>
                {g.rows.map(({ it, onHand, min, max, value, low }) => {
                  const pct = max > 0 ? Math.min(100, Math.max(0, (onHand / max) * 100)) : min > 0 ? Math.min(100, (onHand / (min * 2)) * 100) : 100
                  return (
                    <tr key={it.id} className="emp-row" onClick={() => onOpen(it)}>
                      <td style={{ ...styles.td, whiteSpace: 'normal' }}>
                        <strong>{it.name}{it.size ? ` — ${it.size}` : ''}</strong>
                        <span className="emp-sub">{supplierName(it.supplier_id) || 'no supplier'}</span>
                      </td>
                      <td style={styles.td}>
                        <span className={`lvl${low ? ' low' : ''}`}>
                          <span className="bar"><i style={{ width: `${pct}%` }} /></span>
                          <span>{fmt(onHand, 0)}{min > 0 ? ` / min ${fmt(min, 0)}` : ''}</span>
                          {low && <span style={styles.badge('bad')}>Low</span>}
                        </span>
                      </td>
                      <td style={styles.tdNum}>R {fmt(it.price || 0)}</td>
                      <td style={styles.tdNum}>R {fmt(value)}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}><button style={styles.buttonGhost} onClick={(ev) => { ev.stopPropagation(); onOpen(it) }}>Open</button></td>
                    </tr>
                  )
                })}
              </Fragment>
            ))}
            {rows.length === 0 && <tr><td style={styles.td} colSpan={5}>{items.length === 0 ? `No ${kind} items yet — add one with the button above.` : 'Nothing matches those filters.'}</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: colors.muted, marginTop: 8 }}>
        {kind === 'uniform' ? '"On hand" moves by itself when items are issued, replaced or returned; ' : ''}Price, supplier, min/max and a stock correction are in the item panel — click a row.
      </div>
    </div>
  )
}

function StockItemDrawer({ kind, table, stockTable, stockConflict, item, stock, location, companyId, categoryOptions, suppliers, onSaved, onStockSaved, onDeactivated, onClose }) {
  const isNew = !item
  const blank = { name: '', category: categoryOptions[0] || '', size: '', price: '', supplier_id: '' }
  const [form, setForm] = useState(() => isNew ? blank : { name: item.name || '', category: item.category || '', size: item.size || '', price: item.price ?? '', supplier_id: item.supplier_id || '' })
  const [levels, setLevels] = useState({ qty_on_hand: stock?.qty_on_hand ?? 0, min_units: stock?.min_units ?? 0, max_units: stock?.max_units ?? 0 })
  const [newCategory, setNewCategory] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const f = (k) => (e) => setForm((x) => ({ ...x, [k]: e.target.value }))
  const l = (k) => (e) => setLevels((x) => ({ ...x, [k]: e.target.value }))
  const itemDirty = isNew || ['name', 'category', 'size', 'supplier_id'].some((k) => String(form[k] ?? '') !== String(item[k] ?? '')) || Number(form.price || 0) !== Number(item.price || 0)
  const levelsDirty = ['qty_on_hand', 'min_units', 'max_units'].some((k) => Number(levels[k] || 0) !== Number(stock?.[k] ?? 0))
  const dirty = itemDirty || levelsDirty
  const cats = Array.from(new Set([...categoryOptions, form.category].filter(Boolean))).sort()

  async function save(e) {
    e.preventDefault()
    if (!form.name.trim()) { setMsg('Give the item a name.'); return }
    setSaving(true); setMsg('')
    try {
      const patch = { name: form.name.trim(), category: form.category.trim() || null, size: form.size.trim() || null, price: Number(form.price || 0), supplier_id: form.supplier_id || null }
      let row = item
      if (isNew) { ;[row] = await sb.insert(table, { ...patch, company_id: companyId }); onSaved(row, true) }
      else if (itemDirty) { ;[row] = await sb.update(table, { id: item.id }, patch); onSaved(row, false) }
      if (levelsDirty || isNew) {
        const payload = { item_id: row.id, company_id: companyId, qty_on_hand: Number(levels.qty_on_hand || 0), min_units: Number(levels.min_units || 0), max_units: Number(levels.max_units || 0) }
        if (kind === 'linen') payload.location_id = location
        const [stockRow] = await sb.upsert(stockTable, payload, stockConflict)
        onStockSaved(stockRow)
      }
      setMsg(isNew ? 'Added.' : 'Saved.')
    } catch (err) { setMsg(err.message) } finally { setSaving(false) }
  }
  async function deactivate() {
    if (!window.confirm(`Remove ${item.name}${item.size ? ` (${item.size})` : ''} from the ${kind} list? Its history stays.`)) return
    await sb.update(table, { id: item.id }, { active: false })
    onDeactivated(item.id)
  }

  const onHand = Number(levels.qty_on_hand || 0)
  return (
    <Drawer title={isNew ? `New ${kind} item` : `${item.name}${item.size ? ` — ${item.size}` : ''}`}
      meta={isNew ? 'Add each size as its own item (e.g. Polo Shirt M and Polo Shirt L as two rows).' : `${item.category || 'Uncategorised'}${kind === 'linen' ? ` · stock at ${location}` : ' · company-wide stock'}`}
      onClose={onClose}
      footer={<>
        <button type="submit" form="stock-item-form" style={styles.button} disabled={saving || !dirty}>{saving ? 'Saving…' : isNew ? 'Add item' : 'Save changes'}</button>
        <button type="button" style={styles.buttonGhost} onClick={onClose}>{dirty && !isNew ? 'Cancel' : 'Close'}</button>
        {!isNew && <button type="button" style={styles.buttonDanger} onClick={deactivate}>Deactivate</button>}
        <span className="hint">{msg || (dirty && !isNew ? 'Unsaved changes' : 'Esc closes')}</span>
      </>}>
      <form id="stock-item-form" onSubmit={save}>
        <div className="drawer-grid">
          <div className="field full"><label style={styles.label}>Name</label><input style={styles.input} value={form.name} onChange={f('name')} autoFocus={isNew} /></div>
          <div className="field"><label style={styles.label}>Category</label>
            {newCategory ? (
              <input style={styles.input} autoFocus placeholder="New category" value={form.category} onChange={f('category')} onBlur={() => setNewCategory(false)} />
            ) : (
              <select style={styles.input} value={form.category} onChange={(e) => { if (e.target.value === '__new') { setForm((x) => ({ ...x, category: '' })); setNewCategory(true) } else setForm((x) => ({ ...x, category: e.target.value })) }}>
                {cats.map((c) => <option key={c} value={c}>{c}</option>)}
                <option value="__new">+ New category…</option>
              </select>
            )}
          </div>
          <div className="field"><label style={styles.label}>Size{kind === 'linen' ? ' (optional)' : ''}</label><input style={styles.input} value={form.size} onChange={f('size')} placeholder={kind === 'linen' ? 'e.g. Queen' : 'e.g. M'} /></div>
          <div className="field"><label style={styles.label}>Price (R)</label><input type="number" inputMode="decimal" step="0.01" min="0" style={styles.input} value={form.price} onChange={f('price')} /></div>
          <div className="field"><label style={styles.label}>Supplier</label>
            <select style={styles.input} value={form.supplier_id} onChange={f('supplier_id')}>
              <option value="">No supplier</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>
        <div className="drawer-sect">Stock levels{kind === 'linen' ? ` — ${location}` : ''}</div>
        <div className="drawer-grid">
          <div className="field"><label style={styles.label}>On hand</label><input type="number" inputMode="decimal" style={styles.input} value={levels.qty_on_hand} onChange={l('qty_on_hand')} />
            <div className="help">{kind === 'uniform' ? 'Moves by itself on issue / replace / return. Type here only when stock arrives or to correct a count.' : 'Moves by itself with each logged movement. Type here only to correct a count.'}</div></div>
          <div className="field"><label style={styles.label}>Value</label><input style={styles.input} disabled value={`R ${fmt(Number(form.price || 0) * onHand)}`} /></div>
          <div className="field"><label style={styles.label}>Minimum</label><input type="number" inputMode="decimal" style={styles.input} value={levels.min_units} onChange={l('min_units')} /><div className="help">At or below this it shows on Orders.</div></div>
          <div className="field"><label style={styles.label}>Maximum</label><input type="number" inputMode="decimal" style={styles.input} value={levels.max_units} onChange={l('max_units')} /><div className="help">Orders top up to this.</div></div>
        </div>
      </form>
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// Suppliers tab — one shared list (not per-lodge), used by both Uniforms
// and Linen.
// ---------------------------------------------------------------------------

// Suppliers — readability pass (2026-09-27): the table says who they are and
// what they supply (uniform and linen items linked by supplier_id) and what
// is low; contact details are edited in the supplier drawer, which also
// lists the items with the same "Copy order list" the Orders tab builds.
function SuppliersTab({ companyId, suppliers, onAdd, onUpdate, onRemove, uniformItems = [], uniformStockByItem = {}, linenItems = [], linenStock = [] }) {
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('')
  const [openId, setOpenId] = useState(null) // supplier id, or 'new'

  const bySupplier = useMemo(() => {
    const map = {}
    const add = (sid, row) => { if (!sid) return; (map[sid] = map[sid] || { uniforms: [], linen: [], low: 0 }); row.kind === 'Uniform' ? map[sid].uniforms.push(row) : map[sid].linen.push(row); if (row.low) map[sid].low++ }
    for (const it of uniformItems) { const stock = uniformStockByItem[it.id]; add(it.supplier_id, { kind: 'Uniform', item: it, stock, label: `${it.name}${it.size ? ` — ${it.size}` : ''}`, low: !!stock && Number(stock.qty_on_hand) <= Number(stock.min_units) }) }
    const linenById = Object.fromEntries(linenItems.map((it) => [it.id, it]))
    for (const s of linenStock) { const it = linenById[s.item_id]; if (!it) continue; add(it.supplier_id, { kind: 'Linen', item: it, stock: s, label: `${it.name} — ${s.location_id}`, low: Number(s.qty_on_hand) <= Number(s.min_units) }) }
    return map
  }, [uniformItems, uniformStockByItem, linenItems, linenStock])

  const q = search.trim().toLowerCase()
  const rows = suppliers
    .filter((s) => !q || `${s.name} ${s.contact_name || ''} ${s.email || ''}`.toLowerCase().includes(q))
    .filter((s) => !kind || (kind === 'uniform' ? (bySupplier[s.id]?.uniforms.length || 0) > 0 : (bySupplier[s.id]?.linen.length || 0) > 0))
    .sort((a, b) => a.name.localeCompare(b.name))
  const lowCount = suppliers.filter((s) => (bySupplier[s.id]?.low || 0) > 0).length
  const openSupplier = openId && openId !== 'new' ? suppliers.find((s) => s.id === openId) : null

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: colors.muted }}>{suppliers.length} supplier{suppliers.length === 1 ? '' : 's'}{lowCount ? ` · ${lowCount} with items below minimum` : ''}</div>
        <button style={{ ...styles.button, marginLeft: 'auto' }} onClick={() => setOpenId('new')}>+ Add supplier</button>
      </div>
      <div className="toolbar">
        <input placeholder="Search supplier or contact…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All</option>
          <option value="uniform">Uniforms</option>
          <option value="linen">Linen</option>
        </select>
      </div>
      <div style={styles.card}>
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Supplier</th>
                <th style={styles.th}>Contact</th>
                <th style={styles.th}>Supplies</th>
                <th style={styles.th}>To order</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const g = bySupplier[s.id]
                const supplies = [g?.uniforms.length ? `${g.uniforms.length} uniform item${g.uniforms.length === 1 ? '' : 's'}` : null, g?.linen.length ? `${g.linen.length} linen line${g.linen.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')
                return (
                  <tr key={s.id} className="emp-row" onClick={() => setOpenId(s.id)}>
                    <td style={{ ...styles.td, whiteSpace: 'normal' }}><strong>{s.name}</strong>{s.notes ? <span className="emp-sub">{s.notes}</span> : null}</td>
                    <td style={{ ...styles.td, whiteSpace: 'normal' }}>{[s.contact_name, s.phone].filter(Boolean).join(' · ') || '—'}{s.email ? <span className="emp-sub">{s.email}</span> : null}</td>
                    <td style={styles.td}>{supplies || <span style={{ color: colors.muted }}>no items linked</span>}</td>
                    <td style={styles.td}>{g?.low ? <span style={styles.badge('bad')}>{g.low} item{g.low === 1 ? '' : 's'} low</span> : null}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}><button style={styles.buttonGhost} onClick={(ev) => { ev.stopPropagation(); setOpenId(s.id) }}>Open</button></td>
                  </tr>
                )
              })}
              {rows.length === 0 && <tr><td style={styles.td} colSpan={5}>{suppliers.length === 0 ? 'No suppliers yet — add one with the button above, then link uniform and linen items to it.' : 'Nobody matches that search.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {(openId === 'new' || openSupplier) && (
        <SupplierDrawer
          key={openId}
          companyId={companyId}
          supplier={openSupplier}
          group={openSupplier ? bySupplier[openSupplier.id] : null}
          onAdd={(row) => { onAdd(row); setOpenId(row.id) }}
          onUpdate={onUpdate}
          onRemove={(id) => { onRemove(id); setOpenId(null) }}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  )
}

const BLANK_SUPPLIER = { name: '', contact_name: '', phone: '', email: '', notes: '' }

function SupplierDrawer({ companyId, supplier, group, onAdd, onUpdate, onRemove, onClose }) {
  const isNew = !supplier
  const [tab, setTab] = useState('details')
  const [form, setForm] = useState(() => isNew ? BLANK_SUPPLIER : { name: supplier.name || '', contact_name: supplier.contact_name || '', phone: supplier.phone || '', email: supplier.email || '', notes: supplier.notes || '' })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [copied, setCopied] = useState(false)
  const f = (k) => (e) => setForm((x) => ({ ...x, [k]: e.target.value }))
  const dirty = isNew || Object.keys(BLANK_SUPPLIER).some((k) => (form[k] || '') !== (supplier[k] || ''))
  const items = group ? [...group.uniforms, ...group.linen] : []
  const toOrder = items.filter((r) => r.low)

  async function save(e) {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true); setMsg('')
    try {
      const patch = { name: form.name.trim(), contact_name: form.contact_name.trim() || null, phone: form.phone.trim() || null, email: form.email.trim() || null, notes: form.notes.trim() || null }
      if (isNew) { const [row] = await sb.insert('hr_suppliers', { ...patch, company_id: companyId }); onAdd(row); setMsg('Added.') }
      else { const [row] = await sb.update('hr_suppliers', { id: supplier.id }, patch); onUpdate(row); setMsg('Saved.') }
    } catch (err) { setMsg(err.message) } finally { setSaving(false) }
  }
  async function deactivate() {
    if (!window.confirm(`Remove ${supplier.name} from the supplier list? Items linked to it keep their history.`)) return
    await sb.update('hr_suppliers', { id: supplier.id }, { active: false })
    onRemove(supplier.id)
  }
  function copyList() {
    const text = toOrder.map((r) => `${r.label}\t${fmt(orderQty(r.stock), 0)}\tR ${fmt(orderQty(r.stock) * Number(r.item.price || 0))}`).join('\n')
    const flash = () => { setCopied(true); setTimeout(() => setCopied(false), 1500) }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(flash).catch(flash)
    else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); flash() }
  }

  const tabs = isNew ? [{ id: 'details', label: 'Details' }] : [{ id: 'details', label: 'Details' }, { id: 'items', label: 'Items supplied', count: items.length }]
  return (
    <Drawer title={isNew ? 'New supplier' : supplier.name}
      meta={isNew ? 'Name first; link uniform and linen items to it afterwards.' : `${items.length} item${items.length === 1 ? '' : 's'} linked${toOrder.length ? ` · ${toOrder.length} below minimum` : ''}`}
      tabs={tabs} tab={tab} onTab={setTab} onClose={onClose}
      footer={<>
        <button type="submit" form="supplier-form" style={styles.button} disabled={saving || !dirty || tab !== 'details'}>{saving ? 'Saving…' : isNew ? 'Add supplier' : 'Save changes'}</button>
        <button type="button" style={styles.buttonGhost} onClick={onClose}>{dirty && !isNew ? 'Cancel' : 'Close'}</button>
        {!isNew && <button type="button" style={styles.buttonDanger} onClick={deactivate}>Deactivate</button>}
        <span className="hint">{msg || (dirty && !isNew ? 'Unsaved changes' : 'Esc closes')}</span>
      </>}>
      {tab === 'details' && (
        <form id="supplier-form" onSubmit={save} className="drawer-grid">
          <div className="field full"><label style={styles.label}>Name</label><input style={styles.input} value={form.name} onChange={f('name')} autoFocus={isNew} /></div>
          <div className="field"><label style={styles.label}>Contact name</label><input style={styles.input} value={form.contact_name} onChange={f('contact_name')} /></div>
          <div className="field"><label style={styles.label}>Phone</label><input style={styles.input} value={form.phone} onChange={f('phone')} /></div>
          <div className="field full"><label style={styles.label}>Email</label><input type="email" style={styles.input} value={form.email} onChange={f('email')} /></div>
          <div className="field full"><label style={styles.label}>Notes</label><input style={styles.input} value={form.notes} onChange={f('notes')} placeholder="e.g. Net 30, embroidery 10 working days" /></div>
        </form>
      )}
      {tab === 'items' && !isNew && (
        <>
          <table style={styles.table}>
            <thead><tr><th style={styles.th}>Item</th><th style={{ ...styles.th, textAlign: 'right' }}>On hand</th><th style={{ ...styles.th, textAlign: 'right' }}>Min</th><th style={{ ...styles.th, textAlign: 'right' }}>To order</th></tr></thead>
            <tbody>
              {items.map((r, i) => (
                <tr key={i}>
                  <td style={{ ...styles.td, whiteSpace: 'normal' }}><strong>{r.item.name}</strong><span className="emp-sub">{r.kind}{r.item.category ? ` · ${r.item.category}` : ''}{r.kind === 'Uniform' && r.item.size ? ` · ${r.item.size}` : ''}{r.kind === 'Linen' ? ` · ${r.stock.location_id}` : ''}</span></td>
                  <td style={styles.tdNum}>{r.stock ? fmt(r.stock.qty_on_hand, 0) : '—'}</td>
                  <td style={styles.tdNum}>{r.stock ? fmt(r.stock.min_units, 0) : '—'}</td>
                  <td style={styles.tdNum}>{r.low ? <span style={styles.badge('bad')}>{fmt(orderQty(r.stock), 0)}</span> : ''}</td>
                </tr>
              ))}
              {items.length === 0 && <tr><td style={styles.td} colSpan={4}>No items linked — pick this supplier on a uniform or linen item.</td></tr>}
            </tbody>
          </table>
          {toOrder.length > 0 && (
            <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" style={styles.buttonGhost} onClick={copyList}>{copied ? 'Copied' : 'Copy order list'}</button>
              <span style={{ fontSize: 12, color: colors.muted }}>The same list the Orders tab builds for this supplier.</span>
            </div>
          )}
        </>
      )}
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// Orders tab — low-stock uniforms and linen combined, grouped by supplier,
// with a Copy list button per supplier (same UX as Beverage/Food).
// ---------------------------------------------------------------------------

const UNASSIGNED_SUPPLIER = '__unassigned__'

function orderQty(stock) {
  return Math.max(Number(stock.max_units) - Number(stock.qty_on_hand), 0)
}

function OrdersTab({ uniformItems, uniformStockByItem, linenItems, linenStock, supplierById }) {
  const [copiedKey, setCopiedKey] = useState(null)

  const toOrder = useMemo(() => {
    const uniforms = lowStockRows(uniformItems, uniformStockByItem).map((x) => ({ ...x, type: 'Uniform', label: x.item.name }))
    // Linen has one stock row per (item, lodge), so a single item can show
    // up more than once here — once per lodge that's running low.
    const linen = lowStockRowsLinen(linenItems, linenStock).map((x) => ({ ...x, type: 'Linen', label: `${x.item.name} — ${x.stock.location_id}` }))
    return [...uniforms, ...linen]
  }, [uniformItems, uniformStockByItem, linenItems, linenStock])

  const groups = useMemo(() => {
    const map = {}
    for (const row of toOrder) {
      const key = row.item.supplier_id || UNASSIGNED_SUPPLIER
      ;(map[key] ||= []).push(row)
    }
    const rows = Object.entries(map).map(([key, groupRows]) => {
      const value = groupRows.reduce((sum, r) => sum + orderQty(r.stock) * Number(r.item.price || 0), 0)
      return {
        key,
        supplier: key === UNASSIGNED_SUPPLIER ? null : supplierById[key],
        rows: groupRows,
        value,
      }
    })
    rows.sort((a, b) => {
      if (a.key === UNASSIGNED_SUPPLIER) return 1
      if (b.key === UNASSIGNED_SUPPLIER) return -1
      return (a.supplier?.name || '').localeCompare(b.supplier?.name || '')
    })
    return rows
  }, [toOrder, supplierById])

  const grandTotal = useMemo(() => groups.reduce((sum, g) => sum + g.value, 0), [groups])

  async function copyGroup(group) {
    const text = group.rows
      .map((r) => `${r.label}\t${fmt(orderQty(r.stock), 0)}\tR ${fmt(orderQty(r.stock) * Number(r.item.price || 0))}`)
      .join('\n')

    const flash = () => {
      setCopiedKey(group.key)
      setTimeout(() => setCopiedKey((k) => (k === group.key ? null : k)), 2000)
    }

    try {
      await navigator.clipboard.writeText(text)
      flash()
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      try {
        document.execCommand('copy')
        flash()
      } catch {
        // Nothing more we can do — leave it uncopied silently.
      }
      document.body.removeChild(textarea)
    }
  }

  if (toOrder.length === 0) {
    return (
      <div style={styles.card}>
        <div style={styles.cardTitle}>To be ordered</div>
        <div style={{ fontSize: 13 }}>Nothing needs ordering right now.</div>
      </div>
    )
  }

  return (
    <>
      <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: 4, padding: '0 2px' }}>
        <div style={{ fontSize: 12, color: colors.muted }}>
          {toOrder.length} item{toOrder.length === 1 ? '' : 's'} to order across uniforms and linen,
          grouped by supplier.
        </div>
        <div style={{ fontSize: 13, fontFamily: fonts.mono, color: colors.goldLt }}>Order total: R {fmt(grandTotal)}</div>
      </div>
      {groups.map((group) => (
        <div style={styles.card} key={group.key}>
          <div style={{ ...styles.row, justifyContent: 'space-between' }}>
            <div style={styles.cardTitle}>
              {group.supplier ? group.supplier.name : 'Unassigned'} ({group.rows.length}) — R {fmt(group.value)}
            </div>
            <button style={styles.buttonGhost} onClick={() => copyGroup(group)}>
              {copiedKey === group.key ? 'Copied!' : 'Copy list'}
            </button>
          </div>
          {group.supplier && (group.supplier.contact_name || group.supplier.phone || group.supplier.email) && (
            <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
              {[group.supplier.contact_name, group.supplier.phone, group.supplier.email].filter(Boolean).join(' · ')}
            </div>
          )}
          {!group.supplier && (
            <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
              These items have no supplier linked — set one on the Uniforms or Linen tab.
            </div>
          )}
          <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Item</th>
                <th style={styles.th}>Type</th>
                <th style={styles.th}>On hand</th>
                <th style={styles.th}>Min</th>
                <th style={styles.th}>Max</th>
                <th style={styles.th}>Order qty</th>
                <th style={styles.th}>Price</th>
                <th style={styles.th}>Order value</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map(({ item, stock, type, label }) => (
                <tr key={stock.id}>
                  <td style={styles.td}>{label}</td>
                  <td style={styles.td}>{type}</td>
                  <td style={styles.tdNum}>{fmt(stock.qty_on_hand, 0)}</td>
                  <td style={styles.tdNum}>{fmt(stock.min_units, 0)}</td>
                  <td style={styles.tdNum}>{fmt(stock.max_units, 0)}</td>
                  <td style={styles.td}>
                    <strong>{fmt(orderQty(stock), 0)}</strong>
                  </td>
                  <td style={styles.tdNum}>R {fmt(item.price || 0)}</td>
                  <td style={styles.tdNum}>R {fmt(orderQty(stock) * Number(item.price || 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Contracts tab — HR Admin only. Full history per employee; "current"
// contract is derived (latest start_date), not a stored flag.
// ---------------------------------------------------------------------------

const BLANK_CONTRACT_FORM = {
  contract_type: 'Permanent',
  start_date: todayStr(),
  end_date: '',
  salary: '',
  medical_aid: false,
  medical_aid_scheme: '',
  medical_aid_monthly_cost: '',
  pension_fund: false,
  pension_fund_name: '',
  pension_fund_monthly_cost: '',
  housing_monthly_cost: '',
  notes: '',
}

// Contracts — HR Admin only. Readability pass (2026-09-27): a six-column
// table (employee, current contract, salary, fixed real cost, status, open)
// and one drawer per employee with Current contract (edited IN PLACE — same
// row, see the 2026-08-18 note on editing below) · Cost · History. A new
// contract row is added from the footer's "+ New contract", which keeps the
// history instead of overwriting it.
function contractToForm(contract) {
  const n = (v) => (v === null || v === undefined ? '' : String(v))
  return {
    contract_type: contract.contract_type || 'Permanent',
    start_date: contract.start_date || todayStr(),
    end_date: contract.end_date || '',
    salary: n(contract.salary),
    medical_aid: !!contract.medical_aid,
    medical_aid_scheme: contract.medical_aid_scheme || '',
    medical_aid_monthly_cost: n(contract.medical_aid_monthly_cost),
    pension_fund: !!contract.pension_fund,
    pension_fund_name: contract.pension_fund_name || '',
    pension_fund_monthly_cost: n(contract.pension_fund_monthly_cost),
    housing_monthly_cost: n(contract.housing_monthly_cost),
    notes: contract.notes || '',
  }
}
function contractPatch(form) {
  const num = (v) => (v === '' ? null : Number(v))
  return {
    contract_type: form.contract_type,
    start_date: form.start_date,
    end_date: form.end_date || null,
    salary: num(form.salary),
    medical_aid: form.medical_aid,
    medical_aid_scheme: form.medical_aid_scheme || null,
    medical_aid_monthly_cost: num(form.medical_aid_monthly_cost),
    pension_fund: form.pension_fund,
    pension_fund_name: form.pension_fund_name || null,
    pension_fund_monthly_cost: num(form.pension_fund_monthly_cost),
    housing_monthly_cost: num(form.housing_monthly_cost),
    notes: form.notes,
  }
}
function fixedRealCostOf(c) {
  return c ? Number(c.salary || 0) + Number(c.medical_aid_monthly_cost || 0) + Number(c.pension_fund_monthly_cost || 0) + Number(c.housing_monthly_cost || 0) : null
}
function contractStatus(contract) {
  if (!contract) return { tone: 'neutral', text: 'No contract', days: null }
  if (!contract.end_date) return { tone: 'good', text: 'Ongoing', days: null }
  const days = daysUntil(contract.end_date)
  if (days === null) return { tone: 'neutral', text: contract.end_date, days }
  if (days < 0) return { tone: 'bad', text: `Ended ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`, days }
  if (days <= 60) return { tone: days <= 14 ? 'bad' : 'neutral', text: `Ends in ${days} day${days === 1 ? '' : 's'}`, days }
  return { tone: 'good', text: `Until ${contract.end_date}`, days }
}

function ContractsTab({ companyId, employees, contracts, onAdd, onUpdate }) {
  const [search, setSearch] = useState('')
  const [deptFilter, setDeptFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [openId, setOpenId] = useState(null) // employee id

  const overview = useMemo(
    () =>
      employees
        .map((e) => ({ employee: e, contract: currentContract(e.id, contracts) }))
        .sort((a, b) => `${a.employee.first_name} ${a.employee.last_name}`.localeCompare(`${b.employee.first_name} ${b.employee.last_name}`)),
    [employees, contracts]
  )
  const departments = useMemo(() => Array.from(new Set(employees.map((e) => e.department?.trim()).filter(Boolean))).sort(), [employees])
  const q = search.trim().toLowerCase()
  const rows = overview
    .filter(({ employee }) => !q || `${employee.first_name} ${employee.last_name} ${employee.position || ''}`.toLowerCase().includes(q))
    .filter(({ employee }) => !deptFilter || (employee.department || '') === deptFilter)
    .filter(({ contract }) => !typeFilter || contract?.contract_type === typeFilter)
    .filter(({ contract }) => {
      if (!statusFilter) return true
      const st = contractStatus(contract)
      if (statusFilter === 'ending') return st.days !== null && st.days >= 0 && st.days <= 60
      if (statusFilter === 'ended') return st.days !== null && st.days < 0
      if (statusFilter === 'none') return !contract
      return true
    })
  // Grouped by department with a header row each (headcount, fixed real
  // cost subtotal) — Thijs, 2026-09-27: "divide people in job categories
  // (housekeeping, management etc)". Employees with no department sit in
  // their own group at the end.
  const groups = []
  for (const r of [...rows].sort((a, b) => (a.employee.department || 'zzz').localeCompare(b.employee.department || 'zzz') || `${a.employee.first_name} ${a.employee.last_name}`.localeCompare(`${b.employee.first_name} ${b.employee.last_name}`))) {
    const key = r.employee.department?.trim() || 'No department'
    let g = groups[groups.length - 1]
    if (!g || g.key !== key) { g = { key, rows: [], fixed: 0, ending: 0 }; groups.push(g) }
    g.rows.push(r)
    g.fixed += fixedRealCostOf(r.contract) || 0
    const d = contractStatus(r.contract).days
    if (d !== null && d <= 60) g.ending++
  }
  const ending = overview.filter(({ contract }) => { const d = contractStatus(contract).days; return d !== null && d >= 0 && d <= 60 }).length
  const ended = overview.filter(({ contract }) => { const d = contractStatus(contract).days; return d !== null && d < 0 }).length
  const totalFixed = overview.reduce((s, { contract }) => s + (fixedRealCostOf(contract) || 0), 0)
  const openRow = openId ? overview.find((r) => r.employee.id === openId) : null

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: colors.muted }}>
          {employees.length} employee{employees.length === 1 ? '' : 's'}
          {ending ? ` · ${ending} contract${ending === 1 ? '' : 's'} ending within 60 days` : ''}
          {ended ? ` · ${ended} ended` : ''}
          {` · fixed real cost R ${fmt(totalFixed)} / month`}
        </div>
      </div>
      <div className="toolbar">
        <input placeholder="Search employee…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
          <option value="">All departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All contracts</option>
          <option value="ending">Ending within 60 days</option>
          <option value="ended">Ended</option>
          <option value="none">No contract</option>
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {CONTRACT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <div style={styles.card}>
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Employee</th>
                <th style={styles.th}>Current contract</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Salary</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Fixed real cost / mo</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.key}>
                  <tr className="group-row">
                    <td style={styles.td} colSpan={3}>
                      <strong>{g.key}</strong> <span style={{ color: colors.muted, fontSize: 12 }}>({g.rows.length}{g.ending ? ` · ${g.ending} ending or ended` : ''})</span>
                    </td>
                    <td style={styles.tdNum}><strong>R {fmt(g.fixed)}</strong></td>
                    <td style={styles.td} colSpan={2} />
                  </tr>
                  {g.rows.map(({ employee, contract }) => {
                const st = contractStatus(contract)
                return (
                  <tr key={employee.id} className="emp-row" onClick={() => setOpenId(employee.id)}>
                    <td style={{ ...styles.td, whiteSpace: 'normal' }}>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <span className="avatar">{initials(employee)}</span>
                        <span><strong>{employee.first_name} {employee.last_name}</strong><span className="emp-sub">{[employee.position, employee.department].filter(Boolean).join(' · ') || 'No position set'}</span></span>
                      </div>
                    </td>
                    <td style={{ ...styles.td, whiteSpace: 'normal' }}>
                      {contract ? <>{contract.contract_type}<span className="emp-sub">{contract.end_date ? `${contract.start_date} → ${contract.end_date}` : `since ${contract.start_date}`}</span></> : <span style={{ color: colors.muted }}>No contract on file</span>}
                    </td>
                    <td style={styles.tdNum}>{contract?.salary ? `R ${fmt(contract.salary)}` : '—'}</td>
                    <td style={styles.tdNum}>{fixedRealCostOf(contract) ? `R ${fmt(fixedRealCostOf(contract))}` : '—'}</td>
                    <td style={styles.td}><span style={styles.badge(st.tone)}>{st.text}</span></td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>
                      <button style={styles.buttonGhost} onClick={(ev) => { ev.stopPropagation(); setOpenId(employee.id) }}>Open</button>
                    </td>
                  </tr>
                )
                  })}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr><td style={styles.td} colSpan={6}>{employees.length === 0 ? 'No employees yet — add them on the Employees tab first.' : 'Nobody matches those filters.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11, color: colors.muted, marginTop: 8 }}>
          Sensitive data — HR Admin only. "Fixed real cost / mo" is salary + healthcare + pension + housing; the Staff Cost tab has the full picture. Medical aid, pension, housing and the contract history are in the contract panel — click a row.
        </div>
      </div>

      {openRow && (
        <ContractDrawer
          key={openId}
          companyId={companyId}
          employee={openRow.employee}
          contract={openRow.contract}
          history={contracts.filter((c) => c.employee_id === openId).sort((a, b) => (a.start_date < b.start_date ? 1 : -1))}
          onAdd={onAdd}
          onUpdate={onUpdate}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  )
}

const CONTRACT_TABS = [
  { id: 'current', label: 'Current contract' },
  { id: 'cost', label: 'Cost' },
  { id: 'history', label: 'History' },
]

function ContractDrawer({ companyId, employee, contract, history, onAdd, onUpdate, onClose }) {
  const [tab, setTab] = useState('current')
  // mode 'edit' amends the current row in place (2026-08-18: the Staff Cost
  // fields were added after most employees already had a contract row, so
  // filling them in must not look like everyone got a new contract that day);
  // mode 'new' inserts a fresh row, which is what a renewal or a change of
  // terms is.
  const [mode, setMode] = useState(contract ? 'edit' : 'new')
  const [form, setForm] = useState(() => (contract ? contractToForm(contract) : BLANK_CONTRACT_FORM))
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const f = (k) => (e) => setForm((x) => ({ ...x, [k]: e.target.value }))
  const baseline = mode === 'edit' && contract ? contractToForm(contract) : BLANK_CONTRACT_FORM
  const dirty = Object.keys(form).some((k) => String(form[k] ?? '') !== String(baseline[k] ?? ''))
  const st = contractStatus(contract)
  const fixed = Number(form.salary || 0) + Number(form.medical_aid ? form.medical_aid_monthly_cost || 0 : 0) + Number(form.pension_fund ? form.pension_fund_monthly_cost || 0 : 0) + Number(form.housing_monthly_cost || 0)

  function startNew() {
    setMode('new')
    // A renewal usually keeps the benefits — prefill from the current row,
    // but start the new contract today and clear the end date.
    setForm(contract ? { ...contractToForm(contract), start_date: todayStr(), end_date: '' } : BLANK_CONTRACT_FORM)
    setTab('current'); setMsg(''); setError('')
  }
  function cancelNew() {
    setMode(contract ? 'edit' : 'new')
    setForm(contract ? contractToForm(contract) : BLANK_CONTRACT_FORM)
    setMsg(''); setError('')
  }

  async function save(e) {
    e.preventDefault()
    setMsg(''); setError('')
    if (!form.start_date) { setError('A start date is needed.'); return }
    if (form.end_date && form.end_date < form.start_date) { setError('The end date is before the start date.'); return }
    setSaving(true)
    try {
      if (mode === 'edit' && contract) {
        const [row] = await sb.update('hr_contracts', { id: contract.id }, contractPatch(form))
        onUpdate(row)
        setMsg('Saved — same contract row, amended in place.')
      } else {
        const [row] = await sb.insert('hr_contracts', { company_id: companyId, employee_id: employee.id, ...contractPatch(form) })
        onAdd(row)
        setMode('edit')
        setMsg('New contract added. The previous one stays in History.')
      }
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  const meta = (
    <>
      <span>{[employee.position, employee.department].filter(Boolean).join(' · ') || 'No position set'}{contract ? ` · ${contract.contract_type} · ${contract.end_date ? `${contract.start_date} → ${contract.end_date}` : `since ${contract.start_date}`}` : ''}</span>
      <span style={styles.badge(st.tone)}>{st.text}</span>
    </>
  )
  const footer = (
    <>
      <button type="submit" form="contract-form" style={styles.button} disabled={saving || !dirty || tab !== 'current'}>{saving ? 'Saving…' : mode === 'new' ? 'Add contract' : 'Save changes'}</button>
      {mode === 'new' && contract ? (
        <button type="button" style={styles.buttonGhost} onClick={cancelNew}>Back to current</button>
      ) : contract ? (
        <button type="button" style={styles.buttonGhost} onClick={startNew}>+ New contract</button>
      ) : null}
      <button type="button" style={styles.buttonGhost} onClick={onClose}>{dirty ? 'Cancel' : 'Close'}</button>
      <span className="hint">{error ? <span style={{ color: colors.danger }}>{error}</span> : msg || (mode === 'new' ? 'Adds a new row — the current one is kept in History' : 'Sensitive — HR Admin only')}</span>
    </>
  )

  return (
    <Drawer title={`${employee.first_name} ${employee.last_name} — contract`} meta={meta} tabs={CONTRACT_TABS} tab={tab} onTab={setTab} onClose={onClose} footer={footer}>
      <form id="contract-form" onSubmit={save}>
        {tab === 'current' && (
          <>
            {mode === 'new' && contract && (
              <div className="drawer-note" style={{ marginBottom: 14 }}>
                New contract for {employee.first_name} — prefilled from the current one. It becomes the current contract from its start date; the old one is kept in History.
              </div>
            )}
            {!contract && <div className="drawer-note" style={{ marginBottom: 14 }}>No contract on file yet for {employee.first_name}. This adds the first one.</div>}
            <div className="drawer-grid">
              <div className="field"><label style={styles.label}>Contract type</label>
                <select style={styles.input} value={form.contract_type} onChange={f('contract_type')}>{CONTRACT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
              </div>
              <div className="field"><label style={styles.label}>Start date</label><input type="date" style={styles.input} value={form.start_date} onChange={f('start_date')} /></div>
              <div className="field"><label style={styles.label}>End date</label><input type="date" style={styles.input} value={form.end_date} onChange={f('end_date')} /><div className="help">Blank if ongoing.</div></div>
              <div className="field"><label style={styles.label}>Salary / month</label><input type="number" inputMode="decimal" style={styles.input} value={form.salary} onChange={f('salary')} /></div>
            </div>
            <div className="drawer-sect">Benefits</div>
            <div className="drawer-grid">
              <div className="field"><label style={styles.label}>Medical aid</label>
                <select style={styles.input} value={form.medical_aid ? 'yes' : 'no'} onChange={(e) => setForm((x) => ({ ...x, medical_aid: e.target.value === 'yes' }))}><option value="no">No</option><option value="yes">Yes</option></select>
              </div>
              {form.medical_aid ? (
                <>
                  <div className="field"><label style={styles.label}>Scheme</label><input style={styles.input} value={form.medical_aid_scheme} onChange={f('medical_aid_scheme')} /></div>
                  <div className="field"><label style={styles.label}>Medical aid — company cost / month</label><input type="number" inputMode="decimal" style={styles.input} value={form.medical_aid_monthly_cost} onChange={f('medical_aid_monthly_cost')} /></div>
                </>
              ) : <div className="field" />}
              <div className="field"><label style={styles.label}>Pension fund</label>
                <select style={styles.input} value={form.pension_fund ? 'yes' : 'no'} onChange={(e) => setForm((x) => ({ ...x, pension_fund: e.target.value === 'yes' }))}><option value="no">No</option><option value="yes">Yes</option></select>
              </div>
              {form.pension_fund ? (
                <>
                  <div className="field"><label style={styles.label}>Fund name</label><input style={styles.input} value={form.pension_fund_name} onChange={f('pension_fund_name')} /></div>
                  <div className="field"><label style={styles.label}>Pension — company cost / month</label><input type="number" inputMode="decimal" style={styles.input} value={form.pension_fund_monthly_cost} onChange={f('pension_fund_monthly_cost')} /></div>
                </>
              ) : <div className="field" />}
              <div className="field full"><label style={styles.label}>Housing cost / month</label><input type="number" inputMode="decimal" style={styles.input} value={form.housing_monthly_cost} onChange={f('housing_monthly_cost')} /><div className="help">Electricity, water, upkeep of staff accommodation.</div></div>
              <div className="field full"><label style={styles.label}>Notes</label><input style={styles.input} value={form.notes} onChange={f('notes')} /></div>
            </div>
            {mode === 'edit' && contract && (
              <div className="drawer-note" style={{ marginTop: 14 }}>
                Editing here amends this contract row in place — no new row, no new start. To renew or change terms, use <b>+ New contract</b> in the footer; that keeps the history.
              </div>
            )}
          </>
        )}

        {tab === 'cost' && (
          <>
            <div className="drawer-stat"><span>Salary</span><span>R {fmt(form.salary || 0)}</span></div>
            <div className="drawer-stat"><span>Medical aid (company)</span><span>{form.medical_aid ? `R ${fmt(form.medical_aid_monthly_cost || 0)}` : '—'}</span></div>
            <div className="drawer-stat"><span>Pension (company)</span><span>{form.pension_fund ? `R ${fmt(form.pension_fund_monthly_cost || 0)}` : '—'}</span></div>
            <div className="drawer-stat"><span>Housing</span><span>R {fmt(form.housing_monthly_cost || 0)}</span></div>
            <div className="drawer-stat" style={{ borderBottom: 'none' }}><span style={{ fontWeight: 700, color: colors.goldLt }}>Fixed real cost / month</span><b style={{ color: colors.goldLt }}>R {fmt(fixed)}</b></div>
            <div style={{ fontSize: 12, color: colors.muted, marginTop: 12, lineHeight: 1.5 }}>
              Salary + healthcare + pension + housing only{dirty ? ' (as typed, not yet saved)' : ''}. Uniforms, bonuses, leave provision and the share of staff food and beverage are on the Staff Cost tab.
            </div>
          </>
        )}

        {tab === 'history' && (
          <>
            <table style={styles.table}>
              <thead><tr><th style={styles.th}>Contract</th><th style={styles.th}>Period</th><th style={{ ...styles.th, textAlign: 'right' }}>Salary</th><th style={{ ...styles.th, textAlign: 'right' }}>Fixed cost / mo</th></tr></thead>
              <tbody>
                {history.map((c) => (
                  <tr key={c.id}>
                    <td style={styles.td}>{c.contract_type}{contract && c.id === contract.id && <> <span style={styles.badge('good')}>current</span></>}{c.notes ? <span className="emp-sub">{c.notes}</span> : null}</td>
                    <td style={styles.td}>{c.start_date} → {c.end_date || 'ongoing'}</td>
                    <td style={styles.tdNum}>{c.salary ? `R ${fmt(c.salary)}` : '—'}</td>
                    <td style={styles.tdNum}>{fixedRealCostOf(c) ? `R ${fmt(fixedRealCostOf(c))}` : '—'}</td>
                  </tr>
                ))}
                {history.length === 0 && <tr><td style={styles.td} colSpan={4}>No contract on record yet.</td></tr>}
              </tbody>
            </table>
          </>
        )}
      </form>
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// Staff Loans tab — HR Admin only, same visibility as Contracts (2026-08-17,
// redesigned 2026-08-19). Reference only — nothing here feeds payroll or
// deducts anything automatically.
//
// Redesigned 2026-08-19 per Thijs: a loan is now a per-employee "cost
// center" rather than one flat line item. Individual amounts can be
// STACKED onto the same employee (e.g. a second advance while the first is
// still being paid off) while the monthly deduction is a single figure per
// employee that stays put unless deliberately changed — adding another
// amount does not ask for the deduction again, it just carries forward.
// Under the hood this still stores one row per stacked amount in
// hr_staff_loans (no schema change): the MOST RECENT row's
// monthly_deduction is treated as the employee's current rate, and the
// "Edit deduction" control bulk-patches every one of that employee's rows
// so the rate stays consistent no matter which row is "latest". Remaining
// balance and months-to-payoff are estimated by simulating month-by-month
// (add whatever was borrowed that month, then subtract one month's
// deduction, floored at 0) from the employee's first loan to today — still
// just a rough at-a-glance figure; if it and Thijs's own records disagree,
// his records win.
// ---------------------------------------------------------------------------

function firstOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

// Simulates one pooled balance for all of an employee's stacked loan
// amounts AND any additional/extra payments they've made (2026-08-19):
// walk month by month from the earliest row's month to the current month,
// adding whatever's dated in that month (a loan row is a positive amount, an
// extra payment row is stored as a NEGATIVE amount so it just falls out of
// the same running total), then subtracting one month's regular deduction
// (skipped for the very first month, since the loan was only taken partway
// through it) — floored at 0. Extra payments pay down the balance on top of
// whatever the regular monthly deduction already covers that month.
function simulateLoanCenter(empLoans) {
  const sorted = [...empLoans].sort((a, b) => (a.loan_date < b.loan_date ? -1 : a.loan_date > b.loan_date ? 1 : 0))
  const loanRows = sorted.filter((l) => Number(l.amount || 0) > 0)
  const paymentRows = sorted.filter((l) => Number(l.amount || 0) < 0)
  const totalBorrowed = loanRows.reduce((s, l) => s + Number(l.amount || 0), 0)
  const totalExtraPayments = paymentRows.reduce((s, l) => s + Math.abs(Number(l.amount || 0)), 0)
  // Deduction rate always comes from the latest LOAN row, never a payment
  // row — otherwise logging an extra payment (which has no deduction of its
  // own) could look like the rate got reset to 0 if it happened to be the
  // most recently dated row.
  const deduction = Number(loanRows[loanRows.length - 1]?.monthly_deduction || 0)

  let balance = 0
  let li = 0
  let cursor = firstOfMonth(parseDateOnly(sorted[0].loan_date))
  const nowStart = firstOfMonth(new Date())
  let firstMonth = true
  while (cursor.getTime() <= nowStart.getTime()) {
    while (li < sorted.length && firstOfMonth(parseDateOnly(sorted[li].loan_date)).getTime() === cursor.getTime()) {
      balance += Number(sorted[li].amount || 0)
      li++
    }
    if (!firstMonth && deduction > 0) balance = Math.max(0, balance - deduction)
    balance = Math.max(0, balance)
    firstMonth = false
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  }

  const monthsToPayOff = deduction > 0 && balance > 0 ? Math.ceil(balance / deduction) : deduction > 0 ? 0 : null
  return { loans: sorted, totalBorrowed, totalExtraPayments, deduction, balance, monthsToPayOff }
}

function LoansTab({ companyId, employees, loans, onAdd, onUpdate, onRemove }) {
  const [form, setForm] = useState({ employee_id: '', loan_date: todayStr(), amount: '', monthly_deduction: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [deductionEdits, setDeductionEdits] = useState({}) // employee_id -> in-progress edit value
  const [savingDeductionFor, setSavingDeductionFor] = useState(null)
  // Additional/extra payment popup (2026-08-19) — Thijs: staff sometimes pay
  // extra to clear a loan faster, on top of the regular monthly deduction.
  // Holds the employee_id the popup is currently open for, or null.
  const [paymentPopupFor, setPaymentPopupFor] = useState(null)

  const empName = (id) => {
    const e = employees.find((x) => x.id === id)
    return e ? `${e.first_name} ${e.last_name}` : 'Unknown'
  }

  const loanCenters = useMemo(() => {
    const byEmp = {}
    for (const l of loans) {
      if (!byEmp[l.employee_id]) byEmp[l.employee_id] = []
      byEmp[l.employee_id].push(l)
    }
    return Object.keys(byEmp)
      .map((employee_id) => ({ employee_id, ...simulateLoanCenter(byEmp[employee_id]) }))
      .sort((a, b) => b.balance - a.balance)
  }, [loans])

  const centerByEmployeeId = useMemo(() => {
    const map = {}
    for (const c of loanCenters) map[c.employee_id] = c
    return map
  }, [loanCenters])

  // Selecting an employee who already has a loan center prefills the
  // deduction with their current rate (so it "stays the same" by default —
  // Thijs can still change it before saving if the rate itself changed).
  function chooseEmployee(id) {
    const existing = centerByEmployeeId[id]
    setForm({
      employee_id: id,
      loan_date: todayStr(),
      amount: '',
      monthly_deduction: existing ? String(existing.deduction || '') : '',
      notes: '',
    })
  }

  async function addLoan() {
    if (!form.employee_id || !form.amount) return
    setSaving(true)
    const [row] = await sb.insert('hr_staff_loans', {
      company_id: companyId,
      employee_id: form.employee_id,
      loan_date: form.loan_date,
      amount: Number(form.amount),
      monthly_deduction: form.monthly_deduction === '' ? 0 : Number(form.monthly_deduction),
      notes: form.notes || null,
    })
    setForm({ employee_id: '', loan_date: todayStr(), amount: '', monthly_deduction: '', notes: '' })
    setSaving(false)
    onAdd(row)
  }

  async function removeLoan(id) {
    await sb.remove('hr_staff_loans', { id })
    onRemove(id)
  }

  // Logs an extra/additional payment on top of the regular monthly
  // deduction (2026-08-19) — e.g. a staff member hands over a lump sum to
  // clear their loan faster. Stored as just another hr_staff_loans row for
  // that employee, with the amount NEGATIVE so simulateLoanCenter's running
  // total simply subtracts it in the month it happened — no schema change,
  // and it shows up in the same stacked history table, labeled "Payment".
  async function addPayment(employeeId, { date, amount, notes }) {
    if (!employeeId || !amount) return
    const center = centerByEmployeeId[employeeId]
    const [row] = await sb.insert('hr_staff_loans', {
      company_id: companyId,
      employee_id: employeeId,
      loan_date: date,
      amount: -Math.abs(Number(amount)),
      monthly_deduction: center ? center.deduction : 0,
      notes: notes || 'Additional payment',
    })
    onAdd(row)
    setPaymentPopupFor(null)
  }

  async function saveDeduction(employeeId) {
    const raw = deductionEdits[employeeId]
    if (raw === undefined) return
    const value = raw === '' ? 0 : Number(raw)
    setSavingDeductionFor(employeeId)
    const rows = await sb.update('hr_staff_loans', { employee_id: employeeId, company_id: companyId }, { monthly_deduction: value })
    for (const row of rows || []) onUpdate(row)
    setSavingDeductionFor(null)
    setDeductionEdits((prev) => {
      const next = { ...prev }
      delete next[employeeId]
      return next
    })
  }

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Log a staff loan</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Reference only — nothing here feeds payroll or deducts anything automatically. Choosing an
          employee who already has a loan on record stacks this amount onto their existing balance and
          carries their current monthly deduction forward (change it below if the rate itself changed).
          HR Admin only, same as Contracts.
        </div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Employee</label>
            <select style={styles.input} value={form.employee_id} onChange={(e) => chooseEmployee(e.target.value)}>
              <option value="">Choose employee…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.first_name} {e.last_name}
                  {centerByEmployeeId[e.id] ? ` (existing balance R ${fmt(centerByEmployeeId[e.id].balance)})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Loan date</label>
            <input
              type="date"
              style={styles.input}
              value={form.loan_date}
              onChange={(e) => setForm({ ...form, loan_date: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Amount</label>
            <input
              type="number" inputMode="decimal"
              style={styles.input}
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Monthly deduction{form.employee_id && centerByEmployeeId[form.employee_id] ? ' (current rate)' : ''}</label>
            <input
              type="number" inputMode="decimal"
              style={styles.input}
              value={form.monthly_deduction}
              onChange={(e) => setForm({ ...form, monthly_deduction: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Notes (optional)</label>
            <input style={styles.input} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        <button style={styles.button} onClick={addLoan} disabled={saving}>
          {saving ? 'Saving…' : form.employee_id && centerByEmployeeId[form.employee_id] ? 'Add to balance' : 'Add loan'}
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>
          {loanCenters.length} employee{loanCenters.length === 1 ? '' : 's'} with a loan balance
        </div>
        {loanCenters.length === 0 && <div style={{ fontSize: 12, color: colors.muted }}>No loans logged yet.</div>}
        {loanCenters.map((c) => {
          const editing = deductionEdits[c.employee_id] !== undefined
          return (
            <div key={c.employee_id} style={{ ...styles.card, background: 'rgba(255,255,255,.02)', marginTop: 10 }}>
              <div style={{ ...styles.row, justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: colors.goldLt }}>{empName(c.employee_id)}</div>
                <div style={{ ...styles.row, gap: 20, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 16, fontFamily: fonts.mono, color: colors.cream }}>R {fmt(c.totalBorrowed)}</div>
                    <div style={{ fontSize: 10, color: colors.muted }}>Total borrowed</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 16, fontFamily: fonts.mono, color: c.balance > 0 ? colors.danger : colors.ok }}>
                      R {fmt(c.balance)}
                    </div>
                    <div style={{ fontSize: 10, color: colors.muted }}>Est. remaining</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 16, fontFamily: fonts.mono, color: colors.cream }}>
                      {c.monthsToPayOff === null ? '—' : c.monthsToPayOff === 0 ? 'Paid off' : `${c.monthsToPayOff} mo`}
                    </div>
                    <div style={{ fontSize: 10, color: colors.muted }}>Est. months left</div>
                  </div>
                  <div>
                    <label style={{ ...styles.label, marginBottom: 2 }}>Monthly deduction</label>
                    <div style={{ ...styles.row, gap: 6 }}>
                      <input
                        type="number" inputMode="decimal"
                        style={{ ...styles.smallInput, width: 90 }}
                        value={editing ? deductionEdits[c.employee_id] : c.deduction}
                        onChange={(e) => setDeductionEdits((prev) => ({ ...prev, [c.employee_id]: e.target.value }))}
                      />
                      {editing && (
                        <button
                          style={{ ...styles.buttonGhost, padding: '3px 8px', fontSize: 12 }}
                          onClick={() => saveDeduction(c.employee_id)}
                          disabled={savingDeductionFor === c.employee_id}
                        >
                          {savingDeductionFor === c.employee_id ? 'Saving…' : 'Save'}
                        </button>
                      )}
                    </div>
                  </div>
                  <div>
                    <label style={{ ...styles.label, marginBottom: 2 }}>&nbsp;</label>
                    <button
                      style={{ ...styles.buttonGhost, padding: '5px 10px', fontSize: 12 }}
                      onClick={() => setPaymentPopupFor(c.employee_id)}
                    >
                      + Log additional payment
                    </button>
                  </div>
                </div>
              </div>

              {c.totalExtraPayments > 0 && (
                <div style={{ fontSize: 11, color: colors.ok, marginTop: 6 }}>
                  R {fmt(c.totalExtraPayments)} in extra payments logged on top of the regular deduction.
                </div>
              )}

              <div style={{ ...styles.tableWrap, marginTop: 10 }}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Date</th>
                      <th style={styles.th}>Type</th>
                      <th style={styles.th}>Amount</th>
                      <th style={styles.th}>Notes</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.loans
                      .slice()
                      .sort((a, b) => (a.loan_date < b.loan_date ? 1 : -1))
                      .map((l) => {
                        const isPayment = Number(l.amount) < 0
                        return (
                          <tr key={l.id}>
                            <td style={styles.td}>{l.loan_date}</td>
                            <td style={styles.td}>
                              <span style={{ color: isPayment ? colors.ok : colors.muted }}>{isPayment ? 'Payment' : 'Loan'}</span>
                            </td>
                            <td style={{ ...styles.tdNum, color: isPayment ? colors.ok : colors.cream }}>
                              {isPayment ? '− ' : ''}R {fmt(Math.abs(l.amount))}
                            </td>
                            <td style={styles.td}>{l.notes || '—'}</td>
                            <td style={styles.td}>
                              <button style={styles.buttonDanger} onClick={() => removeLoan(l.id)}>
                                Delete
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })}
      </div>

      {paymentPopupFor && (
        <AddPaymentModal
          employeeName={empName(paymentPopupFor)}
          currentBalance={centerByEmployeeId[paymentPopupFor]?.balance || 0}
          onClose={() => setPaymentPopupFor(null)}
          onSave={(data) => addPayment(paymentPopupFor, data)}
        />
      )}
    </>
  )
}

// Popup for logging an extra/additional payment against an employee's loan
// balance (2026-08-19) — separate from the main "Log a staff loan" form
// since this is the opposite direction (money coming IN off the balance,
// not going out), and Thijs asked for it as its own button + pop-up rather
// than folded into the add-loan form. Same overlay chrome as
// ConfirmPopup/EmployeeUniformModal elsewhere in this file.
function AddPaymentModal({ employeeName, currentBalance, onClose, onSave }) {
  const [date, setDate] = useState(todayStr())
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!amount) return
    setSaving(true)
    await onSave({ date, amount: Number(amount), notes })
    setSaving(false)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div style={{ ...styles.card, maxWidth: 360, width: '100%' }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.cardTitle}>Log additional payment — {employeeName}</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          For extra payments on top of the regular monthly deduction — e.g. a lump sum to clear the loan
          faster. Current balance: R {fmt(currentBalance)}.
        </div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Payment date</label>
            <input type="date" style={styles.input} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label style={styles.label}>Amount</label>
            <input type="number" inputMode="decimal" style={styles.input} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label style={styles.label}>Notes (optional)</label>
            <input style={styles.input} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <div style={{ ...styles.row, gap: 8, marginTop: 8 }}>
          <button style={styles.button} onClick={handleSave} disabled={saving || !amount}>
            {saving ? 'Saving…' : 'Log payment'}
          </button>
          <button style={styles.buttonGhost} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Staff Cost tab — HR Admin only. "Real cost" per employee: salary +
// healthcare + pension + housing (from their contract, fixed) plus a live
// share of staff Food and Beverage consumption (from the Food Stock/
// Beverage Stock apps, divided across whoever was scheduled at that
// location that week — see staffCostEngine.js for the full calculation).
// ---------------------------------------------------------------------------

function StaffCostTab({ companyId, employees, contracts, scheduleLocations, bonuses, setBonuses }) {
  const today = todayStr()
  const defaultStart = (() => {
    const d = new Date(`${today}T00:00:00`)
    d.setDate(d.getDate() - 28)
    return isoDate(d)
  })()
  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate] = useState(today)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Bonus logging (2026-08-27). Lives here rather than on Employees because
  // this is the screen where you'd notice a bonus is missing from the cost.
  const [bForm, setBForm] = useState({ employee_id: '', bonus_date: todayStr(), amount: '', bonus_type: '', note: '' })
  const [bSaving, setBSaving] = useState(false)
  const [bError, setBError] = useState('')

  async function run() {
    setLoading(true)
    setError('')
    try {
      const data = await getRealStaffCostOverview({ companyId, employees, contracts, scheduleLocations, startDate, endDate })
      setResult(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (companyId) run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])

  async function addBonus() {
    setBError('')
    if (!bForm.employee_id || !bForm.amount) { setBError('Pick an employee and enter an amount.'); return }
    setBSaving(true)
    try {
      const [row] = await sb.insert('hr_bonuses', {
        company_id: companyId,
        employee_id: bForm.employee_id,
        bonus_date: bForm.bonus_date,
        amount: Number(bForm.amount),
        bonus_type: bForm.bonus_type.trim() || null,
        note: bForm.note.trim() || null,
      })
      setBonuses((prev) => [row, ...prev])
      setBForm({ employee_id: '', bonus_date: bForm.bonus_date, amount: '', bonus_type: '', note: '' })
      run()  // recompute so the new bonus shows in the smoothed column
    } catch (e) { setBError(e.message) }
    finally { setBSaving(false) }
  }

  async function removeBonus(id) {
    if (!window.confirm('Delete this bonus?')) return
    try {
      await sb.remove('hr_bonuses', { id })
      setBonuses((prev) => prev.filter((b) => b.id !== id))
      run()
    } catch (e) { alert('Could not delete: ' + e.message) }
  }

  const empName = (id) => {
    const e = employees.find((x) => x.id === id)
    return e ? `${e.first_name} ${e.last_name}` : 'Unknown'
  }

  const sortedEmployeeRows = useMemo(() => {
    if (!result) return []
    return [...result.employeeRows].sort((a, b) => b.totalMonthly - a.totalMonthly)
  }, [result])

  const grandTotal = sortedEmployeeRows.reduce((s, r) => s + r.totalMonthly, 0)
  // Kept apart from grandTotal on purpose: leave owed is a liability you'd
  // settle if people left, not part of what staff cost you each month.
  const grandLeaveProvision = sortedEmployeeRows.reduce((s, r) => s + (r.leaveProvision || 0), 0)

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Real Staff Cost</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Salary + healthcare + pension + housing (from Contracts) plus each employee's share of staff Food and
          Beverage usage, sourced live from the Food Stock and Beverage Stock apps (any issue logged with reason
          "Staff") and divided by however many staff were scheduled at that location each week. Employees with no
          Schedule entries in the chosen range show a Food/Bev share of R0 — add them to the Schedule tab to include
          them.
          <br /><br />
          <strong>Uniforms</strong> come from what was actually issued to each person in the Uniforms tab, priced at
          each item's own price, and <strong>Bonuses</strong> from what's been logged below. Both are lumpy by nature
          — a jacket or a 13th cheque lands in one month — so both are shown as the last 12 months spread evenly
          over 12, which makes people comparable. Hover either figure to see the actual 12-month total.
          <br /><br />
          <strong>Leave owed</strong> sits outside the monthly total on purpose. Pay received while on leave is
          already inside the salary, so counting it again would inflate every figure here. What's shown instead is
          the value of leave accrued but not yet taken — what you'd owe if someone left tomorrow — valued on salary
          alone, since medical aid and pension carry on regardless.
        </div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>From</label>
            <input type="date" style={styles.input} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <label style={styles.label}>To</label>
            <input type="date" style={styles.input} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>
        <button style={styles.button} onClick={run} disabled={loading}>
          {loading ? 'Calculating…' : 'Run'}
        </button>
        {error && <div style={{ color: colors.danger, marginTop: 8 }}>{error}</div>}
      </div>

      {result && (
        <>
          <div style={styles.card}>
            <div style={styles.cardTitle}>Food + Beverage cost per head, by location</div>
            <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
              {result.weeks.length} week{result.weeks.length === 1 ? '' : 's'} in range, weeks starting Monday. Monthly
              figure is the weekly average projected ×4.345 (weeks/month), same convention used everywhere else.
            </div>
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Location</th>
                    <th style={styles.th}>Total Food cost</th>
                    <th style={styles.th}>Total Beverage cost</th>
                    <th style={styles.th}>Weeks with headcount</th>
                    <th style={styles.th}>Avg cost/head/week</th>
                    <th style={styles.th}>Avg cost/head/month</th>
                  </tr>
                </thead>
                <tbody>
                  {result.locationSummary.map((r) => (
                    <tr key={r.location}>
                      <td style={styles.td}>{r.location}</td>
                      <td style={styles.tdNum}>R {fmt(r.totalFood)}</td>
                      <td style={styles.tdNum}>R {fmt(r.totalBev)}</td>
                      <td style={styles.td}>
                        {r.weeksWithHeadcount} / {r.weeksCovered}
                      </td>
                      <td style={styles.tdNum}>{r.avgPerHeadWeekly !== null ? `R ${fmt(r.avgPerHeadWeekly)}` : '—'}</td>
                      <td style={styles.tdNum}>{r.avgPerHeadMonthly !== null ? `R ${fmt(r.avgPerHeadMonthly)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={styles.card}>
            <div style={styles.cardTitle}>Real cost per employee, per month</div>
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Employee</th>
                    <th style={styles.th}>Salary</th>
                    <th style={styles.th}>Healthcare</th>
                    <th style={styles.th}>Pension</th>
                    <th style={styles.th}>Housing</th>
                    <th style={styles.th}>Food + Bev share</th>
                    <th style={styles.th}>Uniforms /mo</th>
                    <th style={styles.th}>Bonuses /mo</th>
                    <th style={styles.th}>Real cost/month</th>
                    <th style={styles.th}>Leave owed</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedEmployeeRows.map((r) => (
                    <tr key={r.employee.id}>
                      <td style={styles.td}>{empName(r.employee.id)}</td>
                      <td style={styles.tdNum}>{r.salary ? `R ${fmt(r.salary)}` : '—'}</td>
                      <td style={styles.tdNum}>{r.healthcare ? `R ${fmt(r.healthcare)}` : '—'}</td>
                      <td style={styles.tdNum}>{r.pension ? `R ${fmt(r.pension)}` : '—'}</td>
                      <td style={styles.tdNum}>{r.housing ? `R ${fmt(r.housing)}` : '—'}</td>
                      <td style={styles.tdNum}>
                        {r.hasScheduleData ? `R ${fmt(r.foodBevMonthly)}` : <span style={styles.badge('neutral')}>no schedule data</span>}
                      </td>
                      <td style={styles.tdNum} title={r.uniform12mo ? `R ${fmt(r.uniform12mo)} issued in the last 12 months` : undefined}>
                        {r.uniformMonthly ? `R ${fmt(r.uniformMonthly)}` : '—'}
                      </td>
                      <td style={styles.tdNum} title={r.bonus12mo ? `R ${fmt(r.bonus12mo)} paid in the last 12 months` : undefined}>
                        {r.bonusMonthly ? `R ${fmt(r.bonusMonthly)}` : '—'}
                      </td>
                      <td style={styles.tdNum}>
                        <strong>R {fmt(r.totalMonthly)}</strong>
                      </td>
                      <td style={styles.tdNum} title={`${fmt(r.leaveDaysOwed, 1)} days owed of ${fmt(r.leaveDaysEntitled, 0)} (${fmt(r.leaveDaysTaken, 1)} taken)`}>
                        {r.leaveProvision ? `R ${fmt(r.leaveProvision)}` : '—'}
                      </td>
                    </tr>
                  ))}
                  {sortedEmployeeRows.length === 0 && (
                    <tr>
                      <td style={styles.td} colSpan={9}>
                        No employees yet.
                      </td>
                    </tr>
                  )}
                </tbody>
                {sortedEmployeeRows.length > 0 && (
                  <tfoot>
                    <tr>
                      <td style={styles.td}>
                        <strong>Total</strong>
                      </td>
                      <td style={styles.td} colSpan={7} />
                      <td style={styles.tdNum}>
                        <strong>R {fmt(grandTotal)}</strong>
                      </td>
                      <td style={styles.tdNum}>
                        <strong>R {fmt(grandLeaveProvision)}</strong>
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </>
      )}

      <div style={styles.card}>
        <div style={styles.cardTitle}>Bonuses</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Log a bonus and it feeds the Bonuses column above, spread over 12 months. Unlike uniforms and leave there
          is nothing in the system to read a bonus from, so these have to be entered.
        </div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Employee</label>
            <select style={styles.input} value={bForm.employee_id} onChange={(e) => setBForm({ ...bForm, employee_id: e.target.value })}>
              <option value="">Select…</option>
              {[...employees]
                .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`))
                .map((e) => (
                  <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>
                ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Date</label>
            <input type="date" style={styles.input} value={bForm.bonus_date} onChange={(e) => setBForm({ ...bForm, bonus_date: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Amount (R)</label>
            <input type="number" inputMode="decimal" style={styles.input} value={bForm.amount} onChange={(e) => setBForm({ ...bForm, amount: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Type</label>
            <input type="text" style={styles.input} placeholder="e.g. 13th cheque, performance" value={bForm.bonus_type} onChange={(e) => setBForm({ ...bForm, bonus_type: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Note</label>
            <input type="text" style={styles.input} value={bForm.note} onChange={(e) => setBForm({ ...bForm, note: e.target.value })} />
          </div>
        </div>
        {bError && <div style={{ color: colors.danger, fontSize: 12, marginTop: 6 }}>{bError}</div>}
        <button style={styles.button} onClick={addBonus} disabled={bSaving}>{bSaving ? 'Saving…' : 'Log bonus'}</button>

        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Date</th>
                <th style={styles.th}>Employee</th>
                <th style={styles.th}>Type</th>
                <th style={styles.th}>Amount</th>
                <th style={styles.th}>Note</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {(bonuses || []).map((b) => (
                <tr key={b.id}>
                  <td style={styles.td}>{b.bonus_date}</td>
                  <td style={styles.td}>{empName(b.employee_id)}</td>
                  <td style={styles.td}>{b.bonus_type || '—'}</td>
                  <td style={styles.tdNum}>R {fmt(b.amount)}</td>
                  <td style={styles.td}>{b.note || '—'}</td>
                  <td style={styles.td}>
                    <button style={styles.buttonGhost} onClick={() => removeBonus(b.id)}>Delete</button>
                  </td>
                </tr>
              ))}
              {(bonuses || []).length === 0 && (
                <tr><td style={styles.td} colSpan={6}>No bonuses logged yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Confirmation popup — shown after Broken/Replace and Return actions so
// it's obvious the action actually went through.
// ---------------------------------------------------------------------------

function ConfirmPopup({ message, onClose }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 70,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div style={{ ...styles.card, maxWidth: 300, textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 26, marginBottom: 6, color: colors.ok }}>✓</div>
        <div style={{ fontSize: 14, marginBottom: 14 }}>{message}</div>
        <button style={{ ...styles.button, width: '100%' }} onClick={onClose}>
          OK
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Employee uniform detail — opened from either the Uniforms tab or the
// Employees tab. Shows every item ever issued to this person, with
// Mark broken and Return on whatever's currently issued, and Issue
// replacement on a broken row that hasn't been replaced yet.
// ---------------------------------------------------------------------------

function EmployeeUniformModal({ role, companyId, employee, items, stockByItem, issues, onClose, onStockChange, onIssuesAdd, onIssuesUpdate, onIssuesRemove, embedded = false }) {
  const [confirmMsg, setConfirmMsg] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const canDelete = role === 'hradmin'

  const empIssues = useMemo(
    () =>
      issues
        .filter((i) => i.employee_id === employee.id)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    [issues, employee.id]
  )

  // Counts what this employee is currently holding (status 'issued' only —
  // broken/returned rows are closed history, not stock they still have),
  // grouped by the item's category, so it's quick to see "3 shirts, 2
  // pants" without counting rows in the table below.
  const currentByCategory = useMemo(() => {
    const counts = {}
    empIssues
      .filter((i) => i.status === 'issued')
      .forEach((i) => {
        const cat = items.find((x) => x.id === i.item_id)?.category || 'Other'
        counts[cat] = (counts[cat] || 0) + 1
      })
    return Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]))
  }, [empIssues, items])
  const totalCurrent = currentByCategory.reduce((s, [, n]) => s + n, 0)

  const itemName = (id) => {
    const it = items.find((i) => i.id === id)
    return it ? `${it.name}${it.size ? ` (${it.size})` : ''}` : 'Unknown item'
  }

  // Which broken rows already had a replacement issued against them. Derived
  // from replaces_issue_id rather than stored, so it stays true no matter how
  // the replacement got there.
  const replacedIssueIds = useMemo(
    () => new Set(issues.filter((i) => i.replaces_issue_id).map((i) => i.replaces_issue_id)),
    [issues]
  )

  // "Broken — replace" used to be ONE button doing three things: close the old
  // row, issue a new one, and decrement stock. They are separate events. An
  // item gets written off without a replacement going out more often than not
  // — the shelf is empty, the employee is leaving, or the size was wrong and a
  // different one is issued instead. Merging them meant every write-off
  // silently pulled a unit out of stock whether one went out or not.
  //
  // So: this closes the row and touches nothing else.
  async function markBroken(issue) {
    const [updated] = await sb.update('hr_uniform_issues', { id: issue.id }, { status: 'broken', resolved_date: todayStr() })
    onIssuesUpdate(updated)
    // No stock movement, on purpose. A broken item does not go back on the
    // shelf, and nothing has come off it either — issuing the replacement is
    // what moves stock, and that is now its own click.
    setConfirmMsg(`${itemName(issue.item_id)} marked broken. Use "Issue replacement" if a new one goes out.`)
  }

  // Issues a replacement against an already-broken row. Offered once per row
  // (see replacedIssueIds) — a second click would take a second unit out of
  // stock with nothing on screen to show the first one had happened.
  async function replaceItem(issue) {
    const stock = stockByItem[issue.item_id]
    const onHand = stock?.qty_on_hand ?? 0
    const [newIssue] = await sb.insert('hr_uniform_issues', {
      item_id: issue.item_id,
      employee_id: issue.employee_id,
      company_id: companyId,
      status: 'issued',
      issued_date: todayStr(),
      replaces_issue_id: issue.id,
    })
    const [stockRow] = await sb.upsert(
      'hr_uniform_stock',
      {
        item_id: issue.item_id,
        company_id: companyId,
        qty_on_hand: onHand - 1,
        min_units: stock?.min_units ?? 0,
        max_units: stock?.max_units ?? 0,
      },
      'item_id'
    )
    onIssuesAdd(newIssue)
    onStockChange(stockRow)
    // Not blocked when the shelf is empty — issueNew() does not block either,
    // and HR hands out the last item before the count catches up often enough
    // that refusing would just get worked around. But it is SAID, because a
    // silent negative on-hand is how a count drifts without anyone noticing.
    setConfirmMsg(
      onHand > 0
        ? `Replacement ${itemName(issue.item_id)} issued to ${employee.first_name}.`
        : `Replacement ${itemName(issue.item_id)} issued to ${employee.first_name} — but stock was already ${onHand}, so on-hand is now ${onHand - 1}. Check the count.`
    )
  }

  async function returnItem(issue) {
    const stock = stockByItem[issue.item_id]
    const [updated] = await sb.update('hr_uniform_issues', { id: issue.id }, { status: 'returned', resolved_date: todayStr() })
    const [stockRow] = await sb.upsert(
      'hr_uniform_stock',
      {
        item_id: issue.item_id,
        company_id: companyId,
        qty_on_hand: (stock?.qty_on_hand ?? 0) + 1,
        min_units: stock?.min_units ?? 0,
        max_units: stock?.max_units ?? 0,
      },
      'item_id'
    )
    onIssuesUpdate(updated)
    onStockChange(stockRow)
    setConfirmMsg(`${itemName(issue.item_id)} returned to stock.`)
  }

  // HR Admin only — cleans up a mistaken entry (wrong item clicked, etc.).
  // If the row being deleted is still "issued" (i.e. it was never actually
  // resolved), the unit goes back into available stock since it was never
  // really taken. Broken/returned rows are closed history — their stock
  // effect already happened — so deleting those is just a display cleanup,
  // no stock change.
  async function deleteIssue(issue) {
    if (issue.status === 'issued') {
      const stock = stockByItem[issue.item_id]
      const [stockRow] = await sb.upsert(
        'hr_uniform_stock',
        {
          item_id: issue.item_id,
          company_id: companyId,
          qty_on_hand: (stock?.qty_on_hand ?? 0) + 1,
          min_units: stock?.min_units ?? 0,
          max_units: stock?.max_units ?? 0,
        },
        'item_id'
      )
      onStockChange(stockRow)
    }
    await sb.remove('hr_uniform_issues', { id: issue.id })
    onIssuesRemove(issue.id)
    setConfirmDeleteId(null)
    setConfirmMsg(`Removed ${itemName(issue.item_id)} from ${employee.first_name}'s history.`)
  }

  const content = (
    <>
        {currentByCategory.length > 0 ? (
          <div style={{ ...styles.row, flexWrap: 'wrap', gap: 6, marginTop: 8, marginBottom: 10 }}>
            {currentByCategory.map(([cat, n]) => (
              <span key={cat} style={styles.badge('neutral')}>
                {cat}: {n}
              </span>
            ))}
            <span style={{ ...styles.badge('good'), fontWeight: 700 }}>Total: {totalCurrent}</span>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: colors.muted, marginTop: 8, marginBottom: 10 }}>
            Not currently holding any issued items.
          </div>
        )}
        {canDelete && (
          <div style={{ fontSize: 11, color: colors.muted, marginBottom: 8 }}>
            As HR Admin you can delete a row here to clean up a mistaken entry — deleting a still-issued
            item puts it back in available stock; deleting a closed (broken/returned) row is just cleanup.
          </div>
        )}
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Issued</th>
              <th style={styles.th}>Resolved</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {empIssues.map((i) => (
              <tr key={i.id}>
                <td style={styles.td}>{itemName(i.item_id)}</td>
                <td style={styles.td}>
                  <span style={styles.badge(i.status === 'issued' ? 'good' : i.status === 'broken' ? 'bad' : 'neutral')}>
                    {i.status}
                  </span>
                </td>
                <td style={styles.td}>{i.issued_date}</td>
                <td style={styles.td}>{i.resolved_date || '—'}</td>
                <td style={styles.td}>
                  <div style={{ ...styles.row, gap: 4, flexWrap: 'wrap' }}>
                    {i.status === 'issued' && (
                      <>
                        <button style={styles.buttonGhost} onClick={() => markBroken(i)}>
                          Mark broken
                        </button>
                        <button style={styles.buttonDanger} onClick={() => returnItem(i)}>
                          Return
                        </button>
                      </>
                    )}
                    {i.status === 'broken' &&
                      (replacedIssueIds.has(i.id) ? (
                        <span style={{ fontSize: 11, color: colors.muted }}>replacement issued</span>
                      ) : (
                        <button style={styles.buttonGhost} onClick={() => replaceItem(i)}>
                          Issue replacement
                        </button>
                      ))}
                    {canDelete &&
                      (confirmDeleteId === i.id ? (
                        <>
                          <button style={styles.buttonDanger} onClick={() => deleteIssue(i)}>
                            Confirm delete?
                          </button>
                          <button style={styles.buttonGhost} onClick={() => setConfirmDeleteId(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button style={styles.buttonGhost} onClick={() => setConfirmDeleteId(i.id)}>
                          Delete
                        </button>
                      ))}
                  </div>
                </td>
              </tr>
            ))}
            {empIssues.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={5}>
                  Nothing issued to this employee yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      {confirmMsg && <ConfirmPopup message={confirmMsg} onClose={() => setConfirmMsg(null)} />}
    </>
  )
  // Embedded (2026-09-27): rendered inside the employee drawer's Uniforms
  // tab — no overlay, no header; the drawer supplies both.
  if (embedded) return content
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{ ...styles.card, maxWidth: 600, width: '100%', maxHeight: '85vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ ...styles.row, justifyContent: 'space-between' }}>
          <div style={styles.cardTitle}>
            {employee.first_name} {employee.last_name} — uniform items
          </div>
          <button style={styles.buttonGhost} onClick={onClose}>
            Close
          </button>
        </div>
        {content}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Licences & qualifications per employee (#484). One row per document: what
// it is, its class, when it expires, and the scan. Deleting removes the file
// too. Anything with a future expiry shows up on the Dashboard card once it
// is within 60 days; the Ops vehicle log reads the driver's-licence rows.
// ---------------------------------------------------------------------------
function EmployeeQualificationsModal({ companyId, employee, rows, onClose, onAdd, onRemove, embedded = false }) {
  const blank = { kind: 'drivers_licence', category: 'B', title: '', doc_number: '', issued_on: '', expires_on: '', note: '' }
  const [form, setForm] = useState(blank)
  const [file, setFile] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmId, setConfirmId] = useState(null)
  const kindDef = QUALIFICATION_KINDS.find((k) => k.id === form.kind)

  async function save(e) {
    e.preventDefault()
    setError('')
    if (form.expires_on && form.issued_on && form.expires_on < form.issued_on) { setError('Expiry is before the issue date.'); return }
    setSaving(true)
    let storagePath = null
    try {
      if (file) storagePath = await uploadQualificationFile({ supabase, companyId, file })
      const { data: { user } } = await supabase.auth.getUser()
      const [row] = await sb.insert('hr_qualifications', {
        company_id: companyId,
        employee_id: employee.id,
        kind: form.kind,
        category: kindDef?.hasClass ? form.category || null : null,
        title: form.title.trim() || null,
        doc_number: form.doc_number.trim() || null,
        issued_on: form.issued_on || null,
        expires_on: form.expires_on || null,
        storage_path: storagePath,
        note: form.note.trim() || null,
        created_by: user?.id || null,
      })
      onAdd(row)
      setForm(blank)
      setFile(null)
    } catch (err) {
      // The row failed after the file went up: take the file down again so
      // the bucket does not collect orphans.
      if (storagePath) await removeQualificationFile({ supabase, storagePath }).catch(() => {})
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function remove(q) {
    setError('')
    try {
      await sb.remove('hr_qualifications', { id: q.id })
      if (q.storage_path) await removeQualificationFile({ supabase, storagePath: q.storage_path }).catch(() => {})
      onRemove(q.id)
    } catch (err) {
      setError(err.message)
    }
    setConfirmId(null)
  }

  async function open(q) {
    try {
      const url = await qualificationFileUrl({ supabase, storagePath: q.storage_path })
      window.open(url, '_blank', 'noopener')
    } catch (err) {
      setError(`Could not open the document: ${err.message}`)
    }
  }

  const sorted = [...rows].sort((a, b) => String(a.expires_on || '9999').localeCompare(String(b.expires_on || '9999')))

  const content = (
    <>

        {error && <div style={{ ...styles.banner, marginTop: 8 }}>{error}</div>}

        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Document</th>
                <th style={styles.th}>Number</th>
                <th style={styles.th}>Issued</th>
                <th style={styles.th}>Expires</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((q) => {
                const st = expiryStatus(q)
                return (
                  <tr key={q.id}>
                    <td style={styles.td}>
                      {describeQualification(q)}
                      {q.note ? <div style={{ fontSize: 11, color: colors.muted, whiteSpace: 'normal' }}>{q.note}</div> : null}
                    </td>
                    <td style={styles.td}>{q.doc_number || '—'}</td>
                    <td style={styles.td}>{q.issued_on || '—'}</td>
                    <td style={styles.td}>{q.expires_on || '—'}</td>
                    <td style={styles.td}>
                      <span style={styles.badge(st === 'expired' ? 'bad' : st === 'ok' || st === 'none' ? 'good' : 'neutral')}>{expiryLabel(q)}</span>
                    </td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>
                      {q.storage_path ? (
                        <button style={styles.buttonGhost} onClick={() => open(q)}>Open</button>
                      ) : (
                        <span style={{ fontSize: 11, color: colors.muted }}>no scan</span>
                      )}{' '}
                      {confirmId === q.id ? (
                        <>
                          <button style={styles.buttonDanger} onClick={() => remove(q)}>Confirm</button>{' '}
                          <button style={styles.buttonGhost} onClick={() => setConfirmId(null)}>Keep</button>
                        </>
                      ) : (
                        <button style={styles.buttonGhost} onClick={() => setConfirmId(q.id)}>Remove</button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {sorted.length === 0 && (
                <tr>
                  <td style={styles.td} colSpan={6}>Nothing on file yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form onSubmit={save} style={{ marginTop: 14 }}>
          <div style={styles.cardTitle}>Add a document</div>
          <div style={styles.formGrid}>
            <div>
              <label style={styles.label}>Type</label>
              <select style={styles.input} value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value, category: e.target.value === 'drivers_licence' ? 'B' : '' }))}>
                {QUALIFICATION_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
            </div>
            {kindDef?.hasClass && (
              <div>
                <label style={styles.label}>{form.kind === 'drivers_licence' ? 'Licence code' : 'Level / class'}</label>
                {form.kind === 'drivers_licence' ? (
                  <select style={styles.input} value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
                    {LICENCE_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <input style={styles.input} value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} placeholder="e.g. Level 1" />
                )}
              </div>
            )}
            <div>
              <label style={styles.label}>Title (optional)</label>
              <input style={styles.input} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder={KIND_LABEL[form.kind]} />
            </div>
            <div>
              <label style={styles.label}>Number</label>
              <input style={styles.input} value={form.doc_number} onChange={(e) => setForm((f) => ({ ...f, doc_number: e.target.value }))} />
            </div>
            <div>
              <label style={styles.label}>Issued on</label>
              <input type="date" style={styles.input} value={form.issued_on} onChange={(e) => setForm((f) => ({ ...f, issued_on: e.target.value }))} />
            </div>
            <div>
              <label style={styles.label}>Expires on (blank = never)</label>
              <input type="date" style={styles.input} value={form.expires_on} onChange={(e) => setForm((f) => ({ ...f, expires_on: e.target.value }))} />
            </div>
            <div>
              <label style={styles.label}>Scan / photo (jpg, png, pdf)</label>
              <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" style={styles.input} onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </div>
            <div>
              <label style={styles.label}>Note</label>
              <input style={styles.input} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
          </div>
          <button type="submit" style={{ ...styles.button, marginTop: 8 }} disabled={saving}>
            {saving ? 'Saving…' : 'Add document'}
          </button>
        </form>
    </>
  )
  if (embedded) return content
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}
    >
      <div style={{ ...styles.card, maxWidth: 680, width: '100%', maxHeight: '85vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...styles.row, justifyContent: 'space-between' }}>
          <div style={styles.cardTitle}>
            {employee.first_name} {employee.last_name} — licences & qualifications
          </div>
          <button style={styles.buttonGhost} onClick={onClose}>Close</button>
        </div>
        {content}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Appraisals (#486) — HR Admin only. One employee at a time: the pack on
// screen, a print-to-PDF of the same pack on a clean white page, position
// requirements editable alongside, and the notes from this conversation
// saved so the next one starts from them.
// ---------------------------------------------------------------------------
function AppraisalsTab({ companyId, companyName, employees, contracts, qualifications, leave, rosteredOffDays, bonuses, shiftPatterns, scheduleLocations = [], guestFeedback = [], feedbackSettings = null, memberReviews = [], reviewQuestions = [] }) {
  const yearAgo = fmtDateOnly(addDays(parseDateOnly(todayStr()), -365))
  const [employeeId, setEmployeeId] = useState('')
  const [from, setFrom] = useState(yearAgo)
  const [to, setTo] = useState(todayStr())
  const [requirements, setRequirements] = useState([])   // hr_position_requirements rows
  const [appraisals, setAppraisals] = useState([])       // hr_appraisals rows
  const [reqForm, setReqForm] = useState({ requirements: '', required_qualifications: '' })
  const [note, setNote] = useState({ appraiser: '', rating: '', strengths: '', development: '', agreed_actions: '', notes: '' })
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    sb.select('hr_position_requirements', { company_id: companyId }, { order: 'position.asc' }).then((r) => setRequirements(r || [])).catch(() => setRequirements([]))
    sb.select('hr_appraisals', { company_id: companyId }, { order: 'appraisal_date.desc' }).then((r) => setAppraisals(r || [])).catch(() => setAppraisals([]))
  }, [companyId])

  const employee = employees.find((e) => e.id === employeeId) || null
  const position = employee?.position?.trim() || ''
  const reqRow = requirements.find((r) => r.position === position) || null
  useEffect(() => {
    setReqForm({ requirements: reqRow?.requirements || '', required_qualifications: reqRow?.required_qualifications || '' })
    setMsg(''); setError('')
  }, [reqRow?.id, employeeId])

  const patternsById = useMemo(() => Object.fromEntries((shiftPatterns || []).map((p) => [p.id, p])), [shiftPatterns])

  const pack = useMemo(() => {
    if (!employee) return null
    return buildAppraisalPack({
      employee,
      contract: currentContract(employee.id, contracts),
      position,
      requirements: reqRow,
      qualifications: qualifications.filter((q) => q.employee_id === employee.id),
      leaveRows: leave,
      offDays: rosteredOffDays,
      bonuses,
      previousAppraisals: appraisals,
      patternText: describePattern(patternFor(employee, patternsById)),
      from, to, asOf: todayStr(),
      // Guest feedback (#487): the DEPARTMENT's trend at the lodges this
      // person was rostered at — context for the conversation, not a score
      // against them. Empty until the company maps a category to their
      // department on the Guest Feedback tab.
      feedbackTrend: departmentTrend({ feedback: guestFeedback, categoryDepartments: feedbackSettings?.category_departments || {}, department: employee.department, employeeId: employee.id, scheduleLocations, from, to }),
      // Member reviews (#519): this person's own averages (from 3 reviews)
      // next to the department's. Comments stay on the Guest Feedback tab.
      memberFeedback: memberFeedback({ reviews: memberReviews, questions: reviewQuestions, employeeId: employee.id, department: employee.department, employees, from, to }),
    })
  }, [employee, contracts, position, reqRow, qualifications, leave, rosteredOffDays, bonuses, appraisals, patternsById, from, to, guestFeedback, feedbackSettings, scheduleLocations, memberReviews, reviewQuestions, employees])

  async function saveRequirements(e) {
    e.preventDefault()
    if (!position) return
    setSaving(true); setError('')
    try {
      const [row] = await sb.upsert('hr_position_requirements', { company_id: companyId, position, requirements: reqForm.requirements.trim() || null, required_qualifications: reqForm.required_qualifications.trim() || null, updated_at: new Date().toISOString() }, 'company_id,position')
      setRequirements((prev) => [...prev.filter((r) => r.position !== position), row])
      setMsg(`Requirements for "${position}" saved — they apply to everyone in that position.`)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  async function saveAppraisal(e) {
    e.preventDefault()
    if (!employee) return
    setSaving(true); setError('')
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const [row] = await sb.insert('hr_appraisals', {
        company_id: companyId, employee_id: employee.id, appraisal_date: todayStr(), period_from: from, period_to: to,
        appraiser: note.appraiser.trim() || null, rating: note.rating.trim() || null,
        strengths: note.strengths.trim() || null, development: note.development.trim() || null,
        agreed_actions: note.agreed_actions.trim() || null, notes: note.notes.trim() || null, created_by: user?.id || null,
      })
      setAppraisals((prev) => [row, ...prev])
      setNote({ appraiser: note.appraiser, rating: '', strengths: '', development: '', agreed_actions: '', notes: '' })
      setMsg('Appraisal saved. It will show under "Previous appraisals" next time.')
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  function printPack() {
    if (!pack) return
    const w = window.open('', '_blank', 'noopener,width=900,height=1000')
    if (!w) { setError('The browser blocked the print window — allow pop-ups for this site.'); return }
    w.document.write(appraisalHtml(pack, { companyName, preparedBy: note.appraiser }))
    w.document.close()
    w.focus()
    setTimeout(() => w.print(), 300)
  }

  const Check = ({ ok }) => <span style={styles.badge(ok ? 'good' : 'bad')}>{ok ? '✓' : '✗'}</span>

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Appraisal pack</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Everything worth having in front of you for the conversation — contract, what the position asks against what they hold,
          leave and sick record, working pattern, bonuses, and last time's notes. HR Admin only: it contains sick-leave records.
          "Download" prints the same pack to PDF on a white page.
        </div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Employee</label>
            <select style={styles.input} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Pick an employee…</option>
              {[...employees].sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`)).map((e) => (
                <option key={e.id} value={e.id}>{e.first_name} {e.last_name}{e.position ? ` — ${e.position}` : ''}</option>
              ))}
            </select>
          </div>
          <div><label style={styles.label}>Period from</label><input type="date" style={styles.input} value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><label style={styles.label}>Period to</label><input type="date" style={styles.input} value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div style={{ alignSelf: 'end' }}>
            <button style={styles.button} onClick={printPack} disabled={!pack}>Download / print pack</button>
          </div>
        </div>
        {msg && <div style={{ ...styles.banner, marginTop: 8 }}>{msg}</div>}
        {error && <div style={{ ...styles.banner, marginTop: 8, color: colors.danger }}>{error}</div>}
      </div>

      {employee && pack && (
        <>
          <div style={styles.card}>
            <div style={styles.cardTitle}>{pack.name} — person and contract</div>
            <table style={styles.table}><tbody>
              {pack.person.map(([k, v]) => <tr key={k}><td style={{ ...styles.td, color: colors.muted, width: 200 }}>{k}</td><td style={styles.td}>{v}</td></tr>)}
            </tbody></table>
          </div>

          <div style={styles.card}>
            <div style={styles.cardTitle}>Position requirements — {position || 'no position set'}</div>
            {position ? (
              <form onSubmit={saveRequirements}>
                <div style={styles.formGrid}>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={styles.label}>What the position asks (one per line)</label>
                    <textarea style={{ ...styles.input, minHeight: 90, fontFamily: 'inherit' }} value={reqForm.requirements} onChange={(e) => setReqForm((f) => ({ ...f, requirements: e.target.value }))} placeholder={'e.g.\nGuides morning and afternoon drives\nFGASA Level 1\nFirst aid current'} />
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={styles.label}>Qualifications the app should tick off — comma-separated: drivers_licence:EC, pdp, first_aid, fgasa:1, firearm</label>
                    <input style={styles.input} value={reqForm.required_qualifications} onChange={(e) => setReqForm((f) => ({ ...f, required_qualifications: e.target.value }))} placeholder="drivers_licence:B, first_aid" />
                  </div>
                </div>
                <button type="submit" style={{ ...styles.button, marginTop: 8 }} disabled={saving}>Save requirements for "{position}"</button>
              </form>
            ) : (
              <div style={{ fontSize: 12, color: colors.muted }}>Set a position on the employee first (Employees tab), then the requirements can be written for it.</div>
            )}
            {pack.checks.length > 0 && (
              <table style={{ ...styles.table, marginTop: 10 }}><tbody>
                {pack.checks.map((c) => <tr key={c.label}><td style={{ ...styles.td, width: 260 }}>{c.label}</td><td style={styles.td}><Check ok={c.met} /> {c.detail}</td></tr>)}
              </tbody></table>
            )}
          </div>

          <div style={styles.card}>
            <div style={styles.cardTitle}>Leave in the period</div>
            {Object.keys(pack.leave.byType).length === 0 ? <div style={{ fontSize: 12, color: colors.muted }}>No leave taken.</div> : (
              <div style={{ ...styles.row, gap: 16, flexWrap: 'wrap' }}>
                {Object.entries(pack.leave.byType).map(([t, d]) => (
                  <div key={t}>
                    <div style={{ fontSize: 20, fontFamily: fonts.mono, color: colors.goldLt }}>{d}</div>
                    <div style={{ fontSize: 11, color: colors.muted }}>{LEAVE_TYPE_LABELS[t] || t}{t === 'sick' ? ` · ${pack.leave.sickEpisodes} episode${pack.leave.sickEpisodes === 1 ? '' : 's'}` : ''}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ fontSize: 12, marginTop: 8 }}>Pattern: {pack.pattern}{pack.extraOffDays.length ? ` · extra off days: ${pack.extraOffDays.map((d) => d.date).join(', ')}` : ''}</div>
            {pack.bonuses.length > 0 && <div style={{ fontSize: 12, marginTop: 4 }}>Bonuses: {pack.bonuses.map((b) => `${b.date} R ${fmt(b.amount)}${b.type ? ` (${b.type})` : ''}`).join(' · ')}</div>}
          </div>

          <div style={styles.card}>
            <div style={styles.cardTitle}>Licences & qualifications</div>
            {pack.qualifications.length === 0 ? <div style={{ fontSize: 12, color: colors.muted }}>Nothing on file — add them under Employees → Licences.</div> : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {pack.qualifications.map((q, i) => <li key={i}>{q.label} — <span style={{ color: q.expired ? colors.danger : colors.muted }}>{q.expired ? 'EXPIRED ' : 'expires '}{q.expires}</span></li>)}
              </ul>
            )}
          </div>

          {pack.feedbackTrend && pack.feedbackTrend.categories.length > 0 && (
            <div style={styles.card}>
              <div style={styles.cardTitle}>Guest feedback — {employee.department} trend ({pack.feedbackTrend.categories.join(', ')})</div>
              <div style={{ fontSize: 11, color: colors.muted, marginBottom: 6 }}>
                Average guest score for the department at the lodges where {employee.first_name} was rostered. A department's week, not a person's score.
              </div>
              {pack.feedbackTrend.months.length === 0 ? <div style={{ fontSize: 12, color: colors.muted }}>No feedback in the period.</div> : (
                <div style={{ ...styles.row, gap: 14, flexWrap: 'wrap' }}>
                  {pack.feedbackTrend.months.map((m) => (
                    <div key={m.month}><div style={{ fontSize: 18, fontFamily: fonts.mono, color: colors.goldLt }}>{m.avg}</div><div style={{ fontSize: 11, color: colors.muted }}>{m.month} · {m.n} answers</div></div>
                  ))}
                </div>
              )}
            </div>
          )}

          {pack.memberFeedback && (
            <div style={styles.card}>
              <div style={styles.cardTitle}>Member reviews of visits</div>
              <div style={{ fontSize: 11, color: colors.muted, marginBottom: 6 }}>
                {pack.memberFeedback.employee.shown
                  ? `${employee.first_name}: ${pack.memberFeedback.employee.n} reviews in the period, next to the ${employee.department || 'department'} average (${pack.memberFeedback.department.n}).`
                  : `${employee.first_name} has ${pack.memberFeedback.employee.n} review${pack.memberFeedback.employee.n === 1 ? '' : 's'} in the period — a personal figure shows from ${pack.memberFeedback.minCount}. Department average shown for context.`}
              </div>
              <table style={styles.table}>
                <thead><tr><th style={styles.th}>Question</th><th style={styles.th}>{employee.first_name}</th><th style={styles.th}>{employee.department || 'Department'}</th></tr></thead>
                <tbody>
                  {pack.memberFeedback.questions.map((q) => (
                    <tr key={q.key}><td style={styles.td}>{q.label}</td><td style={{ ...styles.td, fontFamily: fonts.mono, color: colors.goldLt }}>{pack.memberFeedback.employee.shown ? (pack.memberFeedback.employee.avg[q.key] ?? '—') : '·'}</td><td style={{ ...styles.td, fontFamily: fonts.mono }}>{pack.memberFeedback.department.avg[q.key] ?? '—'}</td></tr>
                  ))}
                  <tr><td style={{ ...styles.td, fontWeight: 600 }}>Overall</td><td style={{ ...styles.td, fontFamily: fonts.mono, color: colors.goldLt, fontWeight: 600 }}>{pack.memberFeedback.employee.shown ? (pack.memberFeedback.employee.overall ?? '—') : '·'}</td><td style={{ ...styles.td, fontFamily: fonts.mono, fontWeight: 600 }}>{pack.memberFeedback.department.overall ?? '—'}</td></tr>
                </tbody>
              </table>
              {pack.memberFeedback.months.length > 0 && (
                <div style={{ ...styles.row, gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
                  {pack.memberFeedback.months.map((m) => (
                    <div key={m.month}><div style={{ fontSize: 18, fontFamily: fonts.mono, color: colors.goldLt }}>{m.avg}</div><div style={{ fontSize: 11, color: colors.muted }}>{m.month} · {m.n} review{m.n === 1 ? '' : 's'}</div></div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={styles.card}>
            <div style={styles.cardTitle}>Previous appraisals</div>
            {pack.previous.length === 0 ? <div style={{ fontSize: 12, color: colors.muted }}>First appraisal on record.</div> : pack.previous.map((a) => (
              <div key={a.id} style={{ fontSize: 13, marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${colors.border}` }}>
                <strong>{a.appraisal_date}</strong>{a.appraiser ? ` — ${a.appraiser}` : ''}{a.rating ? ` — ${a.rating}` : ''}
                {a.strengths && <div><span style={{ color: colors.muted }}>Strengths:</span> {a.strengths}</div>}
                {a.development && <div><span style={{ color: colors.muted }}>Development:</span> {a.development}</div>}
                {a.agreed_actions && <div><span style={{ color: colors.muted }}>Agreed:</span> {a.agreed_actions}</div>}
                {a.notes && <div><span style={{ color: colors.muted }}>Notes:</span> {a.notes}</div>}
              </div>
            ))}
          </div>

          <div style={styles.card}>
            <div style={styles.cardTitle}>This conversation</div>
            <form onSubmit={saveAppraisal}>
              <div style={styles.formGrid}>
                <div><label style={styles.label}>Appraiser</label><input style={styles.input} value={note.appraiser} onChange={(e) => setNote((n) => ({ ...n, appraiser: e.target.value }))} /></div>
                <div><label style={styles.label}>Rating (your scale)</label><input style={styles.input} value={note.rating} onChange={(e) => setNote((n) => ({ ...n, rating: e.target.value }))} placeholder="e.g. meets / exceeds / 4 of 5" /></div>
                <div style={{ gridColumn: '1 / -1' }}><label style={styles.label}>Strengths</label><textarea style={{ ...styles.input, minHeight: 60, fontFamily: 'inherit' }} value={note.strengths} onChange={(e) => setNote((n) => ({ ...n, strengths: e.target.value }))} /></div>
                <div style={{ gridColumn: '1 / -1' }}><label style={styles.label}>Development</label><textarea style={{ ...styles.input, minHeight: 60, fontFamily: 'inherit' }} value={note.development} onChange={(e) => setNote((n) => ({ ...n, development: e.target.value }))} /></div>
                <div style={{ gridColumn: '1 / -1' }}><label style={styles.label}>Agreed actions</label><textarea style={{ ...styles.input, minHeight: 60, fontFamily: 'inherit' }} value={note.agreed_actions} onChange={(e) => setNote((n) => ({ ...n, agreed_actions: e.target.value }))} /></div>
                <div style={{ gridColumn: '1 / -1' }}><label style={styles.label}>Notes</label><input style={styles.input} value={note.notes} onChange={(e) => setNote((n) => ({ ...n, notes: e.target.value }))} /></div>
              </div>
              <button type="submit" style={{ ...styles.button, marginTop: 8 }} disabled={saving}>Save appraisal</button>
            </form>
          </div>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Guest feedback (#487). The feed is GuestRevu's Partner API since #527
// (2026-09-28: GuestRevu sent the docs — the 2026-09-27 "no API" finding was
// wrong); the CSV export import stays as a fallback. Either way: per lodge
// per week, the department scores, with who was rostered that week
// alongside — as context. Nothing here scores a person.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// MEMBER REVIEWS (#519) — LL members rate each staff visit to their plot in
// the member portal. Shown only for a company that has any questions (i.e.
// member billing). Per-employee averages from MEMBER_REVIEW_MIN_COUNT
// reviews; the members' comments in full (they never print in the pack);
// and the question list itself, which HR can rename, add to or retire.
// ---------------------------------------------------------------------------
function MemberReviewsPanel({ companyId, employees, reviews, questions, setQuestions, canEdit }) {
  const [from, setFrom] = useState(`${todayStr().slice(0, 4)}-01-01`)
  const [to, setTo] = useState(todayStr())
  const [editing, setEditing] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!questions.length && !reviews.length) return null

  const active = questions.filter((q) => q.active !== false).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  const rated = Array.from(new Set(reviews.filter((r) => r.visit_date >= from && r.visit_date <= to).map((r) => r.employee_id)))
    .map((id) => employees.find((e) => e.id === id)).filter(Boolean)
    .sort((a, b) => `${a.department || ''} ${a.first_name}`.localeCompare(`${b.department || ''} ${b.first_name}`))
  const rows = rated.map((e) => ({ e, f: memberFeedback({ reviews, questions, employeeId: e.id, department: e.department, employees, from, to }) }))
  const allIn = reviews.filter((r) => r.visit_date >= from && r.visit_date <= to)
  const allAvg = (key) => { const v = allIn.map((r) => Number(r.scores?.[key])).filter((x) => x >= 1 && x <= 5); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : '—' }
  const allOverall = () => { const v = allIn.map((r) => reviewOverall(r.scores)).filter((x) => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : '—' }
  const comments = allIn.filter((r) => r.comment).sort((a, b) => String(b.visit_date).localeCompare(String(a.visit_date)))
  const empName = (id) => { const e = employees.find((x) => x.id === id); return e ? `${e.first_name} ${e.last_name}` : '—' }

  async function saveQuestion(q, patch) {
    setBusy(true); setError('')
    try {
      await sb.update('member_review_questions', { id: q.id, company_id: companyId }, patch)
      setQuestions((qs) => qs.map((x) => (x.id === q.id ? { ...x, ...patch } : x)))
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  async function addQuestion() {
    const label = newLabel.trim()
    if (!label) return
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `q_${Date.now()}`
    if (questions.some((q) => q.key === key)) { setError('A question with that name already exists (maybe retired — restore it instead).'); return }
    setBusy(true); setError('')
    try {
      const rows = await sb.insert('member_review_questions', [{ company_id: companyId, key, label, sort_order: (Math.max(0, ...questions.map((q) => q.sort_order || 0)) + 1), active: true }])
      setQuestions((qs) => [...qs, ...(rows || [])]); setNewLabel('')
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <div style={styles.card}>
      <div style={{ ...styles.row, justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div style={styles.cardTitle}>Member reviews of staff visits</div>
        <div style={{ ...styles.row, gap: 8, alignItems: 'center' }}>
          <input type="date" style={{ ...styles.input, width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} />
          <span style={{ color: colors.muted }}>to</span>
          <input type="date" style={{ ...styles.input, width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} />
          {canEdit && <button style={styles.buttonGhost} onClick={() => setEditing((x) => !x)}>{editing ? 'Done' : 'Edit questions'}</button>}
        </div>
      </div>
      <div style={{ fontSize: 12, color: colors.muted, margin: '4px 0 8px', lineHeight: 1.5 }}>
        Members rate each completed visit to their plot in the member portal, 1–5 per question. A personal average appears from {MEMBER_REVIEW_MIN_COUNT} reviews in the period; under that only the count shows. The same figures go into the appraisal pack — the comments below do not.
      </div>
      {error && <div style={{ color: colors.danger, fontSize: 12, marginBottom: 6 }}>{error}</div>}

      {editing && (
        <div style={{ ...styles.card, marginBottom: 10 }}>
          <div style={styles.cardTitle}>Questions members answer</div>
          {questions.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map((q) => (
            <div key={q.id} style={{ ...styles.row, gap: 8, alignItems: 'center', padding: '4px 0', opacity: q.active === false ? 0.55 : 1 }}>
              <input style={{ ...styles.input, flex: 1 }} defaultValue={q.label} disabled={busy || q.active === false} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== q.label) saveQuestion(q, { label: v }) }} />
              <span style={{ fontSize: 11, color: colors.muted, minWidth: 90 }}>{q.active === false ? 'retired' : `key: ${q.key}`}</span>
              <button style={styles.buttonGhost} disabled={busy} onClick={() => saveQuestion(q, { active: q.active === false })}>{q.active === false ? 'Restore' : 'Retire'}</button>
            </div>
          ))}
          <div style={{ ...styles.row, gap: 8, alignItems: 'center', marginTop: 6 }}>
            <input style={{ ...styles.input, flex: 1 }} placeholder="New question, e.g. Left the place tidy" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addQuestion() }} />
            <button style={styles.buttonGhost} disabled={busy || !newLabel.trim()} onClick={addQuestion}>Add question</button>
          </div>
          <div style={{ fontSize: 11, color: colors.muted, marginTop: 6 }}>Retiring a question keeps its old answers; members simply stop being asked it. Renaming keeps the history under the same key.</div>
        </div>
      )}

      {rows.length === 0 ? <div style={{ fontSize: 12, color: colors.muted }}>No reviews in this period.</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={styles.table}>
            <thead><tr><th style={styles.th}>Employee</th><th style={styles.th}>Department</th><th style={styles.th}>Reviews</th>{active.map((q) => <th key={q.key} style={styles.th}>{q.label}</th>)}<th style={styles.th}>Overall</th></tr></thead>
            <tbody>
              {rows.map(({ e, f }) => (
                <tr key={e.id}>
                  <td style={styles.td}>{e.first_name} {e.last_name}</td><td style={styles.td}>{e.department || '—'}</td><td style={styles.td}>{f.employee.n}</td>
                  {active.map((q) => <td key={q.key} style={{ ...styles.td, fontFamily: fonts.mono }}>{f.employee.shown ? (f.employee.avg[q.key] ?? '—') : <span style={{ color: colors.muted }}>·</span>}</td>)}
                  <td style={{ ...styles.td, fontFamily: fonts.mono, color: colors.goldLt }}>{f.employee.shown ? (f.employee.overall ?? '—') : <span style={{ color: colors.muted, fontFamily: 'inherit' }}>fewer than {MEMBER_REVIEW_MIN_COUNT}</span>}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 600 }}>
                <td style={styles.td}>All staff</td><td style={styles.td}></td><td style={styles.td}>{allIn.length}</td>
                {active.map((q) => <td key={q.key} style={{ ...styles.td, fontFamily: fonts.mono }}>{allAvg(q.key)}</td>)}
                <td style={{ ...styles.td, fontFamily: fonts.mono, color: colors.goldLt }}>{allOverall()}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {comments.length > 0 && (
        <>
          <div style={{ ...styles.cardTitle, marginTop: 12 }}>What members wrote</div>
          <table style={styles.table}>
            <thead><tr><th style={styles.th}>Visit</th><th style={styles.th}>Employee</th><th style={styles.th}>Rating</th><th style={styles.th}>Comment</th></tr></thead>
            <tbody>
              {comments.map((r) => (
                <tr key={r.id}><td style={styles.td}>{r.visit_date}</td><td style={styles.td}>{empName(r.employee_id)}</td><td style={{ ...styles.td, fontFamily: fonts.mono }}>{reviewOverall(r.scores) ?? '—'}</td><td style={{ ...styles.td, whiteSpace: 'normal' }}>{r.comment}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// GUESTREVU API FEED (#527, 2026-09-28). GuestRevu's Partner API replaces the
// CSV export as the feed into guest_feedback. The Edge Function
// guestrevu-sync (Finance repo, supabase/guestrevu-sync.ts) does the pull;
// this panel holds what a person decides: which GuestRevu property is which
// lodge, a write-nothing test, a manual run, a one-off full history pull,
// and the nightly schedule switch. Credentials live in Supabase secrets.
// ---------------------------------------------------------------------------
function GuestRevuSyncPanel({ companyId, settings, setSettings, canRun }) {
  const [accounts, setAccounts] = useState({})   // account_id → lodge code
  const [newId, setNewId] = useState('')
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [log, setLog] = useState([])
  const [schedule, setSchedule] = useState(null)   // scheduled_syncs row or null

  useEffect(() => { setAccounts(settings?.guestrevu_accounts || {}) }, [settings?.company_id, settings?.guestrevu_accounts])
  const loadStatus = async () => {
    const rows = await sb.select('guest_feedback_sync_log', { company_id: companyId }, { order: 'started_at.desc', limit: 5 }).catch(() => [])
    setLog(rows || [])
    const sched = await sb.select('scheduled_syncs', { company_id: companyId, job: 'guestrevu' }, {}).catch(() => [])
    setSchedule(sched?.[0] || null)
  }
  useEffect(() => { loadStatus() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [companyId])

  async function saveAccounts(next) {
    setAccounts(next)
    await sb.upsert('guest_feedback_settings', { company_id: companyId, column_map: settings?.column_map || {}, category_departments: settings?.category_departments || {}, location_aliases: settings?.location_aliases || {}, guestrevu_accounts: next, updated_at: new Date().toISOString() }, 'company_id')
    setSettings({ ...(settings || { company_id: companyId, column_map: {}, category_departments: {}, location_aliases: {} }), guestrevu_accounts: next })
  }
  async function call(action, extra = {}) {
    setBusy(action); setError(''); setResult(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${SUPABASE_URL}/functions/v1/guestrevu-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ companyId, action, ...extra }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `guestrevu-sync failed (${res.status})`)
      setResult({ action, ...body })
      await loadStatus()
    } catch (e) { setError(e.message) } finally { setBusy('') }
  }
  async function toggleSchedule() {
    setError('')
    try {
      if (schedule) await sb.update('scheduled_syncs', { id: schedule.id, company_id: companyId }, { enabled: !schedule.enabled })
      else await sb.insert('scheduled_syncs', [{ company_id: companyId, job: 'guestrevu', enabled: true, note: 'Enabled from the HR Guest Feedback tab' }])
      await loadStatus()
    } catch (e) { setError(e.message) }
  }

  const last = log[0]
  const ids = Object.keys(accounts)
  const fmt = (ts) => (ts ? new Date(ts).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')

  return (
    <div style={styles.card}>
      <div style={{ ...styles.row, justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div style={styles.cardTitle}>GuestRevu feed (API)</div>
        <div style={{ fontSize: 12, color: colors.muted }}>
          {last ? <>Last run {fmt(last.started_at)} · {last.triggered_by} · {last.reviews_written} written{last.error ? <span style={{ color: colors.danger }}> · failed: {last.error}</span> : last.completed ? ' · up to date' : ' · more to fetch'}</> : 'Never run'}
          {' · '}nightly {schedule?.enabled ? <strong style={{ color: colors.ok }}>on</strong> : <strong>off</strong>}
          {canRun && <button style={{ ...styles.buttonGhost, marginLeft: 8 }} onClick={toggleSchedule}>{schedule?.enabled ? 'Pause nightly' : 'Enable nightly'}</button>}
        </div>
      </div>
      <div style={{ fontSize: 12, color: colors.muted, margin: '4px 0 10px', lineHeight: 1.5 }}>
        Reviews come straight from GuestRevu into the table below — same categories, same department mapping, same appraisal pack. Each GuestRevu property has an <em>account id</em> (the property ID in GuestRevu); tell me which lodge it is. Credentials are Supabase secrets, not typed here.
      </div>

      <div style={styles.formGrid}>
        {ids.map((id) => (
          <div key={id} style={{ ...styles.row, gap: 8, alignItems: 'end' }}>
            <div style={{ flex: 1 }}>
              <label style={styles.label}>GuestRevu property {id} is</label>
              <select style={styles.input} value={accounts[id] || ''} disabled={!canRun} onChange={(e) => saveAccounts({ ...accounts, [id]: e.target.value })}>
                <option value="">— unassigned (imports with no lodge) —</option>
                {LOCATIONS.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.id})</option>)}
              </select>
            </div>
            {canRun && <button style={styles.buttonGhost} onClick={() => { const n = { ...accounts }; delete n[id]; saveAccounts(n) }}>Remove</button>}
          </div>
        ))}
        {canRun && (
          <div>
            <label style={styles.label}>Add a GuestRevu property id</label>
            <div style={{ ...styles.row, gap: 8 }}>
              <input style={styles.input} inputMode="numeric" placeholder="e.g. 1001" value={newId} onChange={(e) => setNewId(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter' && newId) { saveAccounts({ ...accounts, [newId]: '' }); setNewId('') } }} />
              <button style={styles.buttonGhost} disabled={!newId} onClick={() => { saveAccounts({ ...accounts, [newId]: '' }); setNewId('') }}>Add</button>
            </div>
          </div>
        )}
      </div>

      {canRun && (
        <div style={{ ...styles.row, gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button style={styles.buttonGhost} disabled={!!busy || ids.length === 0} onClick={() => call('test')}>{busy === 'test' ? 'Testing…' : 'Test connection (writes nothing)'}</button>
          <button style={styles.button} disabled={!!busy || ids.length === 0} onClick={() => call('sync')}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>
          <button style={styles.buttonGhost} disabled={!!busy || ids.length === 0} onClick={() => { if (window.confirm('Pull the complete review history from GuestRevu? Existing rows are updated, not duplicated. This can take a few runs for a big account.')) call('sync', { mode: 'full' }) }}>{busy === 'full' ? 'Pulling…' : 'Pull full history'}</button>
        </div>
      )}
      {error && <div style={{ color: colors.danger, fontSize: 12, marginTop: 8 }}>{error}</div>}

      {result && result.action === 'test' && (
        <div style={{ marginTop: 12 }}>
          <div style={styles.cardTitle}>Test result <span style={{ fontWeight: 400, color: colors.muted }}>· {result.base_url} · function {result.revision}</span></div>
          {Object.entries(result.accounts || {}).map(([id, a]) => (
            <div key={id} style={{ fontSize: 12, marginBottom: 10, paddingBottom: 8, borderBottom: `1px solid ${colors.border}` }}>
              <strong>Property {id}</strong> → {a.lodge || <em>no lodge</em>}
              {a.error ? <div style={{ color: colors.danger }}>{a.error}</div> : (
                <>
                  <div>{a.number_reviews} reviews in total · sources: {(a.sources || []).map((s) => `${s.source_name} ${s.number_reviews} (avg ${s.average_review_rating}%)`).join(', ') || '—'}</div>
                  {a.unmapped_questions?.length > 0 && <div style={{ color: colors.gold }}>Questions with no category yet (kept under their own name): {a.unmapped_questions.join(' · ')}</div>}
                  {(a.preview || []).slice(0, 3).map((p, i) => (
                    <div key={i} style={{ color: colors.muted }}>{p.stay_date} · overall {p.overall ?? '—'} · {Object.entries(p.scores || {}).map(([k, v]) => `${k} ${v}`).join(', ')}{p.comment ? ` · "${p.comment.slice(0, 80)}"` : ''}</div>
                  ))}
                </>
              )}
            </div>
          ))}
          <div style={{ fontSize: 11, color: colors.muted }}>Nothing was written. If the lodges and categories look right, press Sync now (or Pull full history once).</div>
        </div>
      )}
      {result && result.action === 'sync' && (
        <div style={{ marginTop: 12, fontSize: 12 }}>
          <strong>{result.reviews_written}</strong> reviews written from {result.reviews_read} read in {result.batches} batch{result.batches === 1 ? '' : 'es'}{result.completed ? ' — up to date.' : ' — more remain; run again or let the nightly job continue.'}
          {result.error && <div style={{ color: colors.danger }}>{result.error}</div>}
          {Object.entries(result.detail || {}).map(([id, d]) => d.unmapped_questions?.length > 0 && <div key={id} style={{ color: colors.gold }}>Property {id}: unmapped questions {d.unmapped_questions.join(' · ')}</div>)}
          <div style={{ color: colors.muted }}>Reload the page to see the new weeks in the trend below.</div>
        </div>
      )}
      {log.length > 1 && (
        <details style={{ marginTop: 10, fontSize: 12 }}>
          <summary style={{ cursor: 'pointer', color: colors.muted }}>Previous runs</summary>
          {log.slice(1).map((r) => <div key={r.id} style={{ color: colors.muted }}>{fmt(r.started_at)} · {r.triggered_by} · {r.mode} · {r.reviews_written} written{r.error ? ` · ${r.error}` : r.completed ? '' : ' · incomplete'}</div>)}
        </details>
      )}
    </div>
  )
}

function GuestFeedbackTab({ companyId, employees, scheduleLocations, feedback, setFeedback, settings, setSettings, memberReviews = [], reviewQuestions = [], setReviewQuestions = () => {}, role }) {
  const [parsed, setParsed] = useState(null)     // { headers, records }
  const [map, setMap] = useState(null)
  const [aliases, setAliases] = useState({})
  const [catDept, setCatDept] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [locFilter, setLocFilter] = useState('')
  const [openWeek, setOpenWeek] = useState(null)

  useEffect(() => {
    setAliases(settings?.location_aliases || {})
    setCatDept(settings?.category_departments || {})
  }, [settings?.company_id])

  const departments = useMemo(() => Array.from(new Set(employees.map((e) => e.department?.trim()).filter(Boolean))).sort(), [employees])
  const knownLocations = LOCATIONS.map((l) => l.id)

  function onFile(e) {
    const f = e.target.files?.[0]
    if (!f) return
    setError(''); setMsg('')
    f.text().then((text) => {
      const p = parseCsv(text)
      if (p.headers.length === 0) { setError('That file has no rows.'); return }
      setParsed(p)
      setMap(settings?.column_map?.stay_date ? { categories: {}, ...settings.column_map } : guessColumnMap(p.headers, p.records))
    })
  }

  const preview = useMemo(() => (parsed && map ? normaliseRows(parsed.records, map, { locationAliases: aliases, knownLocations }) : null), [parsed, map, aliases, knownLocations])

  async function doImport() {
    if (!preview || !map?.stay_date) { setError('Pick the check-out / review date column first.'); return }
    setBusy(true); setError(''); setMsg('')
    try {
      await sb.upsert('guest_feedback_settings', { company_id: companyId, column_map: map, category_departments: catDept, location_aliases: aliases, updated_at: new Date().toISOString() }, 'company_id')
      setSettings({ company_id: companyId, column_map: map, category_departments: catDept, location_aliases: aliases })
      const rows = preview.rows.map((r) => ({ ...r, company_id: companyId, source: 'guestrevu_export' }))
      const withId = rows.filter((r) => r.external_id)
      const without = rows.filter((r) => !r.external_id)
      const saved = []
      for (let i = 0; i < withId.length; i += 200) saved.push(...((await sb.upsert('guest_feedback', withId.slice(i, i + 200), 'company_id,external_id')) || []))
      for (let i = 0; i < without.length; i += 200) saved.push(...((await sb.insert('guest_feedback', without.slice(i, i + 200))) || []))
      const ids = new Set(saved.map((r) => r.id))
      setFeedback((prev) => [...saved, ...prev.filter((r) => !ids.has(r.id))].sort((a, b) => String(b.stay_date).localeCompare(String(a.stay_date))))
      setMsg(`Imported ${saved.length} response${saved.length === 1 ? '' : 's'}${preview.skipped.length ? `; ${preview.skipped.length} skipped (no usable date)` : ''}${without.length ? '. No ID column in this export, so re-importing the same file would duplicate — pick an ID column if the export has one.' : '.'}`)
      setParsed(null); setMap(null)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  async function saveMapping() {
    setBusy(true); setError('')
    try {
      await sb.upsert('guest_feedback_settings', { company_id: companyId, column_map: settings?.column_map || {}, category_departments: catDept, location_aliases: aliases, updated_at: new Date().toISOString() }, 'company_id')
      setSettings({ ...(settings || { company_id: companyId, column_map: {} }), category_departments: catDept, location_aliases: aliases })
      setMsg('Department mapping saved — the appraisal pack uses it.')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const trend = useMemo(() => weeklyTrend(feedback, { locationId: locFilter || null }), [feedback, locFilter])
  const allCats = useMemo(() => Array.from(new Set(feedback.flatMap((f) => Object.keys(f.scores || {})))).sort(), [feedback])
  const tone = (v) => (v == null ? 'neutral' : v >= 8.5 ? 'good' : v < 7 ? 'bad' : 'neutral')
  const fields = [['stay_date', 'Check-out / review date (required)'], ['location', 'Lodge / property'], ['overall', 'Overall score'], ['comment', 'Comment'], ['reviewer', 'Guest / source'], ['id', 'Response ID (prevents duplicates)']]

  return (
    <>
      <MemberReviewsPanel companyId={companyId} employees={employees} reviews={memberReviews} questions={reviewQuestions} setQuestions={setReviewQuestions} canEdit={role === 'admin' || role === 'hradmin'} />
      <GuestRevuSyncPanel companyId={companyId} settings={settings} setSettings={setSettings} canRun={role === 'admin' || role === 'hradmin'} />
      <div style={styles.card}>
        <div style={styles.cardTitle}>Import a GuestRevu export (fallback)</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8, lineHeight: 1.5 }}>
          If the API feed above is not running: in GuestRevu go to <strong>Reviews</strong>, set the date range, click <strong>Export</strong> and pick <strong>.csv</strong>. Drop that file here. The column choices are remembered, so the next export is one click. Rows already brought in by the API are matched on their id and not duplicated.
        </div>
        <input type="file" accept=".csv,text/csv" onChange={onFile} style={styles.input} />
        {parsed && map && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: colors.muted, marginBottom: 6 }}>{parsed.records.length} rows, {parsed.headers.length} columns. Confirm which column is which:</div>
            <div style={styles.formGrid}>
              {fields.map(([k, label]) => (
                <div key={k}>
                  <label style={styles.label}>{label}</label>
                  <select style={styles.input} value={map[k] || ''} onChange={(e) => setMap((m) => ({ ...m, [k]: e.target.value || undefined }))}>
                    <option value="">—</option>
                    {parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div style={{ ...styles.cardTitle, marginTop: 10 }}>Score columns → categories</div>
            <div style={styles.formGrid}>
              {Object.keys(CATEGORY_GUESS).map((cat) => (
                <div key={cat}>
                  <label style={styles.label}>{cat}</label>
                  <select style={styles.input} value={map.categories?.[cat] || ''} onChange={(e) => setMap((m) => ({ ...m, categories: { ...(m.categories || {}), [cat]: e.target.value || undefined } }))}>
                    <option value="">—</option>
                    {parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>
            {preview && preview.unmappedLocations.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={styles.cardTitle}>Lodge names in the file that are not lodge codes</div>
                <div style={styles.formGrid}>
                  {preview.unmappedLocations.map((name) => (
                    <div key={name}>
                      <label style={styles.label}>"{name}" is</label>
                      <select style={styles.input} value={aliases[name] || ''} onChange={(e) => setAliases((a) => ({ ...a, [name]: e.target.value }))}>
                        <option value="">— leave unassigned —</option>
                        {LOCATIONS.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.id})</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {preview && (
              <div style={{ fontSize: 12, marginTop: 8 }}>
                Ready: {preview.rows.length} responses{preview.skipped.length ? `, ${preview.skipped.length} without a usable date` : ''}.
                {preview.rows.length > 0 && ` First: ${preview.rows[0].stay_date} ${preview.rows[0].location_id || '(no lodge)'} overall ${preview.rows[0].overall ?? '—'}, ${Object.keys(preview.rows[0].scores).length} category scores.`}
              </div>
            )}
            <button style={{ ...styles.button, marginTop: 8 }} onClick={doImport} disabled={busy || !map.stay_date}>{busy ? 'Importing…' : 'Import'}</button>
          </div>
        )}
        {msg && <div style={{ ...styles.banner, marginTop: 8 }}>{msg}</div>}
        {error && <div style={{ ...styles.banner, marginTop: 8, color: colors.danger }}>{error}</div>}
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Which department owns which category</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8 }}>Food → the kitchen, cleanliness → housekeeping, activities → guiding. This is what lets the appraisal pack show a department's trend.</div>
        <div style={styles.formGrid}>
          {(allCats.length ? allCats : Object.keys(CATEGORY_GUESS)).map((cat) => (
            <div key={cat}>
              <label style={styles.label}>{cat}</label>
              <select style={styles.input} value={catDept[cat] || ''} onChange={(e) => setCatDept((c) => ({ ...c, [cat]: e.target.value }))}>
                <option value="">— not a department —</option>
                {departments.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          ))}
        </div>
        <button style={{ ...styles.button, marginTop: 8 }} onClick={saveMapping} disabled={busy}>Save mapping</button>
      </div>

      <div style={styles.card}>
        <div style={{ ...styles.row, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={styles.cardTitle}>Scores by week — {feedback.length} response{feedback.length === 1 ? '' : 's'} on file</div>
          <select style={styles.smallInput} value={locFilter} onChange={(e) => setLocFilter(e.target.value)}>
            <option value="">All lodges</option>
            {LOCATIONS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        {trend.length === 0 ? <div style={{ fontSize: 12, color: colors.muted }}>Nothing imported yet.</div> : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Lodge</th><th style={styles.th}>Week of</th><th style={styles.th}>Responses</th><th style={styles.th}>Overall</th>
                  {allCats.map((c) => <th key={c} style={styles.th}>{c}{catDept[c] ? <span style={{ color: colors.muted, fontWeight: 400 }}> · {catDept[c]}</span> : ''}</th>)}
                  <th style={styles.th}></th>
                </tr>
              </thead>
              <tbody>
                {trend.slice(-60).reverse().map((w) => {
                  const key = `${w.location_id}|${w.week}`
                  const roster = openWeek === key ? rosterForWeek(scheduleLocations, employees, { locationId: w.location_id, week: w.week }) : null
                  return (
                    <Fragment key={key}>
                      <tr>
                        <td style={styles.td}>{w.location_id}</td>
                        <td style={styles.td}>{w.week}</td>
                        <td style={styles.td}>{w.responses}</td>
                        <td style={styles.td}><span style={styles.badge(tone(w.overall))}>{w.overall ?? '—'}</span></td>
                        {allCats.map((c) => <td key={c} style={styles.td}>{w.categories[c] ? <span style={styles.badge(tone(w.categories[c].avg))}>{w.categories[c].avg}</span> : <span style={{ color: colors.muted }}>—</span>}</td>)}
                        <td style={styles.td}><button style={styles.buttonGhost} onClick={() => setOpenWeek(openWeek === key ? null : key)}>{openWeek === key ? 'Hide roster' : 'Who was on'}</button></td>
                      </tr>
                      {roster && (
                        <tr>
                          <td style={{ ...styles.td, whiteSpace: 'normal', fontSize: 12 }} colSpan={5 + allCats.length}>
                            {Object.keys(roster).length === 0 ? <span style={{ color: colors.muted }}>Nobody rostered at {w.location_id} that week in the Schedule.</span> : (
                              Object.entries(roster).map(([dept, names]) => <div key={dept}><strong>{dept}:</strong> {names.join(', ')}</div>)
                            )}
                            <div style={{ color: colors.muted, marginTop: 4 }}>Rostered that week — context for the department's score, not a finding about anyone.</div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
