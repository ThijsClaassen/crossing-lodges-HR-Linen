// Appraisal pack per employee (#486, 2026-09-27). Pure — executed by
// tools/appraisal_test.mjs. No imports: the licence maths is repeated in
// miniature here rather than imported so this file stays testable in
// isolation; the test checks it agrees with qualifications.js.
//
// The pack is what an HR admin reads before and during an appraisal
// conversation: who the person is and on what contract, what the position
// asks and what they hold, how much leave and sick leave they took in the
// period, their off-day pattern and any extra days given, bonuses paid, and
// what was said last time. It is VIEWED on screen and PRINTED to PDF from a
// clean white page (appraisalHtml); the app never emails it.

const RANK = { A1: 1, A: 2, B: 10, EB: 11, C1: 20, C: 21, EC1: 30, EC: 31 }
const rank = (c) => RANK[String(c || '').toUpperCase()] || 0

const KIND_LABEL = {
  drivers_licence: "Driver's licence",
  pdp: 'PDP',
  first_aid: 'First aid',
  fgasa: 'FGASA',
  firearm: 'Firearm competency',
  other: 'Other',
}

// "drivers_licence:EC, pdp, first_aid , fgasa:1" → [{kind, category}]
export function parseRequiredQualifications(text) {
  return String(text || '')
    .split(/[,\n;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [kind, category] = s.split(':').map((x) => x.trim())
      return { kind: kind.toLowerCase().replace(/[^a-z_]/g, '_'), category: category || null }
    })
}

// For each requirement: held? (unexpired on `asOf`, class covers), which row.
export function checkRequirements(required, qualifications, asOf) {
  const held = (q) => !q.expires_on || !asOf || q.expires_on >= asOf
  return required.map((req) => {
    const candidates = (qualifications || []).filter((q) => q.kind === req.kind)
    const ok = candidates.filter(held).filter((q) => {
      if (!req.category) return true
      if (req.kind === 'drivers_licence') return rank(q.category) >= rank(req.category)
      return String(q.category || '').toLowerCase() === String(req.category).toLowerCase()
    })
    const best = ok.sort((a, b) => rank(b.category) - rank(a.category))[0] || null
    const expiredOnly = !best && candidates.length > 0 && candidates.every((q) => !held(q))
    return {
      kind: req.kind,
      category: req.category,
      label: `${KIND_LABEL[req.kind] || req.kind}${req.category ? ` (${req.kind === 'drivers_licence' ? 'Code ' : ''}${req.category})` : ''}`,
      met: !!best,
      detail: best
        ? `${best.category ? `${best.kind === 'drivers_licence' ? 'Code ' : ''}${best.category}` : 'held'}${best.expires_on ? `, expires ${best.expires_on}` : ''}`
        : expiredOnly
          ? 'expired'
          : candidates.length
            ? 'held, but not the class required'
            : 'not on file',
    }
  })
}

const inPeriod = (row, from, to) => {
  const s = String(row.start_date).slice(0, 10)
  const e = String(row.end_date || row.start_date).slice(0, 10)
  return e >= from && s <= to
}

// Leave taken in the period, by type, with the rows.
export function leaveInPeriod(leaveRows, employeeId, from, to) {
  const rows = (leaveRows || []).filter((l) => l.employee_id === employeeId && inPeriod(l, from, to))
  const byType = {}
  for (const l of rows) {
    const t = l.leave_type || 'annual'
    byType[t] = (byType[t] || 0) + Number(l.days_used || 0)
  }
  // Sick leave episodes matter as much as days: five single days say
  // something different from one five-day illness.
  const sickEpisodes = rows.filter((l) => (l.leave_type || 'annual') === 'sick').length
  return { rows: rows.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date))), byType, sickEpisodes }
}

export function buildAppraisalPack({
  employee, contract, position, requirements, qualifications = [], leaveRows = [], offDays = [], bonuses = [],
  previousAppraisals = [], patternText, from, to, asOf, feedbackTrend = null,
}) {
  const name = `${employee.first_name || ''} ${employee.last_name || ''}`.trim()
  const req = parseRequiredQualifications(requirements?.required_qualifications)
  const checks = checkRequirements(req, qualifications, asOf || to)
  const leave = leaveInPeriod(leaveRows, employee.id, from, to)
  const extras = (offDays || []).filter((d) => d.employee_id === employee.id && String(d.off_date).slice(0, 10) >= from && String(d.off_date).slice(0, 10) <= to)
  const bonus = (bonuses || []).filter((b) => b.employee_id === employee.id && String(b.bonus_date).slice(0, 10) >= from && String(b.bonus_date).slice(0, 10) <= to)
  const requirementLines = String(requirements?.requirements || '').split('\n').map((s) => s.trim()).filter(Boolean)

  return {
    title: `Appraisal pack — ${name}`,
    name,
    period: { from, to },
    person: [
      ['Position', position || employee.position || '—'],
      ['Department', employee.department || '—'],
      ['Started', employee.start_date || '—'],
      ['Contract', contract ? `${contract.contract_type || '—'}, ${contract.start_date || '?'} → ${contract.end_date || 'open-ended'}` : '— no contract on file'],
    ],
    requirementLines,
    checks,
    qualifications: (qualifications || []).map((q) => ({
      label: `${q.title || `${q.category ? `${q.kind === 'drivers_licence' ? 'Code ' : ''}${q.category} ` : ''}${KIND_LABEL[q.kind] || q.kind}`}`,
      expires: q.expires_on || 'no expiry',
      expired: !!q.expires_on && q.expires_on < (asOf || to),
    })),
    leave,
    pattern: patternText || '—',
    extraOffDays: extras.map((d) => ({ date: String(d.off_date).slice(0, 10), note: d.note || '' })),
    bonuses: bonus.map((b) => ({ date: String(b.bonus_date).slice(0, 10), amount: Number(b.amount || 0), type: b.bonus_type || '', note: b.note || '' })),
    // Guest feedback (#487): the department's trend, never a personal score.
    feedbackTrend: feedbackTrend && feedbackTrend.categories?.length ? feedbackTrend : null,
    previous: (previousAppraisals || [])
      .filter((a) => a.employee_id === employee.id)
      .sort((a, b) => String(b.appraisal_date).localeCompare(String(a.appraisal_date)))
      .slice(0, 3),
  }
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const zar = (n) => `R ${Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const LEAVE_LABEL = { annual: 'Annual leave', sick: 'Sick leave', family_responsibility: 'Family responsibility', maternity: 'Maternity' }

// A clean, white, printable page. Opened in a new window and printed from
// there so the app's dark theme never reaches the paper.
export function appraisalHtml(pack, { companyName = '', preparedBy = '' } = {}) {
  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`
  const leaveRows = Object.entries(pack.leave.byType).map(([t, d]) => row(LEAVE_LABEL[t] || t, `${d} day${d === 1 ? '' : 's'}${t === 'sick' ? ` (${pack.leave.sickEpisodes} episode${pack.leave.sickEpisodes === 1 ? '' : 's'})` : ''}`)).join('')
  const leaveDetail = pack.leave.rows.map((l) => `<tr><td>${esc(l.start_date)} → ${esc(l.end_date || l.start_date)}</td><td>${esc(LEAVE_LABEL[l.leave_type || 'annual'] || l.leave_type)}</td><td class="n">${esc(l.days_used)}</td><td>${esc(l.note || '')}</td></tr>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(pack.title)}</title>
<style>
  body{font-family:Inter,Helvetica,Arial,sans-serif;color:#111;margin:32px;font-size:13px}
  h1{font-size:20px;margin:0 0 2px} h2{font-size:14px;margin:18px 0 6px;border-bottom:1px solid #999;padding-bottom:2px}
  .sub{color:#555;margin-bottom:12px}
  table{border-collapse:collapse;width:100%} th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #ddd;vertical-align:top}
  th{width:220px;font-weight:600;color:#333} .n{text-align:right} .ok{color:#1b7f3b;font-weight:600} .no{color:#b3261e;font-weight:600}
  .box{border:1px solid #bbb;min-height:70px;padding:6px;margin-top:4px;white-space:pre-wrap}
  .conf{font-size:11px;color:#777;margin-top:24px}
  @media print{body{margin:12mm}}
</style></head><body>
<h1>${esc(pack.title)}</h1>
<div class="sub">${esc(companyName)} · period ${esc(pack.period.from)} to ${esc(pack.period.to)}${preparedBy ? ` · prepared by ${esc(preparedBy)}` : ''}</div>

<h2>Person and contract</h2>
<table>${pack.person.map(([k, v]) => row(k, v)).join('')}</table>

<h2>Position requirements vs held</h2>
${pack.requirementLines.length ? `<ul>${pack.requirementLines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '<p><em>No requirements written for this position yet.</em></p>'}
${pack.checks.length ? `<table>${pack.checks.map((c) => `<tr><th>${esc(c.label)}</th><td class="${c.met ? 'ok' : 'no'}">${c.met ? '✓' : '✗'} ${esc(c.detail)}</td></tr>`).join('')}</table>` : ''}

<h2>Licences and qualifications on file</h2>
${pack.qualifications.length ? `<table>${pack.qualifications.map((q) => `<tr><th>${esc(q.label)}</th><td class="${q.expired ? 'no' : ''}">${q.expired ? 'EXPIRED ' : 'expires '}${esc(q.expires)}</td></tr>`).join('')}</table>` : '<p><em>Nothing on file.</em></p>'}

<h2>Leave in the period</h2>
${leaveRows ? `<table>${leaveRows}</table>` : '<p><em>No leave taken.</em></p>'}
${leaveDetail ? `<table style="margin-top:8px"><tr><th style="width:auto">Dates</th><th style="width:auto">Type</th><th style="width:auto" class="n">Days</th><th style="width:auto">Note</th></tr>${leaveDetail}</table>` : ''}

<h2>Working pattern</h2>
<table>${row('Pattern', pack.pattern)}${row('Extra off days given', pack.extraOffDays.length ? pack.extraOffDays.map((d) => `${d.date}${d.note ? ` (${d.note})` : ''}`).join(', ') : 'none')}</table>

<h2>Bonuses in the period</h2>
${pack.bonuses.length ? `<table>${pack.bonuses.map((b) => row(`${b.date}${b.type ? ` — ${b.type}` : ''}`, `${zar(b.amount)}${b.note ? ` — ${b.note}` : ''}`)).join('')}</table>` : '<p><em>None.</em></p>'}

${pack.feedbackTrend ? `<h2>Guest feedback — department trend (${esc(pack.feedbackTrend.categories.join(', '))})</h2>
<p style="color:#555;margin:0 0 6px">Average guest score for the department at the lodges where this person was rostered. It describes the department's weeks, not the person.</p>
${pack.feedbackTrend.months.length ? `<table>${pack.feedbackTrend.months.map((m) => row(m.month, `${m.avg} (${m.n} answers)`)).join('')}</table>` : '<p><em>No feedback in the period.</em></p>'}` : ''}

<h2>Previous appraisals</h2>
${pack.previous.length ? pack.previous.map((a) => `<table>${row('Date', `${a.appraisal_date}${a.appraiser ? ` — ${a.appraiser}` : ''}${a.rating ? ` — ${a.rating}` : ''}`)}${a.strengths ? row('Strengths', a.strengths) : ''}${a.development ? row('Development', a.development) : ''}${a.agreed_actions ? row('Agreed actions', a.agreed_actions) : ''}${a.notes ? row('Notes', a.notes) : ''}</table><br>`).join('') : '<p><em>First appraisal on record.</em></p>'}

<h2>This conversation</h2>
<div>Strengths</div><div class="box"></div>
<div>Development</div><div class="box"></div>
<div>Agreed actions</div><div class="box"></div>
<div class="conf">Confidential — HR. Contains leave and sick-leave records of a named person; store accordingly.</div>
</body></html>`
}
