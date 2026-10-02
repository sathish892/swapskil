import { useEffect, useMemo, useState } from 'react';
import EmptyMatchState from '../components/EmptyMatchState';
import MatchCard from '../components/MatchCard';
import MatchFilters, { type MatchFiltersValue } from '../components/MatchFilters';
import { apiRequest } from '../service/api';
import type { SkillMatch, UserSkill } from '../types';
import RecommendationSection from '../components/recommendations/RecommendationSection';

type MatchResponse = { items: SkillMatch[]; page: number; pageSize: number; hasMore: boolean };
const initialFilters: MatchFiltersValue = { q: '', skill: '', category: '', level: '', type: '' };

export default function MatchesPage() {
  const [filters, setFilters] = useState(initialFilters);
  const [skills, setSkills] = useState<UserSkill[]>([]);
  const [items, setItems] = useState<SkillMatch[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [profileLoading, setProfileLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiRequest<{ items: UserSkill[] }>('/api/skills/user')
      .then(result => setSkills(result.items))
      .catch(err => setError(err.message || 'Could not load your skill profile.'))
      .finally(() => setProfileLoading(false));
  }, []);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: '12' });
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
    return params.toString();
  }, [filters, page]);

  useEffect(() => {
    if (profileLoading) return;
    let live = true;
    setLoading(true); setError('');
    const timer = window.setTimeout(() => {
      apiRequest<MatchResponse>(`/api/matches?${query}`)
        .then(result => { if (live) { setItems(result.items); setHasMore(result.hasMore); } })
        .catch(err => { if (live) setError(err.message || 'Could not find matches.'); })
        .finally(() => { if (live) setLoading(false); });
    }, 180);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query, profileLoading]);

  function updateFilters(next: MatchFiltersValue) { setFilters(next); setPage(1); }
  const profileConfigured = skills.length > 0;
  const filterSkills = skills.filter(skill => skill.type === 'LEARN').map(({ skillId, name }) => ({ skillId, name }));
  const isFiltered = Object.values(filters).some(Boolean);

  return <div className="mx-auto max-w-7xl">
    <div className="mb-6"><p className="text-xs font-bold uppercase tracking-[.18em] text-brand-600">Make a connection</p><h1 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">Your Skill Matches</h1><p className="mt-2 text-slate-500">Find people who can teach what you want to learn.</p></div>
    <MatchFilters value={filters} skills={filterSkills} onChange={updateFilters} />
    <div className="mt-5"><RecommendationSection mode="users" title="AI-Assisted Recommendations"/></div>
    {error && <p role="alert" className="mt-5 rounded-xl bg-rose-50 p-4 text-sm text-rose-700">{error}</p>}
    {profileLoading || loading ? <div className="grid min-h-48 place-items-center text-sm text-slate-500">Finding thoughtful matches…</div>
      : !profileConfigured ? <div className="mt-5"><EmptyMatchState profileConfigured={false} filtered={isFiltered} /></div>
        : !items.length ? <div className="mt-5"><EmptyMatchState profileConfigured filtered={isFiltered} /></div>
          : <>
            <p className="mb-4 mt-6 text-sm text-slate-500">Showing people whose teaching skills match what you want to learn.</p>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">{items.map(match => <MatchCard key={match.user.id} match={match} />)}</div>
            <div className="mt-7 flex items-center justify-between"><button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => Math.max(1, value - 1))} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-40">Previous</button><span className="text-sm text-slate-500">Page {page}</span><button type="button" disabled={!hasMore || loading} onClick={() => setPage(value => value + 1)} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-40">Next</button></div>
          </>}
  </div>;
}
