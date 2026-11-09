import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { api, adminCode } from '../api.js'
import { indexRoster, useLoader, useMonth, useRoster } from '../lib/useAsync.js'
import { dayMonth, dayNum, fullDate, monthLabel } from '../lib/dates.js'
import { ErrorBox, Loading, Rank, WindowStamp } from '../components/Bits.jsx'
import './Availability.css'

export default function Availability() {
  const { status } = useOutletContext()
  const roster = useRoster()
  const month = status?.targetMonth
  const monthData = useMonth(month)

  if (roster.error) return <ErrorBox error={roster.error} onRetry={roster.reload} />
  if (monthData.error) return <ErrorBox error={monthData.error} onRetry={monthData.reload} />
  if (!status || !roster.data || !monthData.data) return <Loading what="Opening form" />

  return <Form status={status} roster={roster.data} sessions={monthData.data.sessions} />
}

function Form({ status, roster, sessions }) {
  const { window: win, targetMonth: month } = status
  const isAdmin = !!adminCode.get()
  const canEdit = win.state === 'open' || isAdmin

  const [query, setQuery] = useState('')
  const [personId, setPersonId] = useState('')
  const [picked, setPicked] = useState(new Set())
  const [saved, setSaved] = useState(null) // last-saved date list as string
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null) // {kind, text}

  const idx = useMemo(() => indexRoster(roster), [roster])
  const people = roster.people.filter((p) => p.active)
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? people.filter((p) => p.name.toLowerCase().includes(q)) : people
  }, [people, query])

  const existing = useLoader(
    () => (personId ? api.personDates(month, personId) : Promise.resolve(null)),
    [month, personId],
  )
  useEffect(() => {
    if (existing.data) {
      const d = existing.data.dates
      setPicked(new Set(d))
      setSaved(d.slice().sort().join(','))
    }
  }, [existing.data])

  const person = personId ? idx.people.get(personId) : null
  const dirty = person && saved !== null && [...picked].sort().join(',') !== saved
  const selectable = sessions.filter((s) => s.status === 'scheduled')

  function choose(id) {
    setPersonId(id); setMsg(null); setSaved(null); setPicked(new Set())
  }
  function toggle(date) {
    if (!canEdit) return
    setMsg(null)
    setPicked((s) => {
      const n = new Set(s)
      n.has(date) ? n.delete(date) : n.add(date)
      return n
    })
  }
  async function save() {
    setBusy(true); setMsg(null)
    try {
      const dates = [...picked].sort()
      const res = await api.saveDates(month, personId, dates)
      setPicked(new Set(res.dates))
      setSaved(res.dates.slice().sort().join(','))
      setMsg({ kind: 'ok', text: `Recorded ${res.dates.length} ${res.dates.length === 1 ? 'Saturday' : 'Saturdays'} for ${person.name}.` })
    } catch (e) {
      setMsg({ kind: 'err', text: e.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="avail">
      <div className="sec-head">
        <span className="num">02 /</span>
        <h2>Availability</h2>
        <span className="label aside">{monthLabel(month)}</span>
      </div>

      <section className={`banner ${win.state}`} aria-label="Submission window">
        <div className="b-top">
          <WindowStamp state={win.state} />
          <span className="label">Target / {monthLabel(month)}</span>
        </div>
        <p className="b-msg">
          {win.state === 'open' && <>Submissions close <strong>{fullDate(win.closesOn)}</strong>. Tick every Saturday you can serve.</>}
          {win.state === 'upcoming' && <>Window opens <strong>{fullDate(win.opensOn)}</strong> and closes {fullDate(win.closesOn)}.</>}
          {win.state === 'closed' && <>Window closed {fullDate(win.closesOn)}. Contact an admin to change your dates.</>}
        </p>
        {isAdmin && win.state !== 'open' && <p className="label b-admin">Admin override active</p>}
      </section>

      <div className="steps">
        <section className="step">
          <h3 className="step-h"><span className="mono">A</span> Select name</h3>
          <input className="field" type="search" placeholder="Search name" value={query}
            onChange={(e) => setQuery(e.target.value)} aria-label="Search name" autoComplete="off" />
          <ul className="names" role="listbox" aria-label="People">
            {matches.length === 0 && <li className="label none">No match</li>}
            {matches.map((p) => (
              <li key={p.id}>
                <button type="button" role="option" aria-selected={p.id === personId}
                  className={p.id === personId ? 'on' : ''} onClick={() => choose(p.id)}>
                  <span>{p.name}</span><Rank rank={p.rank} />
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="step">
          <h3 className="step-h"><span className="mono">B</span> Tick Saturdays</h3>
          {!person ? (
            <p className="label pad">Select a name to continue.</p>
          ) : existing.loading ? (
            <Loading what={`Loading ${person.name}`} />
          ) : existing.error ? (
            <ErrorBox error={existing.error} onRetry={existing.reload} />
          ) : (
            <>
              <p className="who-line"><strong>{person.name}</strong> <Rank rank={person.rank} /></p>
              {selectable.length === 0 ? (
                <div className="empty"><h3>No sessions</h3><p className="label">No Saturdays are open this month</p></div>
              ) : (
                <ul className="grid">
                  {selectable.map((s) => {
                    const on = picked.has(s.date)
                    return (
                      <li key={s.date}>
                        <button type="button" className={`cell ${on ? 'on' : ''}`} aria-pressed={on}
                          disabled={!canEdit} onClick={() => toggle(s.date)}>
                          <span className="box" aria-hidden="true">{on ? 'X' : ''}</span>
                          <span className="d">{dayNum(s.date)}</span>
                          <span className="label">{dayMonth(s.date).slice(3)} / SAT</span>
                          <span className="stamp tiny">{on ? 'Available' : 'Unavailable'}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
              {msg && (
                <div className={`notice ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'} style={{ marginTop: 12 }}>
                  <span className="label">{msg.kind === 'ok' ? 'Filed' : 'Rejected'}</span>
                  <span className="msg">{msg.text}</span>
                </div>
              )}
              <div className="actions">
                <button type="button" className="btn primary" disabled={!canEdit || busy || !dirty} onClick={save}>
                  {busy ? 'Saving...' : 'Save availability'}
                </button>
                <span className="label">{!canEdit ? 'Window closed' : dirty ? 'Unsaved changes' : 'No changes'}</span>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
