export class ApiError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export async function api(path, init = {}) {
  const { pollAsync = false, ...requestInit } = init
  let response
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...requestInit,
      headers: { 'content-type': 'application/json', ...requestInit.headers },
    })
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : 'Gateway API is unavailable', 0, 'network_error')
  }
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    throw new ApiError(`Gateway returned invalid JSON (${response.status})`, response.status, 'invalid_response')
  }
  if (!response.ok) {
    const code = data?.error?.code || data?.error?.message || `http_${response.status}`
    throw new ApiError(code, response.status, code)
  }
  if (pollAsync && response.status === 202 && data?.job?.id) {
    return waitForJob(data.job.id)
  }
  return data
}

async function waitForJob(id) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    const job = await api(`/jobs/${encodeURIComponent(id)}`)
    if (job?.status === 'completed') return job.result ?? job
    if (['failed', 'cancelled', 'uncertain'].includes(job?.status)) throw new ApiError(job.error || `Background job ${job.status}`, 409, `job_${job.status}`)
  }
  throw new ApiError(`Background job ${id} timed out`, 408, 'job_timeout')
}

export const get = (path) => api(path, { pollAsync: true })
export const send = (path, method, body) => api(path, {
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
})
