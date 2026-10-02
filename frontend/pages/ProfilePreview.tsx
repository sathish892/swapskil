import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiRequest } from '../service/api';
import type { MatchSkill } from '../types';

type Profile = { user: { id: string; name: string; bio: string; createdAt: string }; teaches: MatchSkill[]; learns: MatchSkill[] };
function SkillGroup({ title, skills }: { title: string; skills: MatchSkill[] }) {
  return <section className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-bold text-slate-900">{title}</h2>{skills.length ? <ul className="mt-4 flex flex-wrap gap-2">{skills.map(skill => <li key={skill.skillId} className="rounded-full bg-slate-50 px-3 py-2 text-sm text-slate-700">{skill.name}<span className="ml-1.5 text-xs text-slate-400">· {skill.level.charAt(0) + skill.level.slice(1).toLowerCase()}</span></li>)}</ul> : <p className="mt-3 text-sm text-slate-500">No skills listed yet.</p>}</section>;
}

export default function ProfilePreview() {
  const { userId = '' } = useParams();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { apiRequest<Profile>(`/api/matches/${encodeURIComponent(userId)}`).then(setProfile).catch(err => setError(err.message || 'Could not load this profile.')); }, [userId]);
  if (error) return <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-700">{error}</p>;
  if (!profile) return <p className="py-20 text-center text-sm text-slate-500">Loading profile…</p>;
  const initials = profile.user.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  return <div className="mx-auto max-w-3xl">
    <Link to="/matches" className="text-sm font-semibold text-brand-700 hover:underline">← Back to matches</Link>
    <section className="mt-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <div className="flex items-center gap-4"><div className="grid h-16 w-16 place-items-center rounded-2xl bg-brand-100 text-xl font-bold text-brand-800">{initials}</div><div><p className="text-xs font-bold uppercase tracking-wider text-brand-600">SkillSwap member</p><h1 className="mt-1 text-2xl font-extrabold text-slate-900">{profile.user.name}</h1></div></div>
      <p className="mt-5 whitespace-pre-wrap text-sm leading-6 text-slate-600">{profile.user.bio || 'This member is looking forward to learning and sharing skills.'}</p>
    </section>
    <div className="mt-4 grid gap-4 sm:grid-cols-2"><SkillGroup title="Can teach" skills={profile.teaches} /><SkillGroup title="Wants to learn" skills={profile.learns} /></div>
  </div>;
}
