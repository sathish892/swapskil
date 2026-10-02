import { Link } from 'react-router-dom';
import MatchScore from './MatchScore';
import SwapRequestButton from './SwapRequestButton';
import type { SkillMatch } from '../types';

function SkillPills({ title, skills, icon }: { title: string; skills: { skillId: string; name: string; level: string }[]; icon: string }) {
  return <div className="min-w-0"><h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">{title}</h3>{skills.length ? <ul className="mt-2 flex flex-wrap gap-2">{skills.slice(0, 5).map(skill => <li key={skill.skillId} className="max-w-full truncate rounded-full bg-slate-50 px-3 py-1.5 text-sm text-slate-700"><span aria-hidden="true">{icon} </span>{skill.name}<span className="ml-1.5 text-xs text-slate-400">{skill.level.charAt(0) + skill.level.slice(1).toLowerCase()}</span></li>)}</ul> : <p className="mt-2 text-sm text-slate-400">Not added yet</p>}</div>;
}

export default function MatchCard({ match }: { match: SkillMatch }) {
  const initials = match.user.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  return <article className="flex min-w-0 flex-col rounded-3xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-soft sm:p-6">
    <div className="flex min-w-0 items-start gap-4">
      <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-100 to-indigo-100 text-lg font-bold text-brand-800" aria-label={`${match.user.name} profile image placeholder`}>{initials}</div>
      <div className="min-w-0 flex-1"><h2 className="truncate text-lg font-bold text-slate-900">{match.user.name}{match.user.verificationStatus==='VERIFIED'&&<span title="Profile verified by SkillSwap" className="ml-2 text-sm text-emerald-700">✓ Verified</span>}</h2><p className="mt-1 line-clamp-2 min-h-5 text-sm leading-5 text-slate-500">{match.user.bio || 'SkillSwap member, ready to learn and share.'}</p><p className="mt-1 text-xs text-amber-700">{match.user.teachingRating?.totalReviews?`Teaching ★ ${match.user.teachingRating.averageRating.toFixed(1)} (${match.user.teachingRating.totalReviews})`:'Teaching —'} · {match.user.learningRating?.totalReviews?`Learning ★ ${match.user.learningRating.averageRating.toFixed(1)} (${match.user.learningRating.totalReviews})`:'Learning —'}</p></div>
    </div>
    <div className="mt-5 grid gap-4 sm:grid-cols-2"><SkillPills title="Can teach" skills={match.teaches} icon="✦" /><SkillPills title="Wants to learn" skills={match.learns} icon="↗" /></div>
    <div className="mt-5 flex flex-wrap items-center gap-2">
      <MatchScore label={match.label} type={match.matchType} />
      {match.directSkills.slice(0, 2).map(skill => <span key={skill.skillId} className="rounded-full bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800">Can teach {skill.name}</span>)}
    </div>
    <div className="mt-auto pt-4"><div className="flex items-center justify-between gap-4"><Link to={`/profile/${match.user.id}`} className="text-sm font-semibold text-brand-700 hover:underline">View Profile</Link><span className="text-xs text-slate-400">{match.matchType === 'MUTUAL' ? 'Two-way match' : 'Direct skill match'}</span></div><SwapRequestButton match={match} /></div>
  </article>;
}
