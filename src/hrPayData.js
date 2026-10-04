// Reading and writing contracts and bonuses now that their pay columns are
// write-only through the API (add_hr_pay_privacy.sql, 2026-10-04, #544).
//
//   - Reads name their columns (never `*`); the Owner then gets the pay
//     figures from get_hr_pay() and they are laid over the rows.
//   - Writes ask for nothing back (return=minimal) and read the row again by
//     id with the allowed columns. A new row's id is made here, so there is
//     something to read it back by.
//
// Works before the SQL has run too: the column-named read is valid either
// way, and if get_hr_pay() does not exist yet the Owner falls back to the old
// whole-row read, which still works until the SQL runs.
import { sb } from './sb.js'
import { supabase } from './supabaseClient.js'
import { BONUS_COLUMNS, BONUS_PAY_FIELDS, CONTRACT_COLUMNS, CONTRACT_PAY_FIELDS, mergePay, newRowId } from './payPrivacy.js'

async function ownerPay(companyId) {
  const { data, error } = await supabase.rpc('get_hr_pay', { p_company_id: companyId })
  if (error) return { ok: false }
  return { ok: true, contracts: data?.contracts || [], bonuses: data?.bonuses || [] }
}

export async function loadContractsAndBonuses({ companyId, canSeePay }) {
  const [contracts, bonuses] = await Promise.all([
    sb.select('hr_contracts', { company_id: companyId }, { select: CONTRACT_COLUMNS }),
    // .catch so a company that hasn't run add_hr_bonuses.sql yet still loads.
    sb.select('hr_bonuses', { company_id: companyId }, { select: BONUS_COLUMNS, order: 'bonus_date.desc' }).catch(() => []),
  ])
  if (!canSeePay) return { contracts: contracts || [], bonuses: bonuses || [] }

  const pay = await ownerPay(companyId)
  if (pay.ok) {
    return {
      contracts: mergePay(contracts, pay.contracts, CONTRACT_PAY_FIELDS),
      bonuses: mergePay(bonuses, pay.bonuses, BONUS_PAY_FIELDS),
    }
  }
  // get_hr_pay() not there yet = add_hr_pay_privacy.sql has not run, so the
  // whole-row read still works. Owner only.
  const [fullC, fullB] = await Promise.all([
    sb.select('hr_contracts', { company_id: companyId }, {}).catch(() => contracts),
    sb.select('hr_bonuses', { company_id: companyId }, { order: 'bonus_date.desc' }).catch(() => bonuses),
  ])
  return { contracts: fullC || [], bonuses: fullB || [] }
}

// Read one row back by id with the allowed columns, then put back the pay
// the Owner just typed (they are allowed to see it; the database will not
// hand it back on a plain read).
async function readBack(table, id, columns, payFields, written, canSeePay) {
  const [row] = (await sb.select(table, { id }, { select: columns })) || []
  if (!row) return null
  if (!canSeePay) return row
  const out = { ...row }
  for (const f of payFields) if (f in written) out[f] = written[f]
  return out
}

// carryPayFrom: the contract this one renews. When the HR manager (who
// cannot see pay) leaves pay boxes blank, carry_contract_pay() copies those
// figures from it on the server. The Owner sees the prefilled figures and
// types what they want, so nothing is carried for them.
export async function insertContract({ companyId, employeeId, patch, canSeePay, carryPayFrom }) {
  const id = newRowId()
  await sb.insert('hr_contracts', { id, company_id: companyId, employee_id: employeeId, ...patch }, { minimal: true })
  let warning = ''
  if (!canSeePay && carryPayFrom) {
    const { error } = await supabase.rpc('carry_contract_pay', { p_new_id: id, p_from_id: carryPayFrom })
    // The row is in either way, so report rather than throw.
    if (error) warning = `Contract added, but the pay from the previous contract could not be carried over (${error.message}). Ask the owner to fill it in.`
  }
  const row = await readBack('hr_contracts', id, CONTRACT_COLUMNS, CONTRACT_PAY_FIELDS, patch, canSeePay)
  return { row, warning }
}

export async function updateContract({ contract, patch, canSeePay }) {
  await sb.update('hr_contracts', { id: contract.id }, patch, { minimal: true })
  const row = await readBack('hr_contracts', contract.id, CONTRACT_COLUMNS, CONTRACT_PAY_FIELDS, patch, canSeePay)
  // Pay fields the Owner did not touch keep what the row already had.
  if (row && canSeePay) for (const f of CONTRACT_PAY_FIELDS) if (!(f in patch)) row[f] = contract[f] ?? null
  return row
}

export async function insertBonus({ companyId, bonus, canSeePay }) {
  const id = newRowId()
  await sb.insert('hr_bonuses', { id, company_id: companyId, ...bonus }, { minimal: true })
  return readBack('hr_bonuses', id, BONUS_COLUMNS, BONUS_PAY_FIELDS, bonus, canSeePay)
}

export async function removeBonus(id) {
  await sb.remove('hr_bonuses', { id }, { minimal: true })
}
