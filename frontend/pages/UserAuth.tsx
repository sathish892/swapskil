import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { apiRequest } from '../service/api';

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return <main className="min-h-[75vh] grid place-items-center px-4 py-10"><section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-soft sm:p-9"><Link to="/" className="text-lg font-extrabold text-brand-700">SkillSwap<span className="text-brand-400">.</span></Link><h1 className="mt-7 text-3xl font-extrabold tracking-tight text-slate-900">{title}</h1><p className="mt-2 text-sm text-slate-500">{subtitle}</p>{children}</section></main>;
}

export function UserLogin() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const navigate = useNavigate(); const location = useLocation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await apiRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      setPassword('');
      const from = (location.state as { from?: string } | null)?.from;
      let destination = '/subscription';
      try {
        const subscription = await apiRequest<{ active: boolean }>('/api/subscriptions/current');
        if (subscription.active) destination = from || '/dashboard';
      } catch { /* The subscription page rechecks with the server and can show a retry state. */ }
      navigate(destination, { replace: true });
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not sign in.'); }
    finally { setBusy(false); }
  }
  return <AuthShell title="Welcome back" subtitle="Sign in to manage your skills and find your next learning partner.">
    <form onSubmit={submit} className="mt-6 space-y-4">
      <label className="block text-sm font-semibold text-slate-700">Email<input type="email" required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100" /></label>
      <label className="block text-sm font-semibold text-slate-700">Password<input type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100" /></label>
      {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
      <button disabled={busy} className="w-full rounded-xl bg-brand-600 px-4 py-3 font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
    <p className="mt-5 text-center text-sm text-slate-500">New to SkillSwap? <Link to="/register" className="font-semibold text-brand-700">Create an account</Link></p>
    <p className="mt-3 text-center text-xs text-slate-400"><Link to="/admin/login" className="hover:text-brand-700">Administrator sign in</Link></p>
  </AuthShell>;
}

export function UserRegister() {
  const [name, setName] = useState(''); const [email, setEmail] = useState('');
  const [bio, setBio] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await apiRequest('/api/auth/register', { method: 'POST', body: JSON.stringify({ name, email, bio, password }) });
      setPassword(''); navigate('/my-skills', { replace: true });
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create your account.'); }
    finally { setBusy(false); }
  }
  return <AuthShell title="Join SkillSwap" subtitle="Create an account to share skills and meet learning partners.">
    <form onSubmit={submit} className="mt-6 space-y-4">
      <label className="block text-sm font-semibold text-slate-700">Name<input required minLength={2} maxLength={100} autoComplete="name" value={name} onChange={e => setName(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100" /></label>
      <label className="block text-sm font-semibold text-slate-700">Email<input required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100" /></label>
      <label className="block text-sm font-semibold text-slate-700">Short bio <span className="font-normal text-slate-400">(optional)</span><textarea maxLength={280} rows={2} value={bio} onChange={e => setBio(e.target.value)} placeholder="A little about what you enjoy learning or teaching" className="mt-1.5 w-full resize-y rounded-xl border border-slate-300 px-4 py-3 font-normal outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100" /></label>
      <label className="block text-sm font-semibold text-slate-700">Password<input required minLength={12} type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100" /><span className="mt-1 block text-xs font-normal text-slate-400">Use at least 12 characters.</span></label>
      {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
      <button disabled={busy} className="w-full rounded-xl bg-brand-600 px-4 py-3 font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{busy ? 'Creating account…' : 'Create account'}</button>
    </form>
    <p className="mt-5 text-center text-sm text-slate-500">Already have an account? <Link to="/login" className="font-semibold text-brand-700">Sign in</Link></p>
  </AuthShell>;
}
