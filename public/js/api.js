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
  listWords: ({ sort, favFirst, q, tag = '', kind = '' }) =>
    request('GET', `/words?${qs({ sort, favFirst: favFirst ? '1' : '0', q, tag, kind })}`),
  getWord: (id) => request('GET', `/words/${id}`),
  // details: optional { parts_of_speech, notes, found_title, found_author, found_page, tags }
  addWord: (term, details = {}) => request('POST', '/words', { term, ...details }),
  setPartsOfSpeech: (id, partsOfSpeech) => request('PUT', `/words/${id}/parts-of-speech`, { parts_of_speech: partsOfSpeech }),
  compare: (a, b) => request('GET', `/compare?${qs({ a, b })}`),
  explainComparison: (a, b, again = false) => request('POST', '/compare/explain', { a, b, again }),
  listSavedComparisons: () => request('GET', '/saved-comparisons'),
  saveComparison: (a, b, note) => request('POST', '/saved-comparisons', { a, b, note }),
  updateSavedComparison: (id, note) => request('PATCH', `/saved-comparisons/${id}`, { note }),
  removeSavedComparison: (id) => request('DELETE', `/saved-comparisons/${id}`),
  updateWord: (id, changes) => request('PATCH', `/words/${id}`, changes),
  deleteWord: (id) => request('DELETE', `/words/${id}`),
  refreshWord: (id) => request('POST', `/words/${id}/refresh`),
  addDefinition: (id, def) => request('POST', `/words/${id}/definitions`, def),
  updateDefinition: (id, defId, def) => request('PATCH', `/words/${id}/definitions/${defId}`, def),
  deleteDefinition: (id, defId) => request('DELETE', `/words/${id}/definitions/${defId}`),
  reorderDefinitions: (id, ids) => request('PUT', `/words/${id}/definitions/order`, { ids }),
  listTags: () => request('GET', '/tags'),
  reviewBatch: ({ tag = '', favorites = false, kind = '', limit = 20 } = {}) =>
    request('GET', `/review?${qs({ tag, favorites: favorites ? '1' : '0', kind, limit })}`),
  recordReview: (id, known) => request('POST', `/words/${id}/review`, { known }),
  importBackup: (data) => request('POST', '/import', data),
  listBackups: () => request('GET', '/backups'),
  backupNow: () => request('POST', '/backups'),
  restoreBackup: (name) => request('POST', '/backups/restore', { name }),
  setBackupLocation: (dir) => request('PUT', '/backups/location', { dir }),
  exportUrl: (format) => `/api/export?format=${format}`,
  getKeys: () => request('GET', '/keys'),
  saveKeys: (values) => request('PUT', '/keys', values),
  getSettings: () => request('GET', '/settings'),
  saveSettings: (values) => request('PUT', '/settings', values),
};
