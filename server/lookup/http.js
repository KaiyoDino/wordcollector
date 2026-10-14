// fetch with a timeout. Resolves to { status, body } where body is parsed JSON (or null).
export async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/json' },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON response; MW returns HTML for a bad key, for example.
  }
  return { status: res.status, body };
}

export function describeError(err) {
  if (err?.name === 'TimeoutError') return 'Timed out';
  return err?.message || 'Request failed';
}
