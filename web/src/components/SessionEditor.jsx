import { Rank } from './Bits.jsx'
import { dayMonth, dayNum } from '../lib/dates.js'
import './SessionEditor.css'

export default function SessionEditor({ session, roster, idx, availableIds, busy, onSlot, onCancel, onRestore }) {
  const cancelled = session.status === 'cancelled'
  const availSet = new Set(availableIds)
  const bySlot = new Map(session.assignments.map((a) => [`${a.roleId}:${a.slot}`, a]))
  const inSession = new Map(session.assignments.map((a) => [a.personId, a.roleId]))
  // Warnings that point at a specific slot (roleId + slot, or personId as fallback).
  const slotWarns = new Map()
  for (const w of session.warnings || []) {
    if (!w.roleId) continue
    let slot = Number.isInteger(w.slot) ? w.slot : null
    if (slot === null && w.personId) slot = session.assignments.find((a) => a.personId === w.personId && a.roleId === w.roleId)?.slot ?? null
    if (slot === null) continue
    const k = `${w.roleId}:${slot}`
    slotWarns.set(k, [...(slotWarns.get(k) || []), w])
  }
  const warnCount = session.warnings?.length || 0

  return (
    <article className={`se ${cancelled ? 'cancelled' : ''}`}>
      <header className="se-head">
        <div className="se-date">
          <span className="day">{dayNum(session.date)}</span>
          <span className="mono">{dayMonth(session.date).slice(3)} / {session.date}</span>
        </div>
        <div className="se-stamps">
          {cancelled ? <span className="stamp signal solid">Cancelled</span> : <span className="stamp">Scheduled</span>}
          {warnCount > 0 && <span className="stamp signal">{warnCount} warn</span>}
          {cancelled
            ? <button className="btn small" disabled={busy} onClick={onRestore}>Restore</button>
            : <button className="btn small danger" disabled={busy} onClick={onCancel}>Cancel</button>}
        </div>
      </header>

      {cancelled ? (
        <p className="se-reason"><span className="label">Reason</span> {session.cancelReason || 'No reason recorded.'}</p>
      ) : (
        <div className="se-body">
          {roster.ministries.filter((m) => m.active).map((m) => (
            <div key={m.id} className="se-min">
              <h4 className="label">{m.name}</h4>
              {m.roles.filter((r) => r.active).flatMap((r) =>
                Array.from({ length: r.max }, (_, slot) => {
                  const a = bySlot.get(`${r.id}:${slot}`)
                  const cur = a?.personId || ''
                  const holders = roster.people.filter((p) => p.active && p.roles.includes(r.id))
                  const avail = holders.filter((p) => availSet.has(p.id))
                  const unavail = holders.filter((p) => !availSet.has(p.id))
                  const stray = cur && !holders.some((p) => p.id === cur) ? idx.people.get(cur) : null
                  const opt = (p) => {
                    const other = inSession.get(p.id)
                    const swap = other && !(other === r.id && p.id === cur) ? ' [SWAP]' : ''
                    return <option key={p.id} value={p.id}>{p.name} / R{p.rank}{swap}</option>
                  }
                  const required = slot < r.min
                  const sw = slotWarns.get(`${r.id}:${slot}`) || []
                  return (
                    <div key={`${r.id}:${slot}`} className={`slot ${(required && !cur) || sw.length ? 'gap' : ''}`}>
                      <span className="label sl-name">
                        {r.name}{r.max > 1 ? ` ${slot + 1}/${r.max}` : ''}
                        {required && <i className="req" title="Required">*</i>}
                      </span>
                      <select className="field sel" value={cur} disabled={busy} aria-label={`${r.name} slot ${slot + 1}`}
                        onChange={(e) => onSlot(r.id, slot, e.target.value || null)}>
                        <option value="">-- empty --</option>
                        {stray && <optgroup label="Not eligible"><option value={cur}>{stray.name} / R{stray.rank}</option></optgroup>}
                        <optgroup label="Available">{avail.map(opt)}</optgroup>
                        <optgroup label="Unavailable">{unavail.map(opt)}</optgroup>
                      </select>
                      <span className="sl-meta">
                        {a?.locked && <span className="stamp solid">Locked</span>}
                        {sw.map((w, i) => <span key={i} className="stamp signal" title={w.message}>{w.code.replace(/_/g, ' ')}</span>)}
                        {cur && idx.people.get(cur) && (
                          <>
                            <Rank rank={idx.people.get(cur).rank} />
                            {!availSet.has(cur) && <span className="stamp signal">Unavail</span>}
                          </>
                        )}
                      </span>
                    </div>
                  )
                }),
              )}
            </div>
          ))}
        </div>
      )}
    </article>
  )
}
