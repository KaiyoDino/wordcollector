export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data);
  return data;
}

const qs = (params) => new URLSearchParams(params).toString();

export const api = {
  lookup: (term) => request('GET', `/lookup?${qs({ term })}`),
  listWords: ({ sort, favFirst, q, tag = '' }) =>
    request('GET', `/words?${qs({ sort, favFirst: favFirst ? '1' : '0', q, tag })}`),
  getWord: (id) => request('GET', `/words/${id}`),
  addWord: (term) => request('POST', '/words', { term }),
  updateWord: (id, changes) => request('PATCH', `/words/${id}`, changes),
  deleteWord: (id) => request('DELETE', `/words/${id}`),
  refreshWord: (id) => request('POST', `/words/${id}/refresh`),
  addDefinition: (id, def) => request('POST', `/words/${id}/definitions`, def),
  updateDefinition: (id, defId, def) => request('PATCH', `/words/${id}/definitions/${defId}`, def),
  deleteDefinition: (id, defId) => request('DELETE', `/words/${id}/definitions/${defId}`),
  reorderDefinitions: (id, ids) => request('PUT', `/words/${id}/definitions/order`, { ids }),
  listTags: () => request('GET', '/tags'),
  reviewBatch: ({ tag = '', favorites = false, limit = 20 } = {}) =>
    request('GET', `/review?${qs({ tag, favorites: favorites ? '1' : '0', limit })}`),
  recordReview: (id, known) => request('POST', `/words/${id}/review`, { known }),
  importBackup: (data) => request('POST', '/import', data),
  exportUrl: (format) => `/api/export?format=${format}`,
  getKeys: () => request('GET', '/keys'),
  saveKeys: (values) => request('PUT', '/keys', values),
  getSettings: () => request('GET', '/settings'),
  saveSettings: (values) => request('PUT', '/settings', values),
};
