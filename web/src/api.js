const KEY = 'serving.adminCode'

export const adminCode = {
  get() {
    try { return sessionStorage.getItem(KEY) || '' } catch { return '' }
  },
  set(code) {
    try { sessionStorage.setItem(KEY, code) } catch { /* private mode */ }
  },
  clear() {
    try { sessionStorage.removeItem(KEY) } catch { /* ignore */ }
  },
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

async function request(method, path, body) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const code = adminCode.get()
  if (code) headers['X-Admin-Code'] = code

  let res
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError('Cannot reach the server', 0)
  }

  let data = null
  const text = await res.text()
  if (text) {
    try { data = JSON.parse(text) } catch { /* non-JSON body */ }
  }
  if (!res.ok) {
    throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status)
  }
  return data
}

const enc = encodeURIComponent

export const api = {
  status: () => request('GET', '/status'),
  roster: () => request('GET', '/roster'),
  month: (m) => request('GET', `/months/${enc(m)}`),
  personDates: (m, id) => request('GET', `/availability/${enc(m)}/${enc(id)}`),
  saveDates: (m, id, dates) => request('PUT', `/availability/${enc(m)}/${enc(id)}`, { dates }),
  login: (code) => request('POST', '/admin/login', { code }),
  adminAvailability: (m) => request('GET', `/admin/availability/${enc(m)}`),
  generate: (m, opts = {}) => request('POST', `/admin/months/${enc(m)}/generate`, opts),
  setSlot: (date, roleId, slot, personId) =>
    request('PUT', `/admin/sessions/${enc(date)}/slot`, { roleId, slot, personId }),
  cancel: (date, reason) => request('POST', `/admin/sessions/${enc(date)}/cancel`, { reason }),
  restore: (date) => request('POST', `/admin/sessions/${enc(date)}/restore`),
  reloadConfig: () => request('POST', '/admin/reload-config'),
}
