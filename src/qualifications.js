// Staff licences and qualifications (#484, 2026-09-27).
//
// Pure helpers on top, storage/REST helpers below. The pure part is what
// tools/qualifications_test.mjs executes, so keep it free of imports.

// Calendar date helpers, inlined (not imported from ./dates.js) because the
// tests load this file on its own. Same code as src/dates.js.
function isoDate(d) {
  const x = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(x.getTime())) return null
  return `${String(x.getFullYear()).padStart(4, '0')}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

export const QUALIFICATION_KINDS = [
  { id: 'drivers_licence', label: "Driver's licence", hasClass: true },
  { id: 'pdp', label: 'PDP (professional driving permit)' },
  { id: 'first_aid', label: 'First aid' },
  { id: 'fgasa', label: 'FGASA', hasClass: true },
  { id: 'firearm', label: 'Firearm competency' },
  { id: 'other', label: 'Other' },
]
export const KIND_LABEL = Object.fromEntries(QUALIFICATION_KINDS.map((k) => [k.id, k.label]))

// South African driving licence codes, lowest to highest. A higher code
// covers the ones below it in the same family — EC may drive anything B may.
// Same table as licence_class_rank() in add_hr_qualifications.sql; the two
// must agree, and the test checks they do.
export const LICENCE_CLASSES = ['A1', 'A', 'B', 'EB', 'C1', 'C', 'EC1', 'EC']
export function licenceRank(cls) {
  const i = LICENCE_CLASSES.indexOf(String(cls || '').toUpperCase())
  return i < 0 ? 0 : [1, 2, 10, 11, 20, 21, 30, 31][i]
}
export function classCovers(held, required) {
  if (!required) return true
  return licenceRank(held) >= licenceRank(required)
}

// Days from `today` to the expiry: negative = expired, null = never expires.
export function daysToExpiry(q, today = new Date()) {
  if (!q?.expires_on) return null
  const t = new Date(isoDate(today))
  const e = new Date(q.expires_on)
  return Math.round((e - t) / 86400000)
}

// One of 'expired' | 'soon' | 'ok' | 'none'. "Soon" is within `window` days,
// 60 by default — the same horizon the contracts and fleet panels use.
export function expiryStatus(q, today = new Date(), window = 60) {
  const d = daysToExpiry(q, today)
  if (d === null) return 'none'
  if (d < 0) return 'expired'
  if (d <= window) return 'soon'
  return 'ok'
}

export function expiryLabel(q, today = new Date()) {
  const d = daysToExpiry(q, today)
  if (d === null) return 'does not expire'
  if (d < 0) return `expired ${-d} day${-d === 1 ? '' : 's'} ago`
  if (d === 0) return 'expires today'
  return `in ${d} day${d === 1 ? '' : 's'}`
}

// Rows for the dashboard card: expired first, then coming up, each sorted so
// the most urgent leads. Mirrors the contracts card (#423).
export function groupByUrgency(qualifications, today = new Date(), window = 60) {
  const withDays = qualifications
    .map((q) => ({ q, days: daysToExpiry(q, today) }))
    .filter((x) => x.days !== null && x.days <= window)
    .sort((a, b) => a.days - b.days)
  return { expired: withDays.filter((x) => x.days < 0), upcoming: withDays.filter((x) => x.days >= 0) }
}

// A short human line for a row: "Code EC driver's licence · 12345 · expires
// 03 Mar 2027".
export function describeQualification(q) {
  const kind = KIND_LABEL[q.kind] || q.kind
  const head = q.title || (q.category ? `${q.kind === 'drivers_licence' ? 'Code ' : ''}${q.category} ${kind}` : kind)
  return head
}

// The employee's best current driver's licence: highest class, unexpired
// preferred. Used by the employee row badge and the appraisal pack.
export function bestLicence(qualifications, today = new Date()) {
  const lic = qualifications.filter((q) => q.kind === 'drivers_licence')
  if (lic.length === 0) return null
  return [...lic].sort((a, b) => {
    const ea = expiryStatus(a, today) === 'expired' ? 1 : 0
    const eb = expiryStatus(b, today) === 'expired' ? 1 : 0
    return ea - eb || licenceRank(b.category) - licenceRank(a.category)
  })[0]
}

// ---------------------------------------------------------------------------
// Storage + REST (browser only)
// ---------------------------------------------------------------------------
export const HR_DOCS_BUCKET = 'hr-documents'

export async function uploadQualificationFile({ supabase, companyId, file }) {
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
  const path = `${companyId}/hr/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from(HR_DOCS_BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false })
  if (error) throw new Error(`Could not upload the document: ${error.message}`)
  return path
}

export async function qualificationFileUrl({ supabase, storagePath }) {
  const { data, error } = await supabase.storage.from(HR_DOCS_BUCKET).createSignedUrl(storagePath, 600)
  if (error) throw new Error(error.message)
  return data.signedUrl
}

export async function removeQualificationFile({ supabase, storagePath }) {
  if (!storagePath) return
  await supabase.storage.from(HR_DOCS_BUCKET).remove([storagePath])
}
