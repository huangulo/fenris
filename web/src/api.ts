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
