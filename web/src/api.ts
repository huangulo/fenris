// ── Token storage ─────────────────────────────────────────────────────────────

const TOKEN_KEY = 'fenris_jwt';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// ── Redirect helper ───────────────────────────────────────────────────────────

/** Called when a 401 is received — clears token and reloads to trigger login page. */
function onUnauthorized(): void {
  clearToken();
  window.location.reload();
}

// ── apiFetch ──────────────────────────────────────────────────────────────────

export async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (opts.body != null) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers ?? {}) } });

  if (res.status === 401) {
    onUnauthorized();
    // Return the response anyway so callers can see it; the reload will happen async
  }

  return res;
}

/** GET /api/v1/docker/containers/:server_id/:container_name/history */
export async function fetchContainerHistory(serverId: number, containerName: string, hours = 24) {
  const r = await apiFetch(`/api/v1/docker/containers/${serverId}/${encodeURIComponent(containerName)}/history?hours=${hours}`);
  return r.ok ? r.json() : [];
}

/** GET /api/v1/docker/containers/:server_id/:container_name/restarts */
export async function fetchContainerRestarts(serverId: number, containerName: string) {
  const r = await apiFetch(`/api/v1/docker/containers/${serverId}/${encodeURIComponent(containerName)}/restarts`);
  return r.ok ? r.json() : { restarts_24h: 0, restarts_7d: 0 };
}

/** GET /api/v1/docker/events */
export async function fetchDockerEvents(params: { server_id?: number; container_name?: string; limit?: number } = {}) {
  const qs = new URLSearchParams();
  if (params.server_id)      qs.set('server_id',      String(params.server_id));
  if (params.container_name) qs.set('container_name', params.container_name);
  if (params.limit)          qs.set('limit',          String(params.limit));
  const r = await apiFetch(`/api/v1/docker/events?${qs}`);
  return r.ok ? r.json() : [];
}

/** GET /api/v1/docker/top */
export async function fetchDockerTop(metric: 'cpu' | 'memory' | 'network' = 'cpu', limit = 5) {
  const r = await apiFetch(`/api/v1/docker/top?metric=${metric}&limit=${limit}`);
  if (!r.ok) {
    console.warn(`[fetchDockerTop] ${metric} → HTTP ${r.status}`);
    return [];
  }
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

/** POST /api/v1/auth/login — no JWT needed, returns token on success */
export async function apiLogin(username: string, password: string): Promise<{ token: string; user: { id: number; username: string; role: string } }> {
  const res = await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Login failed' }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}
