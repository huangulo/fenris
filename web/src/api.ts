export const API_KEY = import.meta.env.VITE_API_KEY ?? '';

export function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { 'X-API-Key': API_KEY };
  if (opts.body != null) headers['Content-Type'] = 'application/json';
  return fetch(path, { ...opts, headers: { ...headers, ...(opts.headers ?? {}) } });
}
