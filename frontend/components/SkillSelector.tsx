import { useEffect, useState } from 'react';
import { apiRequest } from '../service/api';
import type { CatalogSkill, SkillKind, SkillLevel } from '../types';

const levels: { value: SkillLevel; label: string }[] = [
  { value: 'BEGINNER', label: 'Beginner' }, { value: 'INTERMEDIATE', label: 'Intermediate' },
  { value: 'ADVANCED', label: 'Advanced' }, { value: 'EXPERT', label: 'Expert' },
];

type Props = {
  type: SkillKind;
  existingSkillIds: string[];
  onAdd: (skill: { skillId?: string; skillName?: string; type: SkillKind; level: SkillLevel }) => Promise<void>;
};

export default function SkillSelector({ type, existingSkillIds, onAdd }: Props) {
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<SkillLevel>('INTERMEDIATE');
  const [selected, setSelected] = useState<{ skillId?: string; skillName?: string } | null>(null);
  const [skills, setSkills] = useState<CatalogSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      apiRequest<{ items: CatalogSkill[] }>(`/api/skills?search=${encodeURIComponent(query.trim())}`)
        .then(result => { if (live) setSkills(result.items); })
        .catch(err => { if (live) setError(err instanceof Error ? err.message : 'Could not search skills.'); })
        .finally(() => { if (live) setLoading(false); });
    }, 150);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query]);

  const options = skills.filter(skill => !existingSkillIds.includes(skill.id));
  const customName = query.trim();
  const canAddCustom = customName.length > 1 && !skills.some(skill => skill.name.toLocaleLowerCase() === customName.toLocaleLowerCase()) && !existingSkillIds.some(id => skills.find(skill => skill.id === id)?.name.toLocaleLowerCase() === customName.toLocaleLowerCase());

  async function add() {
    if (!selected) return;
    setAdding(true); setError('');
    try { await onAdd({ ...selected, type, level }); setQuery(''); setSelected(null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not add this skill.'); }
    finally { setAdding(false); }
  }

  return <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
      <label className="block text-sm font-medium text-slate-700">
        Select a skill
        <input value={query} onChange={event => { setQuery(event.target.value); setSelected(null); }} placeholder="Search skills, e.g. Python or Canva" className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100" />
      </label>
      <label className="block text-sm font-medium text-slate-700 sm:w-44">
        Skill level
        <select value={level} onChange={event => setLevel(event.target.value as SkillLevel)} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100">
          {levels.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    </div>
    <label className="mt-3 block text-sm font-medium text-slate-700">Choose from the list
      <select disabled={loading || adding} value={selected?.skillId || (selected?.skillName ? '__custom__' : '')} onChange={event => { const skill = options.find(option => option.id === event.target.value); setSelected(skill ? { skillId: skill.id } : event.target.value === '__custom__' ? { skillName: customName } : null); }} className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100">
        <option value="">{loading ? 'Searching…' : 'Select a skill'}</option>
        {options.slice(0, 40).map(skill => <option key={skill.id} value={skill.id}>{skill.name} · {skill.category}</option>)}
        {!loading && canAddCustom && <option value="__custom__">Add new skill: {customName}</option>}
      </select>
    </label>
    {selected?.skillName&&<p className="mt-2 text-sm text-slate-600">New skill: <strong>{selected.skillName}</strong></p>}
    <button type="button" disabled={!selected || adding} onClick={() => void add()} className="mt-3 min-h-11 rounded-xl bg-brand-700 px-4 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{adding?'Saving…':type==='TEACH'?'Submit Teaching Skill':'Submit Learning Skill'}</button>
    {error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
  </div>;
}
