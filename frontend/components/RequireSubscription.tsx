import { useCallback, useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { apiRequest } from '../service/api';

type AccessState = 'checking' | 'allowed' | 'required' | 'error';

export default function RequireSubscription() {
  const [state, setState] = useState<AccessState>('checking');
  const [message, setMessage] = useState('');
  const location = useLocation();
  const check = useCallback(async () => {
    setState('checking');
    setMessage('');
    try {
      const result = await apiRequest<{ active: boolean }>('/api/subscriptions/current');
      setState(result.active ? 'allowed' : 'required');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not verify your subscription.');
      setState('error');
    }
  }, []);
  useEffect(() => { void check(); }, [check]);

  if (state === 'checking') return <div className="grid min-h-[50vh] place-items-center text-sm text-slate-500">Checking your subscription…</div>;
  if (state === 'required') return <Navigate to="/subscription" replace state={{ from: location.pathname }} />;
  if (state === 'error') return <div className="mx-auto max-w-lg rounded-2xl border bg-white p-6 text-center"><h1 className="text-lg font-bold">Subscription could not be verified</h1><p role="alert" className="mt-2 text-sm text-slate-600">{message}</p><button onClick={() => void check()} className="mt-4 min-h-11 rounded-xl bg-brand-700 px-4 font-semibold text-white">Try again</button></div>;
  return <Outlet />;
}
