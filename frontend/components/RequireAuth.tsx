import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

export default function RequireAuth() {
  const [state, setState] = useState<'loading' | 'signed-in' | 'guest'>('loading');
  const location = useLocation();
  useEffect(() => {
    let live = true;
    fetch('/api/auth/session', { credentials: 'include' })
      .then(response => { if (live) setState(response.ok ? 'signed-in' : 'guest'); })
      .catch(() => { if (live) setState('guest'); });
    return () => { live = false; };
  }, []);
  if (state === 'loading') return <div className="grid min-h-[50vh] place-items-center text-sm text-slate-500">Checking your account…</div>;
  if (state === 'guest') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}
