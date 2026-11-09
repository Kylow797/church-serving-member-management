import './WarningList.css'

export default function WarningList({ warnings, compact, people }) {
  if (!warnings || warnings.length === 0) return null
  return (
    <ul className={`warns ${compact ? 'compact' : ''}`} aria-label="Warnings">
      {warnings.map((w, i) => (
        <li key={`${w.code}-${w.roleId || ''}-${i}`}>
          <span className="stamp signal">{w.code.replace(/_/g, ' ')}</span>
          <span className="wmsg">
            {w.personId && people?.get(w.personId) && <strong className="wwho">{people.get(w.personId).name}: </strong>}
            {w.message}
          </span>
        </li>
      ))}
    </ul>
  )
}
