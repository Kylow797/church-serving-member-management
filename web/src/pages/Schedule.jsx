import { useEffect, useMemo, useState } from 'react'
import { useOutletContext, useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import { indexRoster, useLoader, useMonth, useRoster } from '../lib/useAsync.js'
import { dayNum, isMonth, monthLabel, dayMonth, shiftMonth } from '../lib/dates.js'
import { ErrorBox, Loading, MonthSwitch, Rank } from '../components/Bits.jsx'
import WarningList from '../components/WarningList.jsx'
import './Schedule.css'

const ME_KEY = 'serving.me'
const NEXT_LOOKAHEAD = 3 // months to scan for the next scheduled Saturday

// Date of the next scheduled (non-cancelled) session >= today, scanning from today's
// month forward. Resolves null if none within the lookahead or on fetch failure
// (the NEXT stamp is a nicety; it must never block or break the page).
function useNextSession(today) {
  return useLoader(async () => {
    if (!today) return null
    let m = today.slice(0, 7)
    for (let i = 0; i < NEXT_LOOKAHEAD; i++, m = shiftMonth(m, 1)) {
      const data = await api.month(m).catch(() => null)
      const hit = data?.sessions?.find((s) => s.status === 'scheduled' && s.date >= today)
      if (hit) return hit.date
    }
    return null
  }, [today])
}

const loadMe = () => { try { return localStorage.getItem(ME_KEY) || '' } catch { return '' } }

export default function Schedule() {
  const { status } = useOutletContext()
  const [params, setParams] = useSearchParams()
  const today = status?.today
  const month = isMonth(params.get('m')) ? params.get('m') : today ? today.slice(0, 7) : null

  const roster = useRoster()
  const monthData = useMonth(month)
  const [me, setMe] = useState(loadMe)

  useEffect(() => {
    try { me ? localStorage.setItem(ME_KEY, me) : localStorage.removeItem(ME_KEY) } catch { /* ignore */ }
  }, [me])

  const idx = useMemo(() => (roster.data ? indexRoster(roster.data) : null), [roster.data])

  const sessions = useMemo(() => monthData.data?.sessions ?? [], [monthData.data])
  // NEXT = the single next non-cancelled Saturday on or after today, across months
  // (not "first upcoming in the viewed month"). Only stamped when it falls in this month.
  const nextQ = useNextSession(today)
  const nextDate = nextQ.data && nextQ.data.slice(0, 7) === month ? nextQ.data : null
  const myDates = useMemo(
    () => (me ? sessions.filter((s) => s.assignments.some((a) => a.personId === me)).map((s) => s.date) : []),
    [sessions, me],
  )

  if (roster.error) return <ErrorBox error={roster.error} onRetry={roster.reload} />
  if (monthData.error) return <ErrorBox error={monthData.error} onRetry={monthData.reload} />
  if (!month || roster.loading || !roster.data || monthData.loading || !monthData.data) return <Loading what="Retrieving schedule" />
  const data = monthData.data
  const activePeople = roster.data.people.filter((p) => p.active || p.id === me)
  const generated = !!data.generatedAt || sessions.some((s) => s.assignments.length > 0)

  return (
    <div className="schedule">
      <div className="sec-head">
        <span className="num">01 /</span>
        <h2>Schedule</h2>
        <span className="label aside">{monthLabel(month)}</span>
      </div>

      <div className="toolbar">
        <MonthSwitch month={month} onChange={(m) => setParams(m === today?.slice(0, 7) ? {} : { m })} />
        <label className="findme">
          <span className="label">Find me</span>
          <select className="field" value={me} onChange={(e) => setMe(e.target.value)}>
            <option value="">-- everyone --</option>
            {activePeople.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>

      {me && (
        <div className="notice ok mine" aria-live="polite">
          <span className="label">{idx.people.get(me)?.name} / {monthLabel(month)}</span>
          <span className="msg">
            {myDates.length === 0
              ? 'Not rostered this month.'
              : <>Serving <strong>{myDates.length}</strong> {myDates.length === 1 ? 'Saturday' : 'Saturdays'}: <span className="mono">{myDates.map(dayMonth).join(' / ')}</span></>}
          </span>
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="empty">
          <h3>No Saturdays on file</h3>
          <p className="label">Nothing to display for {monthLabel(month)}</p>
        </div>
      ) : (
        <>
          {!generated && (
            <div className="notice" style={{ margin: '14px 0' }}>
              <span className="label">Status / Pending</span>
              <span className="msg">Roster not generated yet. Teams are assigned once availability closes at month end.</span>
            </div>
          )}
          <div className="panels">
            {sessions.map((s, i) => (
              <Panel key={s.date} session={s} n={i + 1} idx={idx} roster={roster.data} me={me}
                next={s.date === nextDate} past={today && s.date < today} generated={generated} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function Panel({ session, n, idx, roster, me, next, past, generated }) {
  const cancelled = session.status === 'cancelled'
  const byRole = new Map()
  for (const a of session.assignments) {
    if (!byRole.has(a.roleId)) byRole.set(a.roleId, [])
    byRole.get(a.roleId).push(a)
  }
  const mine = !!me && session.assignments.some((a) => a.personId === me)

  return (
    <article className={`panel ${cancelled ? 'cancelled' : ''} ${next ? 'next' : ''} ${past ? 'past' : ''} ${mine ? 'mine' : ''}`}
      aria-label={`Saturday ${session.date}`}>
      <header className="p-head">
        <div className="p-date">
          <span className="label">SAT {String(n).padStart(2, '0')}</span>
          <span className="day">{dayNum(session.date)}</span>
          <span className="mono mon">{dayMonth(session.date).slice(3)}</span>
        </div>
        <div className="p-stamps">
          {cancelled ? <span className="stamp signal solid tilt">Cancelled</span>
            : generated ? <span className="stamp">Scheduled</span>
            : <span className="stamp mute">Pending</span>}
          {next && !cancelled && <span className="stamp signal">Next</span>}
          {mine && <span className="stamp solid">You</span>}
        </div>
      </header>

      {cancelled ? (
        <div className="reason">
          <span className="label">Reason for cancellation</span>
          <p>{session.cancelReason || 'No reason recorded.'}</p>
        </div>
      ) : !generated ? (
        <p className="p-empty label">Awaiting assignment</p>
      ) : (
        <div className="p-body">
          {roster.ministries.filter((m) => m.active).map((m, mi) => {
            const roles = m.roles.filter((r) => r.active || byRole.has(r.id))
            const count = roles.reduce((t, r) => t + (byRole.get(r.id)?.length || 0), 0)
            return (
              <section key={m.id} className="ministry">
                <h3 className="m-head">
                  <span className="mono">{String.fromCharCode(65 + mi)}</span>
                  <span>{m.name}</span>
                  <span className="mono cnt">{String(count).padStart(2, '0')}</span>
                </h3>
                <dl className="roles">
                  {roles.map((r) => {
                    const list = (byRole.get(r.id) || []).sort((a, b) => a.slot - b.slot)
                    const short = list.length < r.min
                    return (
                      <div key={r.id} className="role-row">
                        <dt className="label">{r.name}</dt>
                        <dd>
                          {list.map((a) => {
                            const p = idx.people.get(a.personId)
                            return (
                              <span key={a.slot} className={`who ${a.personId === me ? 'is-me' : ''}`}>
                                {p ? p.name : a.personId}
                                {p && <Rank rank={p.rank} />}
                                {a.locked && <span className="lock" title="Set by admin">LOCKED</span>}
                              </span>
                            )
                          })}
                          {short && <span className="stamp signal gap">{list.length === 0 ? 'Unfilled' : `Need ${r.min - list.length}`}</span>}
                        </dd>
                      </div>
                    )
                  })}
                </dl>
              </section>
            )
          })}
          <WarningList warnings={session.warnings} compact people={idx.people} />
        </div>
      )}
    </article>
  )
}
