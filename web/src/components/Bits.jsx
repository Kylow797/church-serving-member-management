import { monthShort, shiftMonth } from '../lib/dates.js'

export function Rank({ rank }) {
  return (
    <span className={`rank r${rank}`} title={['', 'Newcomer', 'Regular', 'Senior'][rank]}>
      {rank === 1 ? 'R1 NEW' : `R${rank}`}
    </span>
  )
}

export function MonthSwitch({ month, onChange }) {
  return (
    <div className="switch" role="group" aria-label="Month">
      <button type="button" onClick={() => onChange(shiftMonth(month, -1))} aria-label="Previous month">&lt;</button>
      <span className="cur">{monthShort(month)}</span>
      <button type="button" onClick={() => onChange(shiftMonth(month, 1))} aria-label="Next month">&gt;</button>
    </div>
  )
}

export function Loading({ what = 'Loading' }) {
  return (
    <div role="status" aria-live="polite">
      <div className="loading" />
      <p className="label">{what}...</p>
    </div>
  )
}

export function ErrorBox({ error, onRetry, title = 'Fault' }) {
  return (
    <div className="notice err" role="alert">
      <span className="label">{title}</span>
      <span className="msg">{error?.message || String(error)}</span>
      {onRetry && (
        <div style={{ marginTop: 6 }}>
          <button type="button" className="btn small" onClick={onRetry}>Retry</button>
        </div>
      )}
    </div>
  )
}

export function WindowStamp({ state }) {
  if (state === 'open') return <span className="stamp signal solid">Window open</span>
  if (state === 'upcoming') return <span className="stamp mute">Window pending</span>
  return <span className="stamp mute">Window closed</span>
}
