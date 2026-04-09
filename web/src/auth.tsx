import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { getToken, setToken, clearToken, apiLogin, apiFetch } from './api';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id:       number;
  username: string;
  email:    string | null;
  role:     'admin' | 'operator' | 'viewer';
  enabled:  boolean;
}

interface AuthContextValue {
  user:    AuthUser | null;
  loading: boolean;
  login:   (username: string, password: string) => Promise<void>;
  logout:  () => Promise<void>;
  token:   string | null;
}

// ── Context ───────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export function hasRole(user: AuthUser | null, required: 'admin' | 'operator' | 'viewer'): boolean {
  if (!user) return false;
  const rank = { viewer: 1, operator: 2, admin: 3 };
  return rank[user.role] >= rank[required];
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]       = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // On mount: validate stored token by hitting /api/v1/auth/me
  useEffect(() => {
    const token = getToken();
    if (!token) { setLoading(false); return; }

    apiFetch('/api/v1/auth/me')
      .then(async res => {
        if (res.ok) {
          setUser(await res.json());
        } else {
          clearToken();
        }
      })
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const data = await apiLogin(username, password);
    setToken(data.token);
    setUser(data.user as AuthUser);
  }, []);

  const logout = useCallback(async () => {
    try { await apiFetch('/api/v1/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    clearToken();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, token: getToken() }}>
      {children}
    </AuthContext.Provider>
  );
}
