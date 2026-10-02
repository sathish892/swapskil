import { useEffect, useState } from 'react';
import SkillSelector from '../components/SkillSelector';
import UserSkillCard from '../components/UserSkillCard';
import { apiRequest } from '../service/api';
import type { SkillKind, UserSkill } from '../types';

export default function MySkillsPage() {
  const [items, setItems] = useState<UserSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function refresh() {
    const result = await apiRequest<{ items: UserSkill[] }>('/api/skills/user');
    setItems(result.items);
  }
  useEffect(() => { refresh().catch(err => setError(err.message || 'Could not load your skills.')).finally(() => setLoading(false)); }, []);

  async function addSkill(skill: { skillId?: string; skillName?: string; type: SkillKind; level: UserSkill['level'] }) {
    const result = await apiRequest<{ item: UserSkill }>('/api/skills/user', { method: 'POST', body: JSON.stringify(skill) });
    setItems(current => [...current, result.item]);
  }
  async function removeSkill(id: string) {
    await apiRequest('/api/skills/user/' + encodeURIComponent(id), { method: 'DELETE' });
    setItems(current => current.filter(item => item.id !== id));
  }

  const lists: { type: SkillKind; title: string; description: string }[] = [
    { type: 'TEACH', title: 'Skills I Can Teach', description: 'Share what you know with someone who wants to learn.' },
    { type: 'LEARN', title: 'Skills I Want To Learn', description: 'Tell us what you would like to learn from others.' },
  ];

  return <div className="mx-auto max-w-5xl">
    <div className="mb-8"><p className="text-xs font-bold uppercase tracking-[.18em] text-brand-600">Your profile</p><h1 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">My Skills</h1><p className="mt-2 max-w-2xl text-slate-500">Choose what you can teach and what you are curious to learn. Your matches are based on these skills.</p></div>
    {error && <p role="alert" className="mb-5 rounded-xl bg-rose-50 p-4 text-sm text-rose-700">{error}</p>}
    {loading ? <p className="text-sm text-slate-500">Loading your skills…</p> : <div className="space-y-6">{lists.map(list => {
      const skills = items.filter(item => item.type === list.type);
      return <section key={list.type} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <h2 className="text-xl font-bold text-slate-900">{list.title}</h2><p className="mt-1 text-sm text-slate-500">{list.description}</p>
        <div className="mt-5"><SkillSelector type={list.type} existingSkillIds={skills.map(item => item.skillId)} onAdd={addSkill} /></div>
        {skills.length > 0 ? <div className="mt-4 grid gap-3 sm:grid-cols-2">{skills.map(item => <UserSkillCard key={item.id} item={item} onRemove={removeSkill} />)}</div> : <p className="mt-4 rounded-xl bg-slate-50 px-4 py-5 text-center text-sm text-slate-500">No skills added here yet.</p>}
      </section>;
    })}</div>}
  </div>;
}
