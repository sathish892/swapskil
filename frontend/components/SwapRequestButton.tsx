import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiRequest } from '../service/api';
import type { SkillMatch } from '../types';

export default function SwapRequestButton({ match }: { match: SkillMatch }) {
  const [offered, setOffered] = useState(match.offeredSkills[0]?.skillId || '');
  const [wanted, setWanted] = useState(match.directSkills[0]?.skillId || '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function sendRequest() {
    setBusy(true); setError(''); setSent(false);
    try {
      await apiRequest('/api/swap-requests', { method: 'POST', body: JSON.stringify({
        receiverId: match.user.id, skillOfferedId: offered, skillWantedId: wanted, message,
      }) });
      setMessage(''); setSent(true);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not send your request.'); }
    finally { setBusy(false); }
  }

  if (!match.offeredSkills.length) return <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">Add a skill you can teach before sending a swap request. <Link to="/my-skills" className="font-semibold text-brand-700 hover:underline">Add skills</Link></div>;

  return <div className="mt-4 border-t border-slate-100 pt-4">
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="text-xs font-semibold text-slate-500">You can offer<select value={offered} onChange={event => setOffered(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm font-medium text-slate-700">{match.offeredSkills.map(skill => <option key={skill.skillId} value={skill.skillId}>{skill.name}</option>)}</select></label>
      <label className="text-xs font-semibold text-slate-500">You want to learn<select value={wanted} onChange={event => setWanted(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm font-medium text-slate-700">{match.directSkills.map(skill => <option key={skill.skillId} value={skill.skillId}>{skill.name}</option>)}</select></label>
    </div>
    <label className="sr-only" htmlFor={`swap-note-${match.user.id}`}>Optional note</label>
    <input id={`swap-note-${match.user.id}`} value={message} onChange={event => setMessage(event.target.value)} maxLength={500} placeholder="Add a short note (optional)" className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100" />
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" onClick={() => void sendRequest()} disabled={busy || sent || !offered || !wanted} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-55">{busy ? 'Sending…' : sent ? 'Request sent' : 'Send Swap Request'}</button>
      {sent && <div role="status" className="w-full rounded-xl border border-emerald-100 bg-emerald-50 p-3"><p className="text-sm font-semibold text-emerald-800">Request sent. We’ll let you know when {match.user.name} responds.</p><div className="mt-2 flex flex-wrap gap-3 text-sm font-semibold"><Link to="/swap-requests" className="text-brand-700 hover:underline">View my requests</Link><Link to="/matches" className="text-slate-600 hover:underline">Continue exploring</Link></div></div>}
      {error && <span role="alert" className="text-sm text-rose-700">{error}</span>}
    </div>
  </div>;
}
