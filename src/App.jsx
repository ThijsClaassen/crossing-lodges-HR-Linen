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
  const [location, setLocation] = useState('ZC')
  const [tab, setTab] = useState('dashboard')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [employees, setEmployees] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [uniformItems, setUniformItems] = useState([])
  const [uniformStock, setUniformStock] = useState([])
  const [uniformIssues, setUniformIssues] = useState([])
  const [linenItems, setLinenItems] = useState([])
  const [linenStock, setLinenStock] = useState([])
  const [linenMovements, setLinenMovements] = useState([])
  const [contracts, setContracts] = useState([])

  async function loadAll() {
    setLoading(true)
    setError(null)
    try {
      const base = [
        sb.select('hr_employees', { location_id: location, active: true }, { order: 'first_name.asc' }),
        sb.select('hr_suppliers', { active: true }, { order: 'name.asc' }),
        sb.select('hr_uniform_items', { active: true }, { order: 'category.asc,name.asc' }),
        sb.select('hr_uniform_stock', { location_id: location }, {}),
        sb.select('hr_uniform_issues', { location_id: location }, { order: 'created_at.desc' }),
        sb.select('hr_linen_items', { active: true }, { order: 'category.asc,name.asc' }),
        sb.select('hr_linen_stock', { location_id: location }, {}),
        sb.select('hr_linen_movements', { location_id: location }, { order: 'date.desc' }),
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
  }, [location, role])

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
      const map = new Map(prev.map((s) => [`${s.item_id}|${s.location_id}`, s]))
      for (const row of list) map.set(`${row.item_id}|${row.location_id}`, row)
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

  const linenStockByItem = useMemo(() => {
    const map = {}
    for (const s of linenStock) map[s.item_id] = s
    return map
  }, [linenStock])

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
        <div style={styles.row}>
          <div style={styles.pillGroup}>
            {LOCATIONS.map((l) => (
              <button key={l.id} style={styles.pill(location === l.id, l.id)} onClick={() => setLocation(l.id)}>
                {l.id}
              </button>
            ))}
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
                linenItems={linenItems}
                linenStockByItem={linenStockByItem}
                employees={employees}
                contracts={contracts}
              />
            )}
            {activeTab === 'employees' && (role === 'admin' || role === 'hradmin') && (
              <EmployeesTab
                employees={employees}
                location={location}
                onAdd={addLocalEmployee}
                onUpdate={updateLocalEmployee}
                onRemove={removeLocalEmployee}
              />
            )}
            {activeTab === 'uniforms' && (
              <UniformsTab
                role={role}
                items={uniformItems}
                stockByItem={uniformStockByItem}
                issues={uniformIssues}
                employees={employees}
                employeeById={employeeById}
                suppliers={suppliers}
                location={location}
                onItemAdd={addLocalUniformItem}
                onItemUpdate={updateLocalUniformItem}
                onItemRemove={removeLocalUniformItem}
                onStockChange={upsertLocalUniformStock}
                onIssuesAdd={addLocalUniformIssues}
                onIssuesUpdate={updateLocalUniformIssues}
              />
            )}
            {activeTab === 'linen' && (
              <LinenTab
                role={role}
                items={linenItems}
                stockByItem={linenStockByItem}
                movements={linenMovements}
                suppliers={suppliers}
                location={location}
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
                linenStockByItem={linenStockByItem}
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

function DashboardTab({ role, uniformItems, uniformStockByItem, linenItems, linenStockByItem, employees, contracts }) {
  const lowUniforms = useMemo(() => lowStockRows(uniformItems, uniformStockByItem), [uniformItems, uniformStockByItem])
  const lowLinen = useMemo(() => lowStockRows(linenItems, linenStockByItem), [linenItems, linenStockByItem])

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
        <div style={styles.cardTitle}>This lodge at a glance</div>
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
            <div style={{ fontSize: 11, color: colors.muted }}>Linen items low on stock</div>
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
              <th style={styles.th}>On hand</th>
              <th style={styles.th}>Min</th>
            </tr>
          </thead>
          <tbody>
            {lowLinen.map(({ item, stock }) => (
              <tr key={item.id}>
                <td style={styles.td}>
                  {item.name} {item.size ? `(${item.size})` : ''}
                </td>
                <td style={styles.tdNum}>{fmt(stock.qty_on_hand, 0)}</td>
                <td style={styles.tdNum}>{fmt(stock.min_units, 0)}</td>
              </tr>
            ))}
            {lowLinen.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={3}>
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

function EmployeesTab({ employees, location, onAdd, onUpdate, onRemove }) {
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
    const [row] = await sb.insert('hr_employees', { ...form, location_id: location, status: 'Active' })
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
        <div style={styles.cardTitle}>Add employee — {location}</div>
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
        <div style={styles.cardTitle}>{employees.length} employees — {location}</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
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
                <td style={styles.td} colSpan={8}>
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
  employeeById,
  suppliers,
  location,
  onItemAdd,
  onItemUpdate,
  onItemRemove,
  onStockChange,
  onIssuesAdd,
  onIssuesUpdate,
}) {
  const isAdmin = role === 'admin' || role === 'hradmin'
  const [itemForm, setItemForm] = useState({ name: '', category: 'Shirt', size: '', supplier_id: '' })
  const [savingItem, setSavingItem] = useState(false)
  const [issueForm, setIssueForm] = useState({ item_id: '', employee_id: '' })
  const [issuing, setIssuing] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  async function addItem() {
    if (!itemForm.name.trim()) return
    setSavingItem(true)
    const [row] = await sb.insert('hr_uniform_items', { ...itemForm, supplier_id: itemForm.supplier_id || null })
    setItemForm({ name: '', category: 'Shirt', size: '', supplier_id: '' })
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
      location_id: location,
      qty_on_hand: field === 'qty_on_hand' ? Number(value || 0) : stock?.qty_on_hand ?? 0,
      min_units: field === 'min_units' ? Number(value || 0) : stock?.min_units ?? 0,
      max_units: field === 'max_units' ? Number(value || 0) : stock?.max_units ?? 0,
    }
    const [row] = await sb.upsert('hr_uniform_stock', payload, 'item_id,location_id')
    onStockChange(row)
  }

  async function issueNew() {
    if (!issueForm.item_id || !issueForm.employee_id) return
    setIssuing(true)
    const stock = stockByItem[issueForm.item_id]
    const [issueRow] = await sb.insert('hr_uniform_issues', {
      item_id: issueForm.item_id,
      employee_id: issueForm.employee_id,
      location_id: location,
      status: 'issued',
      issued_date: todayStr(),
    })
    const [stockRow] = await sb.upsert(
      'hr_uniform_stock',
      {
        item_id: issueForm.item_id,
        location_id: location,
        qty_on_hand: (stock?.qty_on_hand ?? 0) - 1,
        min_units: stock?.min_units ?? 0,
        max_units: stock?.max_units ?? 0,
      },
      'item_id,location_id'
    )
    onIssuesAdd(issueRow)
    onStockChange(stockRow)
    setIssuing(false)
  }

  async function replaceItem(issue) {
    const stock = stockByItem[issue.item_id]
    const [updatedOld] = await sb.update('hr_uniform_issues', { id: issue.id }, { status: 'broken', resolved_date: todayStr() })
    const [newIssue] = await sb.insert('hr_uniform_issues', {
      item_id: issue.item_id,
      employee_id: issue.employee_id,
      location_id: location,
      status: 'issued',
      issued_date: todayStr(),
      replaces_issue_id: issue.id,
    })
    const [stockRow] = await sb.upsert(
      'hr_uniform_stock',
      {
        item_id: issue.item_id,
        location_id: location,
        qty_on_hand: (stock?.qty_on_hand ?? 0) - 1,
        min_units: stock?.min_units ?? 0,
        max_units: stock?.max_units ?? 0,
      },
      'item_id,location_id'
    )
    onIssuesUpdate(updatedOld)
    onIssuesAdd(newIssue)
    onStockChange(stockRow)
  }

  async function returnItem(issue) {
    const stock = stockByItem[issue.item_id]
    const [updated] = await sb.update('hr_uniform_issues', { id: issue.id }, { status: 'returned', resolved_date: todayStr() })
    const [stockRow] = await sb.upsert(
      'hr_uniform_stock',
      {
        item_id: issue.item_id,
        location_id: location,
        qty_on_hand: (stock?.qty_on_hand ?? 0) + 1,
        min_units: stock?.min_units ?? 0,
        max_units: stock?.max_units ?? 0,
      },
      'item_id,location_id'
    )
    onIssuesUpdate(updated)
    onStockChange(stockRow)
  }

  const itemName = (id) => {
    const it = items.find((i) => i.id === id)
    return it ? `${it.name}${it.size ? ` (${it.size})` : ''}` : 'Unknown item'
  }
  const empName = (id) => {
    const e = employeeById[id]
    return e ? `${e.first_name} ${e.last_name}` : 'Unknown'
  }

  const activeIssues = issues.filter((i) => i.status === 'issued')
  const historyIssues = issues.filter((i) => i.status !== 'issued').slice(0, 30)

  return (
    <>
      {isAdmin && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Add uniform item</div>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
            Shared across all lodges — add each size as its own item (e.g. "Polo Shirt" size 'M' and
            size 'L' as two separate rows).
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
        <div style={styles.cardTitle}>Issue an item — {location}</div>
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
        <div style={styles.cardTitle}>Currently issued ({activeIssues.length})</div>
        <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Employee</th>
              <th style={styles.th}>Item</th>
              <th style={styles.th}>Issued</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {activeIssues.map((i) => (
              <tr key={i.id}>
                <td style={styles.td}>{empName(i.employee_id)}</td>
                <td style={styles.td}>{itemName(i.item_id)}</td>
                <td style={styles.td}>{i.issued_date}</td>
                <td style={styles.td}>
                  <div style={{ ...styles.row, gap: 4 }}>
                    <button style={styles.buttonGhost} onClick={() => replaceItem(i)}>
                      Broken — replace
                    </button>
                    <button style={styles.buttonDanger} onClick={() => returnItem(i)}>
                      Return
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {activeIssues.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={4}>
                  Nothing currently issued at this lodge.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      <div style={styles.card}>
        <div style={{ ...styles.row, justifyContent: 'space-between' }}>
          <div style={styles.cardTitle}>History</div>
          <button style={styles.buttonGhost} onClick={() => setShowHistory((s) => !s)}>
            {showHistory ? 'Hide' : 'Show'}
          </button>
        </div>
        {showHistory && (
          <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Employee</th>
                <th style={styles.th}>Item</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Resolved</th>
              </tr>
            </thead>
            <tbody>
              {historyIssues.map((i) => (
                <tr key={i.id}>
                  <td style={styles.td}>{empName(i.employee_id)}</td>
                  <td style={styles.td}>{itemName(i.item_id)}</td>
                  <td style={styles.td}>
                    <span style={styles.badge(i.status === 'broken' ? 'bad' : 'good')}>{i.status}</span>
                  </td>
                  <td style={styles.td}>{i.resolved_date || '—'}</td>
                </tr>
              ))}
              {historyIssues.length === 0 && (
                <tr>
                  <td style={styles.td} colSpan={4}>
                    No history yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {isAdmin && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Stock levels — {location}</div>
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
                <th style={styles.th}>On hand</th>
                <th style={styles.th}>Min</th>
                <th style={styles.th}>Max</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const stock = stockByItem[it.id]
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
                        defaultValue={stock?.qty_on_hand ?? 0}
                        onBlur={(e) => saveStock(it.id, 'qty_on_hand', e.target.value)}
                      />
                    </td>
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

function LinenTab({ role, items, stockByItem, movements, suppliers, location, onItemAdd, onItemUpdate, onItemRemove, onStockChange, onMovementAdd }) {
  const isAdmin = role === 'admin' || role === 'hradmin'
  const [itemForm, setItemForm] = useState({ name: '', category: 'Towels', size: '', supplier_id: '' })
  const [savingItem, setSavingItem] = useState(false)
  const [moveForm, setMoveForm] = useState({ item_id: '', qty: '', reason: 'Received', note: '' })
  const [logging, setLogging] = useState(false)

  async function addItem() {
    if (!itemForm.name.trim()) return
    setSavingItem(true)
    const [row] = await sb.insert('hr_linen_items', { ...itemForm, supplier_id: itemForm.supplier_id || null })
    setItemForm({ name: '', category: 'Towels', size: '', supplier_id: '' })
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
    const stock = stockByItem[itemId]
    const payload = {
      item_id: itemId,
      location_id: location,
      qty_on_hand: field === 'qty_on_hand' ? Number(value || 0) : stock?.qty_on_hand ?? 0,
      min_units: field === 'min_units' ? Number(value || 0) : stock?.min_units ?? 0,
      max_units: field === 'max_units' ? Number(value || 0) : stock?.max_units ?? 0,
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
    const stock = stockByItem[moveForm.item_id]
    const [stockRow] = await sb.upsert(
      'hr_linen_stock',
      {
        item_id: moveForm.item_id,
        location_id: location,
        qty_on_hand: (stock?.qty_on_hand ?? 0) + qtyChange,
        min_units: stock?.min_units ?? 0,
        max_units: stock?.max_units ?? 0,
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
      {isAdmin && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Add linen item</div>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
            Shared across all lodges — add each size as its own item (e.g. "Duvet Cover" size 'Queen'
            and size 'King' as two separate rows). Leave size blank if it doesn't apply.
          </div>
          <div style={styles.formGrid}>
            <div>
              <label style={styles.label}>Name</label>
              <input style={styles.input} value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} />
            </div>
            <div>
              <label style={styles.label}>Category</label>
              <select style={styles.input} value={itemForm.category} onChange={(e) => setItemForm({ ...itemForm, category: e.target.value })}>
                {LINEN_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={styles.label}>Size (optional)</label>
              <input style={styles.input} value={itemForm.size} onChange={(e) => setItemForm({ ...itemForm, size: e.target.value })} />
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
            {movements.slice(0, 30).map((m) => (
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
            {movements.length === 0 && (
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
                <th style={styles.th}>On hand</th>
                <th style={styles.th}>Min</th>
                <th style={styles.th}>Max</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const stock = stockByItem[it.id]
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
                        defaultValue={stock?.qty_on_hand ?? 0}
                        onBlur={(e) => saveStockField(it.id, 'qty_on_hand', e.target.value)}
                      />
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        style={styles.smallInput}
                        defaultValue={stock?.min_units ?? 0}
                        onBlur={(e) => saveStockField(it.id, 'min_units', e.target.value)}
                      />
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        style={styles.smallInput}
                        defaultValue={stock?.max_units ?? 0}
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

function OrdersTab({ uniformItems, uniformStockByItem, linenItems, linenStockByItem, supplierById }) {
  const [copiedKey, setCopiedKey] = useState(null)

  const toOrder = useMemo(() => {
    const uniforms = lowStockRows(uniformItems, uniformStockByItem).map((x) => ({ ...x, type: 'Uniform' }))
    const linen = lowStockRows(linenItems, linenStockByItem).map((x) => ({ ...x, type: 'Linen' }))
    return [...uniforms, ...linen]
  }, [uniformItems, uniformStockByItem, linenItems, linenStockByItem])

  const groups = useMemo(() => {
    const map = {}
    for (const row of toOrder) {
      const key = row.item.supplier_id || UNASSIGNED_SUPPLIER
      ;(map[key] ||= []).push(row)
    }
    const rows = Object.entries(map).map(([key, groupRows]) => ({
      key,
      supplier: key === UNASSIGNED_SUPPLIER ? null : supplierById[key],
      rows: groupRows,
    }))
    rows.sort((a, b) => {
      if (a.key === UNASSIGNED_SUPPLIER) return 1
      if (b.key === UNASSIGNED_SUPPLIER) return -1
      return (a.supplier?.name || '').localeCompare(b.supplier?.name || '')
    })
    return rows
  }, [toOrder, supplierById])

  async function copyGroup(group) {
    const text = group.rows
      .map((r) => `${r.item.name}${r.item.size ? ` (${r.item.size})` : ''}\t${fmt(Number(r.stock.max_units) - Number(r.stock.qty_on_hand), 0)}`)
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
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 4, padding: '0 2px' }}>
        {toOrder.length} item{toOrder.length === 1 ? '' : 's'} to order across uniforms and linen,
        grouped by supplier.
      </div>
      {groups.map((group) => (
        <div style={styles.card} key={group.key}>
          <div style={{ ...styles.row, justifyContent: 'space-between' }}>
            <div style={styles.cardTitle}>
              {group.supplier ? group.supplier.name : 'Unassigned'} ({group.rows.length})
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
              </tr>
            </thead>
            <tbody>
              {group.rows.map(({ item, stock, type }) => (
                <tr key={item.id}>
                  <td style={styles.td}>
                    {item.name} {item.size ? `(${item.size})` : ''}
                  </td>
                  <td style={styles.td}>{type}</td>
                  <td style={styles.tdNum}>{fmt(stock.qty_on_hand, 0)}</td>
                  <td style={styles.tdNum}>{fmt(stock.min_units, 0)}</td>
                  <td style={styles.tdNum}>{fmt(stock.max_units, 0)}</td>
                  <td style={styles.td}>
                    <strong>{fmt(Math.max(Number(stock.max_units) - Number(stock.qty_on_hand), 0), 0)}</strong>
                  </td>
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
