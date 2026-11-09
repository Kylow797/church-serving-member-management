import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

// Generic loader: { data, setData, error, loading, reload }
//
// State is tagged with the loader (`run`) that produced it. When deps change, the
// first render with the new deps happens *before* the effect fires reload(), so
// the old state ({ data: null, loading: false } from e.g. a null month) would be
// returned as if it were the new result. Pages then dereferenced data.sessions on
// null and the whole tree crashed. Mismatched state is now reported as loading.
export function useLoader(fn, deps) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps)
  const [state, setState] = useState({ run: null, data: null, error: null, loading: true })
  const seq = useRef(0)

  const reload = useCallback(() => {
    const n = ++seq.current
    setState((s) => (s.run === run ? { ...s, loading: true, error: null } : { run, data: null, error: null, loading: true }))
    let p
    try { p = Promise.resolve(run()) } catch (e) { p = Promise.reject(e) }
    p.then(
      (data) => { if (n === seq.current) setState({ run, data, error: null, loading: false }) },
      (error) => { if (n === seq.current) setState({ run, data: null, error, loading: false }) },
    )
  }, [run])

  useEffect(() => { reload() }, [reload])

  const setData = useCallback((data) => setState({ run, data, error: null, loading: false }), [run])
  const current = state.run === run ? state : { data: null, error: null, loading: true }
  return { data: current.data, error: current.error, loading: current.loading, setData, reload }
}

export const useStatus = () => useLoader(() => api.status(), [])
export const useRoster = () => useLoader(() => api.roster(), [])
export const useMonth = (month) => useLoader(() => (month ? api.month(month) : Promise.resolve(null)), [month])

// Lookup helpers built from the roster payload.
export function indexRoster(roster) {
  const people = new Map(roster.people.map((p) => [p.id, p]))
  const roles = new Map()
  for (const m of roster.ministries) for (const r of m.roles) roles.set(r.id, { ...r, ministryId: m.id })
  return { people, roles }
}
