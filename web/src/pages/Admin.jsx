import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { api, adminCode } from '../api.js'
import { indexRoster, useLoader, useMonth, useRoster } from '../lib/useAsync.js'
import { fullDate, monthLabel, stampTime } from '../lib/dates.js'
import { ErrorBox, Loading, MonthSwitch } from '../components/Bits.jsx'
import SessionEditor from '../components/SessionEditor.jsx'
import AvailabilityMatrix from '../components/AvailabilityMatrix.jsx'
import WarningList from '../components/WarningList.jsx'
import './Admin.css'

export default function Admin() {
  const [authed, setAuthed] = useState(null) // null = checking

  useEffect(() => {
    const code = adminCode.get()
    if (!code) { setAuthed(false); return }
    api.login(code).then(() => setAuthed(true), () => { adminCode.clear(); setAuthed(false) })
  }, [])

  function logout() { adminCode.clear(); setAuthed(false) }

  if (authed === null) return <Loading what="Checking credentials" />
  if (!authed) return <Login onDone={() => setAuthed(true)} />
  return <Console onLogout={logout} />
}

function Login({ onDone }) {
  const [code, setCode] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setErr(null)
    try {
      await api.login(code)
      adminCode.set(code)
      onDone()
    } catch (e2) {
      setErr(e2.status === 401 ? 'Code not recognised.' : e2.message)
    } finally { setBusy(false) }
  }

  return (
    <div>
      <div className="sec-head"><span className="num">03 /</span><h2>Admin</h2><span className="label aside">Restricted</span></div>
      <form className="login" onSubmit={submit}>
        <div className="login-h label">Authorisation required</div>
        <label className="login-b">
          <span className="label">Admin code</span>
          <input className="field" type="password" inputMode="numeric" autoComplete="current-password"
            value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
        </label>
        {err && <div className="notice err" role="alert"><span className="label">Denied</span><span className="msg">{err}</span></div>}
        <button className="btn primary" disabled={busy || !code}>{busy ? 'Checking...' : 'Enter'}</button>
      </form>
    </div>
  )
}

function Console({ onLogout }) {
  const { status } = useOutletContext()
  const [month, setMonth] = useState(null)
  const m = month || status?.targetMonth || null

  const roster = useRoster()
  const monthData = useMonth(m)
  const avail = useLoader(() => (m ? api.adminAvailability(m) : Promise.resolve(null)), [m])

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [note, setNote] = useState(null)

  const idx = useMemo(() => (roster.data ? indexRoster(roster.data) : null), [roster.data])
  const { setData: setMonthData } = monthData
  const { reload: reloadAvail } = avail

  // Run an admin action that returns a fresh MonthPayload.
  const act = useCallback(async (fn, okNote) => {
    setBusy(true); setErr(null); setNote(null)
    try {
      const payload = await fn()
      setMonthData(payload)
      if (okNote) setNote(okNote)
      return true
    } catch (e) {
      if (e.status === 401) onLogout()
      setErr(e.message)
      return false
    } finally { setBusy(false) }
  }, [setMonthData, onLogout])

  const generate = (opts, label, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return
    act(() => api.generate(m, opts), label)
  }
  const cancelSession = (date) => {
    const reason = window.prompt(`Cancel ${fullDate(date)}. Reason (shown to members):`)
    if (reason === null) return
    if (!reason.trim()) { setErr('A reason is required to cancel a session.'); return }
    act(() => api.cancel(date, reason.trim()), `${fullDate(date)} cancelled.`)
  }

  async function reloadConfig() {
    setBusy(true); setErr(null); setNote(null)
    try {
      const r = await api.reloadConfig()
      setNote(`Config reloaded. Added ${r.added}, updated ${r.updated}, deactivated ${r.deactivated}.`)
      roster.reload(); monthData.reload(); reloadAvail()
    } catch (e) { setErr(`Config rejected: ${e.message}`) } finally { setBusy(false) }
  }

  const refreshMonth = useCallback(() => api.month(m).then(setMonthData, () => {}), [m, setMonthData])

  if (roster.error) return <ErrorBox error={roster.error} onRetry={roster.reload} />
  if (monthData.error) return <ErrorBox error={monthData.error} onRetry={monthData.reload} />
  if (!m || !roster.data || !monthData.data) return <Loading what="Opening console" />

  const data = monthData.data
  const allWarnings = data.sessions.flatMap((s) => (s.warnings || []).map((w) => ({ ...w, date: s.date })))

  return (
    <div className="admin">
      <div className="sec-head">
        <span className="num">03 /</span><h2>Admin</h2>
        <span className="aside"><button type="button" className="btn small" onClick={onLogout}>Sign out</button></span>
      </div>

      <section className="panel-a" aria-label="Month controls">
        <h3 className="a-h"><span className="mono">3.1</span> Month control</h3>
        <div className="a-b">
          <div className="row">
            <MonthSwitch month={m} onChange={(x) => { setMonth(x); setErr(null); setNote(null) }} />
            <div className="meta">
              <span className="label">Generated</span>
              <span className="mono">{data.generatedAt ? stampTime(data.generatedAt, status?.timezone) : 'NEVER'}</span>
            </div>
            <div className="meta">
              <span className="label">Window</span>
              <span className="mono">{data.window.state.toUpperCase()} / {data.window.opensOn} to {data.window.closesOn}</span>
            </div>
          </div>
          <div className="btns">
            <button className="btn primary" disabled={busy} onClick={() => generate({}, `${monthLabel(m)} generated. Locked slots kept.`)}>
              {data.generatedAt ? 'Regenerate' : 'Generate'}
            </button>
            <button className="btn" disabled={busy} onClick={() => generate({ reshuffle: true }, 'Reshuffled with a fresh seed. Locked slots kept.', 'Reshuffle all unlocked slots for this month?')}>Reshuffle</button>
            <button className="btn danger" disabled={busy} onClick={() => generate({ clearLocks: true }, 'Locks cleared and month regenerated.', 'Clear every lock and regenerate? Manual edits will be overwritten.')}>Clear locks</button>
          </div>
          {busy && <p className="label">Working...</p>}
          {err && <div className="notice err" role="alert"><span className="label">Fault</span><span className="msg">{err}</span></div>}
          {note && !err && <div className="notice ok" role="status"><span className="label">Done</span><span className="msg">{note}</span></div>}
        </div>
      </section>

      <section className="panel-a" aria-label="Warnings">
        <h3 className="a-h"><span className="mono">3.2</span> Live warnings <span className="mono cnt">{String(allWarnings.length).padStart(2, '0')}</span></h3>
        <div className="a-b">
          {allWarnings.length === 0 ? <p className="label">No warnings. All checks passing.</p> : (
            <div className="scroll-x">
              {data.sessions.filter((s) => s.warnings?.length).map((s) => (
                <div key={s.date} className="w-group">
                  <span className="label">{fullDate(s.date)}</span>
                  <WarningList warnings={s.warnings} people={idx?.people} />
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section aria-label="Sessions">
        <h3 className="a-h solo"><span className="mono">3.3</span> Session slots</h3>
        {data.sessions.length === 0 && <div className="empty"><h3>No sessions</h3><p className="label">No Saturdays for this month</p></div>}
        <div className="sessions">
          {data.sessions.map((s) => (
            <SessionEditor key={s.date} session={s} roster={roster.data} idx={idx}
              availableIds={avail.data?.[s.date] || []} busy={busy}
              onSlot={(roleId, slot, personId) => act(() => api.setSlot(s.date, roleId, slot, personId))}
              onCancel={() => cancelSession(s.date)}
              onRestore={() => act(() => api.restore(s.date), `${fullDate(s.date)} restored and refilled.`)} />
          ))}
        </div>
      </section>

      <section className="panel-a" aria-label="Availability matrix">
        <h3 className="a-h"><span className="mono">3.4</span> Availability matrix</h3>
        <div className="a-b nopad">
          {avail.loading && !avail.data ? <Loading what="Loading availability" />
            : avail.error ? <ErrorBox error={avail.error} onRetry={avail.reload} />
            : <AvailabilityMatrix month={m} sessions={data.sessions} people={roster.data.people.filter((p) => p.active)}
                map={avail.data || {}} setMap={avail.setData} onChanged={refreshMonth} onError={setErr} />}
        </div>
      </section>

      <section className="panel-a" aria-label="Configuration">
        <h3 className="a-h"><span className="mono">3.5</span> Configuration</h3>
        <div className="a-b">
          <p className="msg">People, ministries and roles come from <span className="mono">serving.config.yaml</span>. Edit the file, then reload.</p>
          <div className="btns"><button className="btn" disabled={busy} onClick={reloadConfig}>Reload config</button></div>
        </div>
      </section>
    </div>
  )
}
