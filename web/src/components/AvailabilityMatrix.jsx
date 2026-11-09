import { useMemo, useState } from 'react'
import { api } from '../api.js'
import { dayMonth } from '../lib/dates.js'
import { Rank } from './Bits.jsx'
import './AvailabilityMatrix.css'

export default function AvailabilityMatrix({ month, sessions, people, map, setMap, onChanged, onError }) {
  const [q, setQ] = useState('')
  const [pending, setPending] = useState(new Set())
  const dates = sessions.map((s) => s.date)
  const cancelled = new Set(sessions.filter((s) => s.status === 'cancelled').map((s) => s.date))

  const sets = useMemo(() => Object.fromEntries(dates.map((d) => [d, new Set(map[d] || [])])), [dates, map])
  const rows = people.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()))

  async function toggle(p, date) {
    const key = `${p.id}:${date}`
    if (pending.has(key)) return
    const next = dates.filter((d) => (d === date ? !sets[d].has(p.id) : sets[d].has(p.id)))
    setPending((s) => new Set(s).add(key))
    onError(null)
    try {
      const res = await api.saveDates(month, p.id, next)
      const saved = new Set(res.dates)
      const copy = { ...map }
      for (const d of dates) {
        const ids = new Set(copy[d] || [])
        saved.has(d) ? ids.add(p.id) : ids.delete(p.id)
        copy[d] = [...ids]
      }
      setMap(copy)
      onChanged?.()
    } catch (e) {
      onError(e.message)
    } finally {
      setPending((s) => { const n = new Set(s); n.delete(key); return n })
    }
  }

  return (
    <div className="mx">
      <div className="mx-tools">
        <input className="field" type="search" placeholder="Filter names" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter names" />
        <span className="label">Click a cell to toggle. Saves immediately.</span>
      </div>
      <div className="scroll-x">
        <table className="mx-t">
          <thead>
            <tr>
              <th className="who" scope="col">Person</th>
              {dates.map((d) => (
                <th key={d} className={cancelled.has(d) ? 'x' : ''}>
                  <span className="mono">{dayMonth(d)}</span>
                  <span className="n" title={`${sets[d].size} available`}>{sets[d].size} avail</span>
                </th>
              ))}
              <th className="tot" scope="col" title="Saturdays available">Tot</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const total = dates.filter((d) => sets[d].has(p.id)).length
              return (
                <tr key={p.id}>
                  <th className="who" scope="row"><span>{p.name}</span><Rank rank={p.rank} /></th>
                  {dates.map((d) => {
                    const on = sets[d].has(p.id)
                    const busy = pending.has(`${p.id}:${d}`)
                    return (
                      <td key={d} className={cancelled.has(d) ? 'x' : ''}>
                        <button type="button" className={`c ${on ? 'on' : ''}`} aria-pressed={on} disabled={busy}
                          aria-label={`${p.name} ${dayMonth(d)}`} onClick={() => toggle(p, d)}>
                          {busy ? '.' : on ? 'X' : ''}
                        </button>
                      </td>
                    )
                  })}
                  <td className="tot mono">{total}</td>
                </tr>
              )
            })}
            {rows.length === 0 && <tr><td colSpan={dates.length + 2} className="label none">No match</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
