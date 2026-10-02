export type MatchFiltersValue = { q: string; skill: string; category: string; level: string; type: string };
const categories = ['Programming', 'Technology', 'Data', 'Design', 'Creative', 'Communication', 'Languages', 'Marketing', 'Business', 'Finance', 'Music', 'Wellness', 'Lifestyle', 'Education', 'Other'];
const levels = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'];
const levelLabels: Record<string, string> = { BEGINNER: 'Beginner', INTERMEDIATE: 'Intermediate', ADVANCED: 'Advanced', EXPERT: 'Expert' };

export default function MatchFilters({ value, skills, onChange }: { value: MatchFiltersValue; skills: { skillId: string; name: string }[]; onChange: (next: MatchFiltersValue) => void }) {
  const update = (key: keyof MatchFiltersValue, next: string) => onChange({ ...value, [key]: next });
  const selectStyle = 'w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100';
  return <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5" aria-label="Filter skill matches">
    <label className="block text-sm font-medium text-slate-700">Search matches
      <input type="search" value={value.q} onChange={event => update('q', event.target.value)} placeholder="Search matches…" className={`${selectStyle} mt-1.5`} />
    </label>
    <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <label className="min-w-0 text-xs font-semibold text-slate-500">Skill<select value={value.skill} onChange={event => update('skill', event.target.value)} className={`${selectStyle} mt-1`}><option value="">All skills</option>{skills.map(skill => <option key={skill.skillId} value={skill.skillId}>{skill.name}</option>)}</select></label>
      <label className="min-w-0 text-xs font-semibold text-slate-500">Category<select value={value.category} onChange={event => update('category', event.target.value)} className={`${selectStyle} mt-1`}><option value="">All categories</option>{categories.map(category => <option key={category} value={category}>{category}</option>)}</select></label>
      <label className="min-w-0 text-xs font-semibold text-slate-500">Skill level<select value={value.level} onChange={event => update('level', event.target.value)} className={`${selectStyle} mt-1`}><option value="">All levels</option>{levels.map(level => <option key={level} value={level}>{levelLabels[level]}</option>)}</select></label>
      <label className="min-w-0 text-xs font-semibold text-slate-500">Match type<select value={value.type} onChange={event => update('type', event.target.value)} className={`${selectStyle} mt-1`}><option value="">All matches</option><option value="DIRECT">Direct matches</option><option value="MUTUAL">Mutual matches</option></select></label>
    </div>
  </section>;
}
