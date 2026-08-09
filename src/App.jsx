import { Fragment, useEffect, useMemo, useState } from 'react'
import { sb, LOCATIONS, UNIFORM_CATEGORIES, LINEN_CATEGORIES, MOVEMENT_REASONS, CONTRACT_TYPES } from './sb.js'
import { colors, fonts } from './theme.js'
import { supabase } from './supabaseClient.js'
import Login from './Login.jsx'
import SetPassword from './SetPassword.jsx'
import ManageUsers from './ManageUsers.jsx'
import { CompanyProvider, useCompany } from './CompanyContext.jsx'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fmt(n, decimals = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return Number(n).toLocaleString('en-ZA', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
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

const CYCLE_ON_DAYS = 21
const CYCLE_OFF_DAYS = 7
const CYCLE_LENGTH = CYCLE_ON_DAYS + CYCLE_OFF_DAYS // 28

// 'YYYY-MM-DD' -> local-midnight Date, avoiding the UTC-parsing footgun of
// `new Date('YYYY-MM-DD')` (which lands on the previous day in any
// timezone behind UTC).
function parseDateOnly(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function fmtDateOnly(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

// Monday of the calendar week containing `date`.
function startOfWeek(date) {
  const day = date.getDay() // 0 = Sun .. 6 = Sat
  const diff = day === 0 ? -6 : 1 - day
  return addDays(date, diff)
}

// { status: 'on' | 'off' | 'none', blockStart? } for a single day.
// blockStart ('YYYY-MM-DD') is only set when status is 'on' — the date the
// current 21-day block started, used as the key for its lodge assignment.
// Works for any date, past or future, relative to the anchor.
function cycleStatusForDate(cycleAnchorDate, date) {
  if (!cycleAnchorDate) return { status: 'none' }
  const anchor = parseDateOnly(cycleAnchorDate)
  const diffDays = Math.round((date - anchor) / 86400000)
  let phase = diffDays % CYCLE_LENGTH
  if (phase < 0) phase += CYCLE_LENGTH
  if (phase < CYCLE_ON_DAYS) {
    return { status: 'on', blockStart: fmtDateOnly(addDays(date, -phase)) }
  }
  return { status: 'off' }
}

// Is `date` covered by any logged leave period for this employee? Leave
// always overrides the calculated on/off status for display purposes.
function leaveOnDate(leaveRows, employeeId, date) {
  const ds = fmtDateOnly(date)
  return leaveRows.find((l) => l.employee_id === employeeId && l.start_date <= ds && l.end_date >= ds) || null
}

// How many days in [startStr, endStr] (inclusive) fall on a day this
// employee was already scheduled to work — used to snapshot the leave
// deduction when it's logged (days that were already off-cycle cost
// nothing, per how you wanted leave to interact with the rotation).
function countWorkingDaysInRange(cycleAnchorDate, startStr, endStr) {
  if (!cycleAnchorDate) return 0
  let count = 0
  let d = parseDateOnly(startStr)
  const end = parseDateOnly(endStr)
  while (d <= end) {
    if (cycleStatusForDate(cycleAnchorDate, d).status === 'on') count++
    d = addDays(d, 1)
  }
  return count
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
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
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
]
const HRADMIN_TABS = [...ADMIN_TABS, { id: 'contracts', label: 'Contracts' }, { id: 'users', label: 'Users' }]

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
  } = useCompany()

  // The app's existing tab-gating logic everywhere checks role === 'admin'
  // or role === 'hradmin' — deriving the same three-value string here means
  // none of that logic below needed to change, only where the value comes
  // from.
  const role = baseRole === 'admin' && isHrAdmin ? 'hradmin' : baseRole

  async function logout() {
    await supabase.auth.signOut()
  }

  const [tab, setTab] = useState('dashboard')
  const [menuOpen, setMenuOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [uniformEmployeeId, setUniformEmployeeId] = useState(null)

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
  const [scheduleLocations, setScheduleLocations] = useState([])
  const [leave, setLeave] = useState([])

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
      ]
      // Contracts hold salary/medical aid/pension — only ever fetched for the
      // HR Admin role, so that data never transits to a Staff/Admin session.
      const results = await Promise.all(
        role === 'hradmin' ? [...base, sb.select('hr_contracts', { company_id: companyId }, {})] : base
      )
      const [empRes, supRes, uItemsRes, uStockRes, uIssuesRes, lItemsRes, lStockRes, lMoveRes, schedLocRes, leaveRes, conRes] =
        results

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
      setContracts(conRes || [])
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
    <div style={styles.app}>
      <style>{`
        .desktop-tab-row { display: flex; }
        .mobile-nav-bar { display: none; }
        @media (max-width: 768px) {
          .desktop-tab-row { display: none; }
          .mobile-nav-bar { display: flex; }
        }
      `}</style>
      <div style={styles.header}>
        <div style={{ ...styles.row, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ ...styles.headerTitle, minWidth: 0, flexShrink: 1 }}>
            <img
              src="/logo.png"
              alt=""
              style={{ ...styles.logo, flexShrink: 0 }}
              onError={(e) => (e.target.style.display = 'none')}
            />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{companyName} — HR & Housekeeping</span>
          </div>
          <div style={{ ...styles.row, flexShrink: 0 }}>
            {availableCompanies.length > 1 && (
              <select
                value={companyId}
                onChange={(e) => switchCompany(e.target.value)}
                style={{ ...styles.smallInput, width: 'auto' }}
              >
                {availableCompanies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <span style={styles.badge('neutral')}>{ROLE_LABELS[role]}</span>
            <button style={{ ...styles.pill(false), padding: '4px 10px' }} onClick={logout}>
              Log out
            </button>
          </div>
        </div>
      </div>

      <nav className="desktop-tab-row" style={styles.desktopTabRow}>
        {TABS.map((t) => (
          <button
            key={t.id}
            style={styles.desktopTab(activeTab === t.id)}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

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
              />
            )}
            {activeTab === 'employees' && (role === 'admin' || role === 'hradmin') && (
              <EmployeesTab
                companyId={companyId}
                employees={employees}
                scheduleLocations={scheduleLocations}
                leave={leave}
                onAdd={addLocalEmployee}
                onUpdate={updateLocalEmployee}
                onRemove={removeLocalEmployee}
                onSelectEmployee={setUniformEmployeeId}
              />
            )}
            {activeTab === 'schedule' && (role === 'admin' || role === 'hradmin') && (
              <ScheduleTab
                companyId={companyId}
                employees={employees}
                scheduleLocations={scheduleLocations}
                leave={leave}
                onUpdateEmployee={updateLocalEmployee}
                onScheduleLocationChange={upsertLocalScheduleLocation}
              />
            )}
            {activeTab === 'leave' && (role === 'admin' || role === 'hradmin') && (
              <LeaveTab
                companyId={companyId}
                employees={employees}
                leave={leave}
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
            {activeTab === 'users' && role === 'hradmin' && <ManageUsers companyId={companyId} />}
          </>
        )}
      </div>

      <div className="mobile-nav-bar" style={styles.navBar}>
        <button style={styles.navMenuButton} onClick={() => setMenuOpen(true)}>
          <span>☰</span>
          <span>{TABS.find((t) => t.id === activeTab)?.label || 'Menu'}</span>
        </button>
      </div>

      {menuOpen && (
        <div className="mobile-nav-bar" style={{ ...styles.navOverlay, display: undefined }} onClick={() => setMenuOpen(false)}>
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

function DashboardTab({ role, uniformItems, uniformStockByItem, uniformIssues, linenItems, linenStock, linenMovements, employees, contracts }) {
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

  const expiringSoon = useMemo(() => {
    if (role !== 'hradmin') return []
    return contracts
      .map((c) => ({ contract: c, days: daysUntil(c.end_date) }))
      .filter((x) => x.contract.end_date && x.days !== null && x.days <= 60)
      .sort((a, b) => a.days - b.days)
  }, [role, contracts])

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

      {role === 'hradmin' && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Contracts expiring within 60 days</div>
          <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Employee</th>
                <th style={styles.th}>Type</th>
                <th style={styles.th}>End date</th>
                <th style={styles.th}>Days left</th>
              </tr>
            </thead>
            <tbody>
              {expiringSoon.map(({ contract, days }) => {
                const emp = employees.find((e) => e.id === contract.employee_id)
                return (
                  <tr key={contract.id}>
                    <td style={styles.td}>{emp ? `${emp.first_name} ${emp.last_name}` : 'Unknown'}</td>
                    <td style={styles.td}>{contract.contract_type}</td>
                    <td style={styles.td}>{contract.end_date}</td>
                    <td style={styles.td}>
                      <span style={styles.badge(days < 14 ? 'bad' : 'neutral')}>{days} days</span>
                    </td>
                  </tr>
                )
              })}
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

function ScheduleTab({ companyId, employees, scheduleLocations, leave, onUpdateEmployee, onScheduleLocationChange }) {
  const today = parseDateOnly(todayStr())
  const [weekStart, setWeekStart] = useState(() => startOfWeek(today))
  const [positionFilter, setPositionFilter] = useState('')

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

  function dayInfo(employee, date) {
    if (leaveOnDate(leave, employee.id, date)) return { status: 'leave' }
    return cycleStatusForDate(employee.cycle_anchor_date, date)
  }

  function positionOf(employee) {
    return employee.position?.trim() || 'No position set'
  }

  async function saveAnchor(employeeId, value) {
    const [row] = await sb.update('hr_employees', { id: employeeId }, { cycle_anchor_date: value || null })
    onUpdateEmployee(row)
  }

  // Keyed by calendar week (Monday) rather than by working block — a lodge
  // can now change week to week within the same 21-day stretch.
  async function saveWeekLocation(employeeId, weekStartStr, locationId) {
    if (!locationId) return
    const [row] = await sb.upsert(
      'hr_schedule_locations',
      { employee_id: employeeId, week_start_date: weekStartStr, location_id: locationId, company_id: companyId },
      'employee_id,week_start_date'
    )
    onScheduleLocationChange(row)
  }

  const positions = useMemo(() => Array.from(new Set(employees.map(positionOf))).sort(), [employees])

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
    const weekKey = fmtDateOnly(w.start)
    const loc = locationByKey[`${e.id}|${weekKey}`]
    return (
      <td style={styles.td} key={weekKey}>
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
            onChange={(ev) => saveWeekLocation(e.id, weekKey, ev.target.value)}
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
      <div style={styles.card}>
        <div style={{ ...styles.row, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={styles.cardTitle}>Weekly schedule</div>
          <div style={{ ...styles.row, gap: 6 }}>
            <button style={styles.buttonGhost} onClick={() => setWeekStart((w) => addDays(w, -WEEKS_SHOWN * 7))}>
              ← Earlier
            </button>
            <button style={styles.buttonGhost} onClick={() => setWeekStart(startOfWeek(today))}>
              Today
            </button>
            <button style={styles.buttonGhost} onClick={() => setWeekStart((w) => addDays(w, WEEKS_SHOWN * 7))}>
              Later →
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Each strip is one week, Mon → Sun, one square per day. Green = working, grey = off, gold =
          on leave. Pick a lodge for any working week and it applies to that whole week — it can be
          changed week to week within the same rotation.
        </div>
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

      <div style={styles.card}>
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
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Cycles</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Set any date that fell on day 1 of an employee's 21-day working block — on/off is
          calculated forward (and backward) from there in 28-day steps, so it doesn't have to be a
          future date. Leave blank for anyone not on the rotation.
        </div>
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Employee</th>
                <th style={styles.th}>Cycle anchor date</th>
                <th style={styles.th}>Today</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => {
                const info = dayInfo(e, today)
                const label =
                  info.status === 'on' ? 'Working' : info.status === 'leave' ? 'On leave' : info.status === 'off' ? 'Off' : 'No cycle set'
                const tone = info.status === 'on' ? 'good' : 'neutral'
                return (
                  <tr key={e.id}>
                    <td style={styles.td}>
                      {e.first_name} {e.last_name}
                    </td>
                    <td style={styles.td}>
                      <input
                        type="date"
                        style={styles.smallInput}
                        defaultValue={e.cycle_anchor_date || ''}
                        onBlur={(ev) => saveAnchor(e.id, ev.target.value)}
                      />
                    </td>
                    <td style={styles.td}>
                      <span style={styles.badge(tone)}>{label}</span>
                    </td>
                  </tr>
                )
              })}
              {employees.length === 0 && (
                <tr>
                  <td style={styles.td} colSpan={3}>
                    No employees yet.
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
// Leave tab — Admin/HR Admin: set each employee's annual leave allowance,
// log leave periods (auto-marks those days unavailable on the Schedule tab
// via leaveOnDate), and see the running balance for whichever year you're
// looking at. Only days that fell on an already-scheduled working day are
// deducted — a leave day that lands on a regular off-cycle week costs
// nothing, since it wasn't going to be worked anyway.
// ---------------------------------------------------------------------------

function LeaveTab({ companyId, employees, leave, onUpdateEmployee, onLeaveAdd, onLeaveRemove }) {
  const [leaveForm, setLeaveForm] = useState({ employee_id: '', start_date: '', end_date: '', note: '' })
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

  const usedByEmployee = useMemo(() => {
    const map = {}
    for (const l of leave) {
      if (Number(l.start_date.slice(0, 4)) !== selectedYear) continue
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

  async function saveAllocation(employeeId, value) {
    const [row] = await sb.update('hr_employees', { id: employeeId }, { annual_leave_days: Number(value) || 0 })
    onUpdateEmployee(row)
  }

  async function logLeave() {
    if (!leaveForm.employee_id || !leaveForm.start_date || !leaveForm.end_date) return
    if (leaveForm.end_date < leaveForm.start_date) return
    setLogging(true)
    const emp = employeeById[leaveForm.employee_id]
    const daysUsed = countWorkingDaysInRange(emp?.cycle_anchor_date, leaveForm.start_date, leaveForm.end_date)
    const [row] = await sb.insert('hr_leave', {
      company_id: companyId,
      employee_id: leaveForm.employee_id,
      start_date: leaveForm.start_date,
      end_date: leaveForm.end_date,
      days_used: daysUsed,
      note: leaveForm.note || null,
    })
    onLeaveAdd(row)
    setLeaveForm({ employee_id: leaveForm.employee_id, start_date: '', end_date: '', note: '' })
    setLogging(false)
  }

  async function deleteLeave(id) {
    await sb.remove('hr_leave', { id })
    onLeaveRemove(id)
    setConfirmDeleteId(null)
  }

  const itemEmployeeName = (id) => {
    const e = employeeById[id]
    return e ? `${e.first_name} ${e.last_name}` : 'Unknown employee'
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
                        type="number"
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
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Employee</th>
                <th style={styles.th}>From</th>
                <th style={styles.th}>To</th>
                <th style={styles.th}>Days used</th>
                <th style={styles.th}>Note</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {yearEntries.map((l) => (
                <tr key={l.id}>
                  <td style={styles.td}>{itemEmployeeName(l.employee_id)}</td>
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
              {yearEntries.length === 0 && (
                <tr>
                  <td style={styles.td} colSpan={6}>
                    No leave logged for {selectedYear} yet.
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
// Employees tab — Admin/HR Admin: master list, one lodge at a time.
// ---------------------------------------------------------------------------

function EmployeesTab({ companyId, employees, scheduleLocations, leave, onAdd, onUpdate, onRemove, onSelectEmployee }) {
  const today = parseDateOnly(todayStr())

  const thisWeekKey = fmtDateOnly(startOfWeek(today))

  const locationByKey = useMemo(() => {
    const map = {}
    for (const s of scheduleLocations) map[`${s.employee_id}|${s.week_start_date}`] = s
    return map
  }, [scheduleLocations])

  function todayInfo(employee) {
    if (leaveOnDate(leave, employee.id, today)) return { status: 'leave' }
    return cycleStatusForDate(employee.cycle_anchor_date, today)
  }

  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    position: '',
    department: '',
    start_date: todayStr(),
    phone: '',
    email: '',
  })
  const [saving, setSaving] = useState(false)
  const [addingPosition, setAddingPosition] = useState(false)
  const [newPositionText, setNewPositionText] = useState('')
  const [addingPositionForId, setAddingPositionForId] = useState(null)
  const [rowNewPositionText, setRowNewPositionText] = useState('')

  // Positions aren't a fixed list — just whatever's already in use on real
  // employees, plus whatever's currently picked (so the dropdown never
  // shows blank right after typing a new one).
  const positionOptions = useMemo(() => {
    const set = new Set()
    for (const e of employees) if (e.position) set.add(e.position)
    if (form.position) set.add(form.position)
    return Array.from(set).sort()
  }, [employees, form.position])

  function confirmNewPosition() {
    const v = newPositionText.trim()
    if (v) setForm((f) => ({ ...f, position: v }))
    setAddingPosition(false)
    setNewPositionText('')
  }

  function confirmRowPosition(employeeId) {
    const v = rowNewPositionText.trim()
    if (v) updateEmployee(employeeId, { position: v })
    setAddingPositionForId(null)
    setRowNewPositionText('')
  }

  async function addEmployee() {
    if (!form.first_name.trim() || !form.last_name.trim()) return
    setSaving(true)
    const [row] = await sb.insert('hr_employees', { ...form, company_id: companyId, status: 'Active' })
    setForm({ first_name: '', last_name: '', position: '', department: '', start_date: todayStr(), phone: '', email: '' })
    setSaving(false)
    onAdd(row)
  }

  async function updateEmployee(id, patch) {
    const [row] = await sb.update('hr_employees', { id }, patch)
    onUpdate(row)
  }

  async function deactivate(id) {
    await sb.update('hr_employees', { id }, { active: false })
    onRemove(id)
  }

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Add employee</div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>First name</label>
            <input style={styles.input} value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Last name</label>
            <input style={styles.input} value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Position</label>
            {addingPosition ? (
              <div style={{ ...styles.row, gap: 4 }}>
                <input
                  autoFocus
                  style={styles.input}
                  placeholder="New position name"
                  value={newPositionText}
                  onChange={(e) => setNewPositionText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      confirmNewPosition()
                    }
                  }}
                />
                <button style={styles.buttonGhost} onClick={confirmNewPosition}>
                  Use
                </button>
                <button
                  style={styles.buttonGhost}
                  onClick={() => {
                    setAddingPosition(false)
                    setNewPositionText('')
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <select
                style={styles.input}
                value={form.position}
                onChange={(e) => {
                  if (e.target.value === '__new__') setAddingPosition(true)
                  else setForm({ ...form, position: e.target.value })
                }}
              >
                <option value="">No position set</option>
                {positionOptions.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
                <option value="__new__">+ Add new position…</option>
              </select>
            )}
          </div>
          <div>
            <label style={styles.label}>Department</label>
            <input style={styles.input} value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Start date</label>
            <input
              type="date"
              style={styles.input}
              value={form.start_date}
              onChange={(e) => setForm({ ...form, start_date: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Phone</label>
            <input style={styles.input} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Email</label>
            <input style={styles.input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
        </div>
        <button style={styles.button} onClick={addEmployee} disabled={saving}>
          {saving ? 'Adding…' : 'Add employee'}
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>{employees.length} employees</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Today</th>
              <th style={styles.th}>Uniforms</th>
              <th style={styles.th}>Position</th>
              <th style={styles.th}>Department</th>
              <th style={styles.th}>Start date</th>
              <th style={styles.th}>Phone</th>
              <th style={styles.th}>Email</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => {
              const info = todayInfo(e)
              const weekLoc = info.status === 'on' ? locationByKey[`${e.id}|${thisWeekKey}`] : null
              const label =
                info.status === 'on'
                  ? `Working${weekLoc ? ` — ${weekLoc.location_id}` : ''}`
                  : info.status === 'leave'
                    ? 'On leave'
                    : info.status === 'off'
                      ? 'Off'
                      : '—'
              const tone = info.status === 'on' ? 'good' : 'neutral'
              return (
              <tr key={e.id}>
                <td style={styles.td}>
                  {e.first_name} {e.last_name}
                </td>
                <td style={styles.td}>
                  <span style={styles.badge(tone)}>{label}</span>
                </td>
                <td style={styles.td}>
                  <button style={styles.buttonGhost} onClick={() => onSelectEmployee(e.id)}>
                    View items
                  </button>
                </td>
                <td style={styles.td}>
                  {addingPositionForId === e.id ? (
                    <div style={{ ...styles.row, gap: 4 }}>
                      <input
                        autoFocus
                        style={{ ...styles.smallInput, width: 100 }}
                        placeholder="New position"
                        value={rowNewPositionText}
                        onChange={(ev) => setRowNewPositionText(ev.target.value)}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter') {
                            ev.preventDefault()
                            confirmRowPosition(e.id)
                          }
                        }}
                      />
                      <button style={styles.buttonGhost} onClick={() => confirmRowPosition(e.id)}>
                        Use
                      </button>
                    </div>
                  ) : (
                    <select
                      style={{ ...styles.smallInput, width: 110 }}
                      defaultValue={e.position || ''}
                      onChange={(ev) => {
                        if (ev.target.value === '__new__') {
                          setAddingPositionForId(e.id)
                          setRowNewPositionText('')
                        } else {
                          updateEmployee(e.id, { position: ev.target.value })
                        }
                      }}
                    >
                      <option value="">No position set</option>
                      {positionOptions.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                      <option value="__new__">+ Add new position…</option>
                    </select>
                  )}
                </td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 110 }}
                    defaultValue={e.department || ''}
                    onBlur={(ev) => updateEmployee(e.id, { department: ev.target.value })}
                  />
                </td>
                <td style={styles.td}>{e.start_date || '—'}</td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 110 }}
                    defaultValue={e.phone || ''}
                    onBlur={(ev) => updateEmployee(e.id, { phone: ev.target.value })}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 150 }}
                    defaultValue={e.email || ''}
                    onBlur={(ev) => updateEmployee(e.id, { email: ev.target.value })}
                  />
                </td>
                <td style={styles.td}>
                  <select
                    style={styles.smallInput}
                    defaultValue={e.status || 'Active'}
                    onChange={(ev) => updateEmployee(e.id, { status: ev.target.value })}
                  >
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                  </select>
                </td>
                <td style={styles.td}>
                  <button style={styles.buttonDanger} onClick={() => deactivate(e.id)}>
                    Remove
                  </button>
                </td>
              </tr>
              )
            })}
            {employees.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={10}>
                  No employees yet — add one above.
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
  const [itemForm, setItemForm] = useState({ name: '', category: 'Shirt', size: '', price: '', supplier_id: '' })
  const [savingItem, setSavingItem] = useState(false)
  const [issueForm, setIssueForm] = useState({ item_id: '', employee_id: '' })
  const [issuing, setIssuing] = useState(false)

  async function addItem() {
    if (!itemForm.name.trim()) return
    setSavingItem(true)
    const [row] = await sb.insert('hr_uniform_items', {
      ...itemForm,
      company_id: companyId,
      price: Number(itemForm.price || 0),
      supplier_id: itemForm.supplier_id || null,
    })
    setItemForm({ name: '', category: 'Shirt', size: '', price: '', supplier_id: '' })
    setSavingItem(false)
    onItemAdd(row)
  }

  async function updateItem(id, patch) {
    const [row] = await sb.update('hr_uniform_items', { id }, patch)
    onItemUpdate(row)
  }

  async function deactivateItem(id) {
    await sb.update('hr_uniform_items', { id }, { active: false })
    onItemRemove(id)
  }

  async function saveStock(itemId, field, value) {
    const stock = stockByItem[itemId]
    const payload = {
      item_id: itemId,
      company_id: companyId,
      qty_on_hand: field === 'qty_on_hand' ? Number(value || 0) : stock?.qty_on_hand ?? 0,
      min_units: field === 'min_units' ? Number(value || 0) : stock?.min_units ?? 0,
      max_units: field === 'max_units' ? Number(value || 0) : stock?.max_units ?? 0,
    }
    const [row] = await sb.upsert('hr_uniform_stock', payload, 'item_id')
    onStockChange(row)
  }

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
      {isAdmin && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Add uniform item</div>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
            One shared pool for the whole company — add each size as its own item (e.g. "Polo Shirt"
            size 'M' and size 'L' as two separate rows).
          </div>
          <div style={styles.formGrid}>
            <div>
              <label style={styles.label}>Name</label>
              <input style={styles.input} value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} />
            </div>
            <div>
              <label style={styles.label}>Category</label>
              <select style={styles.input} value={itemForm.category} onChange={(e) => setItemForm({ ...itemForm, category: e.target.value })}>
                {UNIFORM_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={styles.label}>Size</label>
              <input style={styles.input} value={itemForm.size} onChange={(e) => setItemForm({ ...itemForm, size: e.target.value })} />
            </div>
            <div>
              <label style={styles.label}>Price</label>
              <input
                type="number"
                style={styles.input}
                value={itemForm.price}
                onChange={(e) => setItemForm({ ...itemForm, price: e.target.value })}
              />
            </div>
            <div>
              <label style={styles.label}>Supplier</label>
              <select
                style={styles.input}
                value={itemForm.supplier_id}
                onChange={(e) => setItemForm({ ...itemForm, supplier_id: e.target.value })}
              >
                <option value="">No supplier</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button style={styles.button} onClick={addItem} disabled={savingItem}>
            {savingItem ? 'Adding…' : 'Add item'}
          </button>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.cardTitle}>Issue an item</div>
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
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Employees</div>
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
      </div>

      {isAdmin && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Stock levels</div>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
            "On hand" changes automatically when items are issued/replaced/returned — edit it directly
            here when new stock arrives from a supplier, or to correct a count.
          </div>
          <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Item</th>
                <th style={styles.th}>Category</th>
                <th style={styles.th}>Supplier</th>
                <th style={styles.th}>Price</th>
                <th style={styles.th}>On hand</th>
                <th style={styles.th}>Value</th>
                <th style={styles.th}>Min</th>
                <th style={styles.th}>Max</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const stock = stockByItem[it.id]
                const value = Number(it.price || 0) * Number(stock?.qty_on_hand ?? 0)
                return (
                  <tr key={it.id}>
                    <td style={styles.td}>
                      {it.name} {it.size ? `(${it.size})` : ''}
                    </td>
                    <td style={styles.td}>
                      <input
                        style={{ ...styles.smallInput, width: 90 }}
                        defaultValue={it.category}
                        onBlur={(e) => updateItem(it.id, { category: e.target.value })}
                      />
                    </td>
                    <td style={styles.td}>
                      <select
                        style={styles.smallInput}
                        defaultValue={it.supplier_id || ''}
                        onChange={(e) => updateItem(it.id, { supplier_id: e.target.value || null })}
                      >
                        <option value="">No supplier</option>
                        {suppliers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        style={styles.smallInput}
                        defaultValue={it.price ?? 0}
                        onBlur={(e) => updateItem(it.id, { price: Number(e.target.value) || 0 })}
                      />
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        style={styles.smallInput}
                        defaultValue={stock?.qty_on_hand ?? 0}
                        onBlur={(e) => saveStock(it.id, 'qty_on_hand', e.target.value)}
                      />
                    </td>
                    <td style={styles.tdNum}>R {fmt(value)}</td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        style={styles.smallInput}
                        defaultValue={stock?.min_units ?? 0}
                        onBlur={(e) => saveStock(it.id, 'min_units', e.target.value)}
                      />
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        style={styles.smallInput}
                        defaultValue={stock?.max_units ?? 0}
                        onBlur={(e) => saveStock(it.id, 'max_units', e.target.value)}
                      />
                    </td>
                    <td style={styles.td}>
                      <button style={styles.buttonDanger} onClick={() => deactivateItem(it.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
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
  const [location, setLocation] = useState('ZC')
  const [itemForm, setItemForm] = useState({ name: '', category: 'Towels', size: '', price: '', supplier_id: '' })
  const [savingItem, setSavingItem] = useState(false)
  const [moveForm, setMoveForm] = useState({ item_id: '', qty: '', reason: 'Received', note: '' })
  const [logging, setLogging] = useState(false)
  const [addingCategory, setAddingCategory] = useState(false)
  const [newCategoryText, setNewCategoryText] = useState('')

  // Starter categories plus whatever's already in use on real items (so a
  // category someone typed in last week shows up as a normal dropdown
  // choice from then on) — always includes whatever's currently selected
  // so the dropdown never shows blank right after adding a new one.
  const categoryOptions = useMemo(() => {
    const set = new Set(LINEN_CATEGORIES)
    for (const it of items) if (it.category) set.add(it.category)
    if (itemForm.category) set.add(itemForm.category)
    return Array.from(set).sort()
  }, [items, itemForm.category])

  function confirmNewCategory() {
    const v = newCategoryText.trim()
    if (v) setItemForm((f) => ({ ...f, category: v }))
    setAddingCategory(false)
    setNewCategoryText('')
  }

  const stockByItem = useMemo(() => {
    const map = {}
    for (const s of stock) if (s.location_id === location) map[s.item_id] = s
    return map
  }, [stock, location])

  const locationMovements = useMemo(() => movements.filter((m) => m.location_id === location), [movements, location])

  async function addItem() {
    if (!itemForm.name.trim()) return
    setSavingItem(true)
    const [row] = await sb.insert('hr_linen_items', {
      ...itemForm,
      company_id: companyId,
      price: Number(itemForm.price || 0),
      supplier_id: itemForm.supplier_id || null,
    })
    setItemForm({ name: '', category: 'Towels', size: '', price: '', supplier_id: '' })
    setSavingItem(false)
    onItemAdd(row)
  }

  async function updateItem(id, patch) {
    const [row] = await sb.update('hr_linen_items', { id }, patch)
    onItemUpdate(row)
  }

  async function deactivateItem(id) {
    await sb.update('hr_linen_items', { id }, { active: false })
    onItemRemove(id)
  }

  async function saveStockField(itemId, field, value) {
    const s = stockByItem[itemId]
    const payload = {
      item_id: itemId,
      location_id: location,
      company_id: companyId,
      qty_on_hand: field === 'qty_on_hand' ? Number(value || 0) : s?.qty_on_hand ?? 0,
      min_units: field === 'min_units' ? Number(value || 0) : s?.min_units ?? 0,
      max_units: field === 'max_units' ? Number(value || 0) : s?.max_units ?? 0,
    }
    const [row] = await sb.upsert('hr_linen_stock', payload, 'item_id,location_id')
    onStockChange(row)
  }

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

      {isAdmin && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Add linen item</div>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
            Shared catalog across all lodges — add each size as its own item (e.g. "Duvet Cover" size
            'Queen' and size 'King' as two separate rows). Leave size blank if it doesn't apply.
          </div>
          <div style={styles.formGrid}>
            <div>
              <label style={styles.label}>Name</label>
              <input style={styles.input} value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} />
            </div>
            <div>
              <label style={styles.label}>Category</label>
              {addingCategory ? (
                <div style={{ ...styles.row, gap: 4 }}>
                  <input
                    autoFocus
                    style={styles.input}
                    placeholder="New category name"
                    value={newCategoryText}
                    onChange={(e) => setNewCategoryText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        confirmNewCategory()
                      }
                    }}
                  />
                  <button style={styles.buttonGhost} onClick={confirmNewCategory}>
                    Use
                  </button>
                  <button
                    style={styles.buttonGhost}
                    onClick={() => {
                      setAddingCategory(false)
                      setNewCategoryText('')
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <select
                  style={styles.input}
                  value={itemForm.category}
                  onChange={(e) => {
                    if (e.target.value === '__new__') setAddingCategory(true)
                    else setItemForm({ ...itemForm, category: e.target.value })
                  }}
                >
                  {categoryOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  <option value="__new__">+ Add new category…</option>
                </select>
              )}
            </div>
            <div>
              <label style={styles.label}>Size (optional)</label>
              <input style={styles.input} value={itemForm.size} onChange={(e) => setItemForm({ ...itemForm, size: e.target.value })} />
            </div>
            <div>
              <label style={styles.label}>Price</label>
              <input
                type="number"
                style={styles.input}
                value={itemForm.price}
                onChange={(e) => setItemForm({ ...itemForm, price: e.target.value })}
              />
            </div>
            <div>
              <label style={styles.label}>Supplier</label>
              <select
                style={styles.input}
                value={itemForm.supplier_id}
                onChange={(e) => setItemForm({ ...itemForm, supplier_id: e.target.value })}
              >
                <option value="">No supplier</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button style={styles.button} onClick={addItem} disabled={savingItem}>
            {savingItem ? 'Adding…' : 'Add item'}
          </button>
        </div>
      )}

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
            <input type="number" style={styles.input} value={moveForm.qty} onChange={(e) => setMoveForm({ ...moveForm, qty: e.target.value })} />
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
        <div style={styles.card}>
          <div style={styles.cardTitle}>Stock levels — {location}</div>
          <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Item</th>
                <th style={styles.th}>Category</th>
                <th style={styles.th}>Supplier</th>
                <th style={styles.th}>Price</th>
                <th style={styles.th}>On hand</th>
                <th style={styles.th}>Value</th>
                <th style={styles.th}>Min</th>
                <th style={styles.th}>Max</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const s = stockByItem[it.id]
                const value = Number(it.price || 0) * Number(s?.qty_on_hand ?? 0)
                return (
                  <tr key={it.id}>
                    <td style={styles.td}>
                      {it.name} {it.size ? `(${it.size})` : ''}
                    </td>
                    <td style={styles.td}>
                      <input
                        style={{ ...styles.smallInput, width: 100 }}
                        defaultValue={it.category}
                        onBlur={(e) => updateItem(it.id, { category: e.target.value })}
                      />
                    </td>
                    <td style={styles.td}>
                      <select
                        style={styles.smallInput}
                        defaultValue={it.supplier_id || ''}
                        onChange={(e) => updateItem(it.id, { supplier_id: e.target.value || null })}
                      >
                        <option value="">No supplier</option>
                        {suppliers.map((s2) => (
                          <option key={s2.id} value={s2.id}>
                            {s2.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        style={styles.smallInput}
                        defaultValue={it.price ?? 0}
                        onBlur={(e) => updateItem(it.id, { price: Number(e.target.value) || 0 })}
                      />
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        style={styles.smallInput}
                        defaultValue={s?.qty_on_hand ?? 0}
                        onBlur={(e) => saveStockField(it.id, 'qty_on_hand', e.target.value)}
                      />
                    </td>
                    <td style={styles.tdNum}>R {fmt(value)}</td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        style={styles.smallInput}
                        defaultValue={s?.min_units ?? 0}
                        onBlur={(e) => saveStockField(it.id, 'min_units', e.target.value)}
                      />
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        style={styles.smallInput}
                        defaultValue={s?.max_units ?? 0}
                        onBlur={(e) => saveStockField(it.id, 'max_units', e.target.value)}
                      />
                    </td>
                    <td style={styles.td}>
                      <button style={styles.buttonDanger} onClick={() => deactivateItem(it.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Suppliers tab — one shared list (not per-lodge), used by both Uniforms
// and Linen.
// ---------------------------------------------------------------------------

function SuppliersTab({ companyId, suppliers, onAdd, onUpdate, onRemove }) {
  const [form, setForm] = useState({ name: '', contact_name: '', phone: '', email: '', notes: '' })
  const [saving, setSaving] = useState(false)

  async function addSupplier() {
    if (!form.name.trim()) return
    setSaving(true)
    const [row] = await sb.insert('hr_suppliers', { ...form, company_id: companyId })
    setForm({ name: '', contact_name: '', phone: '', email: '', notes: '' })
    setSaving(false)
    onAdd(row)
  }

  async function updateSupplier(id, patch) {
    const [row] = await sb.update('hr_suppliers', { id }, patch)
    onUpdate(row)
  }

  async function deactivate(id) {
    await sb.update('hr_suppliers', { id }, { active: false })
    onRemove(id)
  }

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Add supplier</div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Name</label>
            <input style={styles.input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Contact name</label>
            <input
              style={styles.input}
              value={form.contact_name}
              onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
            />
          </div>
          <div>
            <label style={styles.label}>Phone</label>
            <input style={styles.input} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Email</label>
            <input style={styles.input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label style={styles.label}>Notes</label>
            <input style={styles.input} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        <button style={styles.button} onClick={addSupplier} disabled={saving}>
          {saving ? 'Adding…' : 'Add supplier'}
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>{suppliers.length} suppliers</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Contact</th>
              <th style={styles.th}>Phone</th>
              <th style={styles.th}>Email</th>
              <th style={styles.th}>Notes</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((s) => (
              <tr key={s.id}>
                <td style={styles.td}>{s.name}</td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 130 }}
                    defaultValue={s.contact_name || ''}
                    onBlur={(e) => updateSupplier(s.id, { contact_name: e.target.value })}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 110 }}
                    defaultValue={s.phone || ''}
                    onBlur={(e) => updateSupplier(s.id, { phone: e.target.value })}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 160 }}
                    defaultValue={s.email || ''}
                    onBlur={(e) => updateSupplier(s.id, { email: e.target.value })}
                  />
                </td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 160 }}
                    defaultValue={s.notes || ''}
                    onBlur={(e) => updateSupplier(s.id, { notes: e.target.value })}
                  />
                </td>
                <td style={styles.td}>
                  <button style={styles.buttonDanger} onClick={() => deactivate(s.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {suppliers.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={6}>
                  No suppliers yet — add one above, then link uniform/linen items to it.
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

function ContractsTab({ companyId, employees, contracts, onAdd, onUpdate }) {
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('')
  const [form, setForm] = useState({
    contract_type: 'Permanent',
    start_date: todayStr(),
    end_date: '',
    salary: '',
    medical_aid: false,
    medical_aid_scheme: '',
    pension_fund: false,
    pension_fund_name: '',
    notes: '',
  })
  const [saving, setSaving] = useState(false)

  const overview = useMemo(
    () =>
      employees
        .map((e) => ({ employee: e, contract: currentContract(e.id, contracts) }))
        .sort((a, b) => `${a.employee.first_name}`.localeCompare(b.employee.first_name)),
    [employees, contracts]
  )

  const selectedHistory = useMemo(
    () =>
      contracts
        .filter((c) => c.employee_id === selectedEmployeeId)
        .sort((a, b) => (a.start_date < b.start_date ? 1 : -1)),
    [contracts, selectedEmployeeId]
  )

  async function addContract() {
    if (!selectedEmployeeId || !form.start_date) return
    setSaving(true)
    const [row] = await sb.insert('hr_contracts', {
      company_id: companyId,
      employee_id: selectedEmployeeId,
      contract_type: form.contract_type,
      start_date: form.start_date,
      end_date: form.end_date || null,
      salary: form.salary === '' ? null : Number(form.salary),
      medical_aid: form.medical_aid,
      medical_aid_scheme: form.medical_aid_scheme || null,
      pension_fund: form.pension_fund,
      pension_fund_name: form.pension_fund_name || null,
      notes: form.notes,
    })
    setForm({
      contract_type: 'Permanent',
      start_date: todayStr(),
      end_date: '',
      salary: '',
      medical_aid: false,
      medical_aid_scheme: '',
      pension_fund: false,
      pension_fund_name: '',
      notes: '',
    })
    setSaving(false)
    onAdd(row)
  }

  const empName = (id) => {
    const e = employees.find((x) => x.id === id)
    return e ? `${e.first_name} ${e.last_name}` : 'Unknown'
  }

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardTitle}>All employees — current contract</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Sensitive data — salary, medical aid, and pension details are only visible to HR Admin.
        </div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Employee</th>
              <th style={styles.th}>Type</th>
              <th style={styles.th}>Start date</th>
              <th style={styles.th}>End date</th>
              <th style={styles.th}>Salary</th>
              <th style={styles.th}>Medical aid</th>
              <th style={styles.th}>Pension</th>
            </tr>
          </thead>
          <tbody>
            {overview.map(({ employee, contract }) => {
              const days = contract?.end_date ? daysUntil(contract.end_date) : null
              return (
                <tr key={employee.id}>
                  <td style={styles.td}>
                    <button
                      style={{ ...styles.buttonGhost, padding: '3px 8px', fontSize: 12 }}
                      onClick={() => setSelectedEmployeeId(employee.id)}
                    >
                      {employee.first_name} {employee.last_name}
                    </button>
                  </td>
                  <td style={styles.td}>{contract?.contract_type || '—'}</td>
                  <td style={styles.td}>{contract?.start_date || '—'}</td>
                  <td style={styles.td}>
                    {contract?.end_date ? (
                      <span style={styles.badge(days !== null && days <= 60 ? 'bad' : 'neutral')}>{contract.end_date}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td style={styles.tdNum}>{contract?.salary ? `R ${fmt(contract.salary)}` : '—'}</td>
                  <td style={styles.td}>{contract ? (contract.medical_aid ? 'Yes' : 'No') : '—'}</td>
                  <td style={styles.td}>{contract ? (contract.pension_fund ? 'Yes' : 'No') : '—'}</td>
                </tr>
              )
            })}
            {overview.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={7}>
                  No employees yet — add them on the Employees tab first.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Add / view contract history</div>
        <div style={styles.formGrid}>
          <div>
            <label style={styles.label}>Employee</label>
            <select style={styles.input} value={selectedEmployeeId} onChange={(e) => setSelectedEmployeeId(e.target.value)}>
              <option value="">Choose employee…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.first_name} {e.last_name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {selectedEmployeeId && (
          <>
            <div style={styles.formGrid}>
              <div>
                <label style={styles.label}>Contract type</label>
                <select style={styles.input} value={form.contract_type} onChange={(e) => setForm({ ...form, contract_type: e.target.value })}>
                  {CONTRACT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={styles.label}>Start date</label>
                <input
                  type="date"
                  style={styles.input}
                  value={form.start_date}
                  onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                />
              </div>
              <div>
                <label style={styles.label}>End date (blank if ongoing)</label>
                <input
                  type="date"
                  style={styles.input}
                  value={form.end_date}
                  onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                />
              </div>
              <div>
                <label style={styles.label}>Salary</label>
                <input
                  type="number"
                  style={styles.input}
                  value={form.salary}
                  onChange={(e) => setForm({ ...form, salary: e.target.value })}
                />
              </div>
              <div>
                <label style={styles.label}>Medical aid</label>
                <select
                  style={styles.input}
                  value={form.medical_aid ? 'yes' : 'no'}
                  onChange={(e) => setForm({ ...form, medical_aid: e.target.value === 'yes' })}
                >
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </div>
              {form.medical_aid && (
                <div>
                  <label style={styles.label}>Medical aid scheme</label>
                  <input
                    style={styles.input}
                    value={form.medical_aid_scheme}
                    onChange={(e) => setForm({ ...form, medical_aid_scheme: e.target.value })}
                  />
                </div>
              )}
              <div>
                <label style={styles.label}>Pension fund</label>
                <select
                  style={styles.input}
                  value={form.pension_fund ? 'yes' : 'no'}
                  onChange={(e) => setForm({ ...form, pension_fund: e.target.value === 'yes' })}
                >
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </div>
              {form.pension_fund && (
                <div>
                  <label style={styles.label}>Pension fund name</label>
                  <input
                    style={styles.input}
                    value={form.pension_fund_name}
                    onChange={(e) => setForm({ ...form, pension_fund_name: e.target.value })}
                  />
                </div>
              )}
              <div>
                <label style={styles.label}>Notes</label>
                <input style={styles.input} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
            </div>
            <button style={styles.button} onClick={addContract} disabled={saving}>
              {saving ? 'Saving…' : 'Add contract record'}
            </button>

            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: colors.goldLt, marginBottom: 8 }}>
                {empName(selectedEmployeeId)} — contract history
              </div>
              <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Type</th>
                    <th style={styles.th}>Start</th>
                    <th style={styles.th}>End</th>
                    <th style={styles.th}>Salary</th>
                    <th style={styles.th}>Medical aid</th>
                    <th style={styles.th}>Pension</th>
                    <th style={styles.th}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedHistory.map((c) => (
                    <tr key={c.id}>
                      <td style={styles.td}>{c.contract_type}</td>
                      <td style={styles.td}>{c.start_date}</td>
                      <td style={styles.td}>{c.end_date || '—'}</td>
                      <td style={styles.tdNum}>{c.salary ? `R ${fmt(c.salary)}` : '—'}</td>
                      <td style={styles.td}>{c.medical_aid ? c.medical_aid_scheme || 'Yes' : 'No'}</td>
                      <td style={styles.td}>{c.pension_fund ? c.pension_fund_name || 'Yes' : 'No'}</td>
                      <td style={styles.td}>{c.notes || '—'}</td>
                    </tr>
                  ))}
                  {selectedHistory.length === 0 && (
                    <tr>
                      <td style={styles.td} colSpan={7}>
                        No contract on record yet — add one above.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>
          </>
        )}
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
// Broken/Replace and Return actions on whatever's currently issued.
// ---------------------------------------------------------------------------

function EmployeeUniformModal({ role, companyId, employee, items, stockByItem, issues, onClose, onStockChange, onIssuesAdd, onIssuesUpdate, onIssuesRemove }) {
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

  const itemName = (id) => {
    const it = items.find((i) => i.id === id)
    return it ? `${it.name}${it.size ? ` (${it.size})` : ''}` : 'Unknown item'
  }

  async function replaceItem(issue) {
    const stock = stockByItem[issue.item_id]
    const [updatedOld] = await sb.update('hr_uniform_issues', { id: issue.id }, { status: 'broken', resolved_date: todayStr() })
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
        qty_on_hand: (stock?.qty_on_hand ?? 0) - 1,
        min_units: stock?.min_units ?? 0,
        max_units: stock?.max_units ?? 0,
      },
      'item_id'
    )
    onIssuesUpdate(updatedOld)
    onIssuesAdd(newIssue)
    onStockChange(stockRow)
    setConfirmMsg(`Marked broken — a replacement ${itemName(issue.item_id)} was issued to ${employee.first_name}.`)
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
                        <button style={styles.buttonGhost} onClick={() => replaceItem(i)}>
                          Broken — replace
                        </button>
                        <button style={styles.buttonDanger} onClick={() => returnItem(i)}>
                          Return
                        </button>
                      </>
                    )}
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
      </div>

      {confirmMsg && <ConfirmPopup message={confirmMsg} onClose={() => setConfirmMsg(null)} />}
    </div>
  )
}
