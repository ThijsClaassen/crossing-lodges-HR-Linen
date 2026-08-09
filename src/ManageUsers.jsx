// HR Admin-only screen for creating logins and resetting passwords without
// needing a real email address on file — added 2026-08-09 as the pilot for
// username-based login (Thijs: "not every user will have an email address,
// but then we/the company's admin can assign a username with password").
//
// Two moving parts, each with a different security model:
//  - Creating a user needs Supabase's Admin API (auth.admin.createUser),
//    which requires the service-role key. That key can never live in
//    client-side code, so this calls the `admin-create-user` Edge Function
//    instead, which checks the caller is an HR Admin for the target company
//    before doing anything privileged. See supabase/admin-create-user.ts.
//  - Resetting a password doesn't need the Admin API — it's a single-column
//    UPDATE on auth.users.encrypted_password, so that's a plain Postgres
//    function (admin_reset_password, see add_username_login.sql) that does
//    its own is_hr_admin() check server-side. No Edge Function needed.
//
// Username-only accounts get a synthetic, never-emailed placeholder address
// (username@users.crossinglodges.internal) so Supabase Auth — which always
// requires *some* email — still works. If a real email is given instead,
// the user can log in with either their email or their username.
import { useCallback, useEffect, useState } from 'react'
import { supabase, SUPABASE_URL } from './supabaseClient.js'
import { colors, fonts } from './theme.js'

const styles = {
  card: {
    background: colors.panel,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    maxWidth: '100%',
    boxSizing: 'border-box',
  },
  cardTitle: {
    fontFamily: fonts.heading,
    fontSize: 19,
    fontWeight: 600,
    marginBottom: 10,
    color: colors.goldLt,
  },
  hint: { fontSize: 12, color: colors.muted, marginBottom: 12, lineHeight: 1.5 },
  formGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: 8,
    marginBottom: 10,
    alignItems: 'end',
  },
  label: { fontSize: 11, color: colors.muted, marginBottom: 3, display: 'block' },
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
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  checkboxLabel: { fontSize: 13, color: colors.cream, display: 'flex', alignItems: 'center', gap: 6 },
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
    padding: '6px 10px',
    borderRadius: 6,
    border: `1px solid ${colors.gold}`,
    background: 'transparent',
    color: colors.goldLt,
    fontWeight: 600,
    fontSize: 12,
    cursor: 'pointer',
  },
  error: { color: colors.danger, fontSize: 12, marginTop: 8 },
  success: { color: colors.ok, fontSize: 12, marginTop: 8 },
  tableWrap: { overflowX: 'auto', WebkitOverflowScrolling: 'touch' },
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
}

function randomPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let out = ''
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

export default function ManageUsers({ companyId }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [username, setUsername] = useState('')
  const [realEmail, setRealEmail] = useState('')
  const [password, setPassword] = useState(randomPassword())
  const [role, setRole] = useState('staff')
  const [grantHrAdmin, setGrantHrAdmin] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createSuccess, setCreateSuccess] = useState('')

  const [resetTarget, setResetTarget] = useState(null)
  const [resetPassword, setResetPassword] = useState('')
  const [resetBusy, setResetBusy] = useState(false)
  const [resetError, setResetError] = useState('')

  const loadUsers = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    setLoadError('')
    const { data, error } = await supabase.rpc('list_company_users', { p_company_id: companyId })
    if (error) setLoadError(error.message)
    else setUsers(data || [])
    setLoading(false)
  }, [companyId])

  useEffect(() => {
    loadUsers()
  }, [loadUsers])

  async function handleCreate(e) {
    e.preventDefault()
    setCreateError('')
    setCreateSuccess('')

    const trimmedUsername = username.trim().toLowerCase()
    if (!/^[a-z0-9._-]{3,32}$/.test(trimmedUsername)) {
      setCreateError('Username must be 3-32 characters: lowercase letters, numbers, dot, underscore, hyphen.')
      return
    }
    if (password.length < 8) {
      setCreateError('Password must be at least 8 characters.')
      return
    }

    setCreating(true)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-create-user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token || ''}`,
        },
        body: JSON.stringify({
          username: trimmedUsername,
          password,
          companyId,
          role,
          isHrAdmin: role === 'admin' && grantHrAdmin,
          realEmail: realEmail.trim() || undefined,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Could not create user.')

      setCreateSuccess(`Created "${trimmedUsername}" — share the password with them directly (it isn't emailed).`)
      setUsername('')
      setRealEmail('')
      setPassword(randomPassword())
      setRole('staff')
      setGrantHrAdmin(false)
      loadUsers()
    } catch (err) {
      setCreateError(err.message || 'Could not create user.')
    } finally {
      setCreating(false)
    }
  }

  async function handleResetPassword(e) {
    e.preventDefault()
    setResetError('')
    if (resetPassword.length < 8) {
      setResetError('Password must be at least 8 characters.')
      return
    }
    setResetBusy(true)
    const { error } = await supabase.rpc('admin_reset_password', {
      p_user_id: resetTarget.user_id,
      p_new_password: resetPassword,
      p_company_id: companyId,
    })
    setResetBusy(false)
    if (error) {
      setResetError(error.message)
      return
    }
    setResetTarget(null)
    setResetPassword('')
  }

  return (
    <div>
      <div style={styles.card}>
        <div style={styles.cardTitle}>Add a user</div>
        <div style={styles.hint}>
          Give someone a username and password instead of an email — useful for staff who don't have an email
          address. They log in with the username on the login screen. You can also set a real email instead if
          they have one; either way works to log in.
        </div>
        <form onSubmit={handleCreate}>
          <div style={styles.formGrid}>
            <div>
              <label style={styles.label}>Username</label>
              <input
                style={styles.input}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. jsmith"
              />
            </div>
            <div>
              <label style={styles.label}>Real email (optional)</label>
              <input
                style={styles.input}
                type="email"
                value={realEmail}
                onChange={(e) => setRealEmail(e.target.value)}
                placeholder="leave blank if none"
              />
            </div>
            <div>
              <label style={styles.label}>Password</label>
              <div style={styles.row}>
                <input style={{ ...styles.input, flex: 1 }} value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" style={styles.buttonGhost} onClick={() => setPassword(randomPassword())}>
                  Generate
                </button>
              </div>
            </div>
            <div>
              <label style={styles.label}>Role</label>
              <select style={styles.input} value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="staff">Staff</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>
          {role === 'admin' && (
            <label style={{ ...styles.checkboxLabel, marginBottom: 10 }}>
              <input type="checkbox" checked={grantHrAdmin} onChange={(e) => setGrantHrAdmin(e.target.checked)} />
              Also grant HR Admin (Contracts access)
            </label>
          )}
          {createError && <div style={styles.error}>{createError}</div>}
          {createSuccess && <div style={styles.success}>{createSuccess}</div>}
          <button type="submit" style={styles.button} disabled={creating}>
            {creating ? 'Creating…' : 'Create user'}
          </button>
        </form>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Users in this company</div>
        {loadError && <div style={styles.error}>{loadError}</div>}
        {loading ? (
          <div style={{ color: colors.muted, fontSize: 13 }}>Loading…</div>
        ) : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Username</th>
                  <th style={styles.th}>Email</th>
                  <th style={styles.th}>Role</th>
                  <th style={styles.th}>HR Admin</th>
                  <th style={styles.th}></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.user_id}>
                    <td style={styles.td}>{u.username || '—'}</td>
                    <td style={styles.td}>{u.email}</td>
                    <td style={styles.td}>{u.role}</td>
                    <td style={styles.td}>{u.is_hr_admin ? 'Yes' : ''}</td>
                    <td style={styles.td}>
                      <button
                        style={styles.buttonGhost}
                        onClick={() => {
                          setResetTarget(u)
                          setResetPassword(randomPassword())
                          setResetError('')
                        }}
                      >
                        Reset password
                      </button>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td style={styles.td} colSpan={5}>
                      No users found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {resetTarget && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Reset password for {resetTarget.username || resetTarget.email}</div>
          <form onSubmit={handleResetPassword}>
            <div style={styles.formGrid}>
              <div>
                <label style={styles.label}>New password</label>
                <div style={styles.row}>
                  <input
                    style={{ ...styles.input, flex: 1 }}
                    value={resetPassword}
                    onChange={(e) => setResetPassword(e.target.value)}
                  />
                  <button type="button" style={styles.buttonGhost} onClick={() => setResetPassword(randomPassword())}>
                    Generate
                  </button>
                </div>
              </div>
            </div>
            {resetError && <div style={styles.error}>{resetError}</div>}
            <div style={styles.row}>
              <button type="submit" style={styles.button} disabled={resetBusy}>
                {resetBusy ? 'Saving…' : 'Save new password'}
              </button>
              <button type="button" style={styles.buttonGhost} onClick={() => setResetTarget(null)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
