import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useStatus } from '../lib/useAsync.js'
import { ErrorBox, Loading } from './Bits.jsx'
import { fullDate } from '../lib/dates.js'
import ErrorBoundary from './ErrorBoundary.jsx'
import './Layout.css'

const NAV = [
  { to: '/', label: 'Schedule', code: '01', end: true },
  { to: '/availability', label: 'Availability', code: '02' },
  { to: '/admin', label: 'Admin', code: '03' },
]

export default function Layout() {
  const statusQ = useStatus()
  const status = statusQ.data
  const { pathname } = useLocation()
  const form = pathname.startsWith('/admin') ? 'SR-30' : pathname.startsWith('/availability') ? 'SR-20' : 'SR-12'

  return (
    <div className="shell">
      <header className="masthead">
        <div className="wrap">
          <div className="meta-row label">
            <span>FORM {form}</span>
            <span>REV 2026.11</span>
            <span className="meta-date">{status ? fullDate(status.today) : '--'}</span>
          </div>
          <div className="title-row">
            <span className="mark" aria-hidden="true"><i /><i /></span>
            <div>
              <h1>Serving Roster</h1>
              <p className="label">{status ? status.churchName : 'Saturday operations'}</p>
            </div>
          </div>
          <nav className="nav" aria-label="Sections">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}>
                <span className="code">{n.code}</span>
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="wrap main">
        {statusQ.error ? (
          <div className="boot">
            <ErrorBox title="Server unreachable" error={statusQ.error} onRetry={statusQ.reload} />
          </div>
        ) : !status ? (
          <Loading what="Connecting" />
        ) : (
          <ErrorBoundary where={NAV.find((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to)))?.label || 'Page'} resetKey={pathname}>
            <Outlet context={{ status, reloadStatus: statusQ.reload }} />
          </ErrorBoundary>
        )}
      </main>
      <footer className="wrap foot label">
        <span>END OF FORM</span>
        <span>SATURDAY SERVICE / MINISTRY ASSIGNMENT</span>
      </footer>
    </div>
  )
}
