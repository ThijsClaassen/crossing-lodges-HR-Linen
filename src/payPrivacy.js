// Pay figures in the HR app: Owners only (2026-10-04, task #544, roles step 4).
//
// Thijs: pay per person is for Owners only; the HR manager keeps Contracts,
// Leave, Loans and Appraisals without pay figures, but "can also enter new
// salaries". add_hr_pay_privacy.sql enforces that in the database: the pay
// columns can be written but not read through the API, and Owners read them
// through get_hr_pay(). This file is the app's half — pure, so
// tools/pay_privacy_test.mjs runs it directly.

// The columns the database will no longer hand back on a plain read.
export const CONTRACT_PAY_FIELDS = ['salary', 'medical_aid_monthly_cost', 'pension_fund_monthly_cost', 'housing_monthly_cost']
export const BONUS_PAY_FIELDS = ['amount']

// What may be selected. Never `*`: one pay column in the list and the whole
// read is refused.
export const CONTRACT_COLUMNS = 'id,company_id,employee_id,contract_type,start_date,end_date,medical_aid,medical_aid_scheme,pension_fund,pension_fund_name,notes,created_at'
export const BONUS_COLUMNS = 'id,company_id,employee_id,bonus_date,bonus_type,note,created_at'

// Who sees pay: the Owner (a platform admin counts as Owner, as in
// company_profile()).
export const canSeePayFor = ({ profile, isPlatformAdmin }) => !!isPlatformAdmin || profile === 'owner'

// Who gets the HR app's confidential tabs (Contracts, Loans, Appraisals,
// Staff cost): anyone with an hr_admins row, and Owners — whatever their
// admin/staff tier. The HR manager is staff tier with an hr_admins row; the
// old rule (admin AND hr admin) left them with the plain staff view.
export const isHrAdminFor = ({ profile, isPlatformAdmin, hasHrAdminRow }) => !!isPlatformAdmin || !!hasHrAdminRow || profile === 'owner'
export const hrRoleFor = ({ baseRole, isHrAdmin }) => (isHrAdmin ? 'hradmin' : baseRole)

// Lay the Owner's pay figures (from get_hr_pay) over rows that came back
// without them. Rows with no pay entry keep their fields absent (undefined),
// which the screens show as "hidden" rather than R 0.
export function mergePay(rows, payRows, fields) {
  const byId = new Map((payRows || []).map((p) => [p.id, p]))
  return (rows || []).map((r) => {
    const p = byId.get(r.id)
    if (!p) return r
    const out = { ...r }
    for (const f of fields) out[f] = p[f] ?? null
    return out
  })
}

// Strip pay off rows — what an HR manager's copy of the data looks like.
export function withoutPay(rows, fields) {
  return (rows || []).map((r) => {
    const out = { ...r }
    for (const f of fields) delete out[f]
    return out
  })
}

// The pay part of a contract save.
//   Owner: every pay field, blank = cleared (as before).
//   HR manager: a pay field is only sent when something was typed into it.
//     They cannot see the stored figure, so a blank box means "leave it",
//     never "clear it" — otherwise saving a contract to fix its end date
//     would wipe the salary.
export function contractPayPatch(form, { canSeePay }) {
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v))
  const out = {}
  for (const f of CONTRACT_PAY_FIELDS) {
    const v = form[f]
    if (canSeePay) out[f] = num(v)
    else if (v !== '' && v !== null && v !== undefined) out[f] = num(v)
  }
  return out
}

// A row's pay as shown: a figure, or null when hidden from this user.
export const payShown = (row, field, canSeePay) => (canSeePay ? Number(row?.[field] || 0) : null)

// A client-made id, so a new row can be written without asking the database
// to hand it back (that hand-back would include the pay columns).
export function newRowId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  // RFC 4122 v4 fallback for very old browsers.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}
