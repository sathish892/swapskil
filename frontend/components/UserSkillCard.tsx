import { useState } from 'react';
import type { SkillKind, UserSkill } from '../types';

const levelLabels: Record<UserSkill['level'], string> = { BEGINNER: 'Beginner', INTERMEDIATE: 'Intermediate', ADVANCED: 'Advanced', EXPERT: 'Expert' };

export default function UserSkillCard({ item, onRemove }: { item: UserSkill; onRemove: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const kind: SkillKind = item.type;
  async function remove() {
    setBusy(true); setError('');
    try { await onRemove(item.id); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not remove this skill.'); }
    finally { setBusy(false); }
  }
  return <article className="flex min-w-0 items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
    <div className="min-w-0"><h3 className="truncate font-semibold text-slate-900">{item.name}</h3><p className="mt-1 text-sm text-slate-500">{item.category} · {levelLabels[item.level]} {kind === 'TEACH' ? 'teacher' : 'learner'}</p>{error && <p role="alert" className="mt-1 text-xs text-rose-700">{error}</p>}</div>
    <button type="button" onClick={() => void remove()} disabled={busy} aria-label={`Remove ${item.name}`} className="shrink-0 rounded-full px-3 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50">{busy ? 'Removing…' : 'Remove'}</button>
  </article>;
}
