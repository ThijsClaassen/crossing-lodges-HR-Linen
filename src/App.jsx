import { useEffect, useMemo, useState } from 'react'
import { sb, LOCATIONS, UNIFORM_CATEGORIES, LINEN_CATEGORIES, MOVEMENT_REASONS, CONTRACT_TYPES } from './sb.js'
import { colors, fonts } from './theme.js'

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
  nav: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    background: colors.panel,
    borderTop: `1px solid ${colors.border}`,
    display: 'flex',
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    zIndex: 10,
  },
  navItem: (active) => ({
    flex: '0 0 auto',
    minWidth: 72,
    padding: '10px 12px 8px',
    textAlign: 'center',
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    color: active ? colors.goldLt : colors.muted,
    cursor: 'pointer',
    background: 'none',
    border: 'none',
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
  { id: 'uniforms', label: 'Uniforms' },
  { id: 'linen', label: 'Linen' },
  { id: 'suppliers', label: 'Suppliers' },
  { id: 'orders', label: 'Orders' },
]
const HRADMIN_TABS = [...ADMIN_TABS, { id: 'contracts', label: 'Contracts' }]

function tabsForRole(role) {
  if (role === 'hradmin') return HRADMIN_TABS
  if (role === 'admin') return ADMIN_TABS
  return STAFF_TABS
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function useAuth() {
  const [role, setRole] = useState(() => {
    try {
      return localStorage.getItem('hr_role') || null
    } catch {
      return null
    }
  })

  function login(r) {
    try {
      localStorage.setItem('hr_role', r)
    } catch {
      /* ignore storage errors */
    }
    setRole(r)
  }

  function logout() {
    try {
      localStorage.removeItem('hr_role')
    } catch {
      /* ignore storage errors */
    }
    setRole(null)
  }

  return { role, login, logout }
}

const ROLE_LABELS = { staff: 'Staff', admin: 'Admin', hradmin: 'HR Admin' }

function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (!password) return
    setChecking(true)
    setError('')
    try {
      const rows = await sb.select('hr_access', { password })
      if (rows && rows.length) {
        onLogin(rows[0].role)
      } else {
        setError('Incorrect password.')
      }
    } catch (err) {
      setError(`Could not reach the database: ${err.message}`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div style={{ ...styles.app, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={submit} style={{ ...styles.card, width: 280 }}>
        <img
          src="/logo.png"
          alt=""
          style={{ height: 56, width: 'auto', display: 'block', margin: '0 auto 12px' }}
          onError={(e) => (e.target.style.display = 'none')}
        />
        <div style={{ ...styles.cardTitle, textAlign: 'center' }}>Crossing Lodges — HR & Housekeeping</div>
        <label style={styles.label}>Password</label>
        <input
          type="password"
          autoFocus
          style={styles.input}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div style={{ color: colors.danger, fontSize: 12, marginTop: 8 }}>{error}</div>}
        <button type="submit" style={{ ...styles.button, width: '100%', marginTop: 12 }} disabled={checking}>
          {checking ? 'Checking…' : 'Log in'}
        </button>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const { role, login, logout } = useAuth()
  const [tab, setTab] = useState('dashboard')
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

  async function loadAll() {
    setLoading(true)
    setError(null)
    try {
      const base = [
        sb.select('hr_employees', { active: true }, { order: 'first_name.asc' }),
        sb.select('hr_suppliers', { active: true }, { order: 'name.asc' }),
        sb.select('hr_uniform_items', { active: true }, { order: 'category.asc,name.asc' }),
        sb.select('hr_uniform_stock', {}, {}),
        sb.select('hr_uniform_issues', {}, { order: 'created_at.desc' }),
        sb.select('hr_linen_items', { active: true }, { order: 'category.asc,name.asc' }),
        sb.select('hr_linen_stock', {}, {}),
        sb.select('hr_linen_movements', {}, { order: 'date.desc' }),
      ]
      // Contracts hold salary/medical aid/pension — only ever fetched for the
      // HR Admin role, so that data never transits to a Staff/Admin session.
      const results = await Promise.all(role === 'hradmin' ? [...base, sb.select('hr_contracts', {}, {})] : base)
      const [empRes, supRes, uItemsRes, uStockRes, uIssuesRes, lItemsRes, lStockRes, lMoveRes, conRes] = results

      setEmployees(empRes || [])
      setSuppliers(supRes || [])
      setUniformItems(uItemsRes || [])
      setUniformStock(uStockRes || [])
      setUniformIssues(uIssuesRes || [])
      setLinenItems(lItemsRes || [])
      setLinenStock(lStockRes || [])
      setLinenMovements(lMoveRes || [])
      setContracts(conRes || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (role) loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role])

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

  if (!role) {
    return <LoginScreen onLogin={login} />
  }

  const TABS = tabsForRole(role)
  const activeTab = TABS.some((t) => t.id === tab) ? tab : TABS[0].id

  return (
    <div style={styles.app}>
      <div style={styles.header}>
        <div style={{ ...styles.row, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ ...styles.headerTitle, minWidth: 0, flexShrink: 1 }}>
            <img
              src="/logo.png"
              alt=""
              style={{ ...styles.logo, flexShrink: 0 }}
              onError={(e) => (e.target.style.display = 'none')}
            />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>Crossing Lodges — HR & Housekeeping</span>
          </div>
          <div style={{ ...styles.row, flexShrink: 0 }}>
            <span style={styles.badge('neutral')}>{ROLE_LABELS[role]}</span>
            <button style={{ ...styles.pill(false), padding: '4px 10px' }} onClick={logout}>
              Log out
            </button>
          </div>
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
              />
            )}
            {activeTab === 'employees' && (role === 'admin' || role === 'hradmin') && (
              <EmployeesTab
                employees={employees}
                onAdd={addLocalEmployee}
                onUpdate={updateLocalEmployee}
                onRemove={removeLocalEmployee}
                onSelectEmployee={setUniformEmployeeId}
              />
            )}
            {activeTab === 'uniforms' && (
              <UniformsTab
                role={role}
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
                employees={employees}
                contracts={contracts}
                onAdd={addLocalContract}
                onUpdate={updateLocalContract}
              />
            )}
          </>
        )}
      </div>

      <div style={styles.nav}>
        {TABS.map((t) => (
          <button key={t.id} style={styles.navItem(activeTab === t.id)} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {uniformEmployeeId && employeeById[uniformEmployeeId] && (
        <EmployeeUniformModal
          role={role}
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
// Employees tab — Admin/HR Admin: master list, one lodge at a time.
// ---------------------------------------------------------------------------

function EmployeesTab({ employees, onAdd, onUpdate, onRemove, onSelectEmployee }) {
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

  async function addEmployee() {
    if (!form.first_name.trim() || !form.last_name.trim()) return
    setSaving(true)
    const [row] = await sb.insert('hr_employees', { ...form, status: 'Active' })
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
            <input style={styles.input} value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
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
            {employees.map((e) => (
              <tr key={e.id}>
                <td style={styles.td}>
                  {e.first_name} {e.last_name}
                </td>
                <td style={styles.td}>
                  <button style={styles.buttonGhost} onClick={() => onSelectEmployee(e.id)}>
                    View items
                  </button>
                </td>
                <td style={styles.td}>
                  <input
                    style={{ ...styles.smallInput, width: 110 }}
                    defaultValue={e.position || ''}
                    onBlur={(ev) => updateEmployee(e.id, { position: ev.target.value })}
                  />
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
            ))}
            {employees.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={9}>
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
      status: 'issued',
      issued_date: todayStr(),
    })
    const [stockRow] = await sb.upsert(
      'hr_uniform_stock',
      {
        item_id: issueForm.item_id,
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

function LinenTab({ role, items, stock, movements, suppliers, onItemAdd, onItemUpdate, onItemRemove, onStockChange, onMovementAdd }) {
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

function SuppliersTab({ suppliers, onAdd, onUpdate, onRemove }) {
  const [form, setForm] = useState({ name: '', contact_name: '', phone: '', email: '', notes: '' })
  const [saving, setSaving] = useState(false)

  async function addSupplier() {
    if (!form.name.trim()) return
    setSaving(true)
    const [row] = await sb.insert('hr_suppliers', form)
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

function ContractsTab({ employees, contracts, onAdd, onUpdate }) {
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

function EmployeeUniformModal({ role, employee, items, stockByItem, issues, onClose, onStockChange, onIssuesAdd, onIssuesUpdate, onIssuesRemove }) {
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
      status: 'issued',
      issued_date: todayStr(),
      replaces_issue_id: issue.id,
    })
    const [stockRow] = await sb.upsert(
      'hr_uniform_stock',
      {
        item_id: issue.item_id,
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
