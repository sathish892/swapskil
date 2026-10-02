import { Link } from 'react-router-dom';

export default function EmptyMatchState({ profileConfigured, filtered }: { profileConfigured: boolean; filtered: boolean }) {
  if (!profileConfigured) return <section className="rounded-3xl border border-dashed border-brand-200 bg-brand-50/70 px-6 py-12 text-center sm:px-12">
    <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white text-2xl text-brand-600 shadow-sm" aria-hidden="true">✦</div>
    <h2 className="mt-5 text-xl font-bold text-slate-900">Build Your Skill Profile</h2>
    <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">Add the skills you can teach and the skills you want to learn to discover your matches.</p>
    <Link to="/my-skills" className="btn-primary mt-6">Add My Skills</Link>
  </section>;
  return <section className="rounded-3xl border border-slate-200 bg-white px-6 py-12 text-center">
    <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-slate-50 text-2xl text-slate-400" aria-hidden="true">⌕</div>
    <h2 className="mt-5 text-xl font-bold text-slate-900">No matches found yet.</h2>
    <p className="mt-2 text-sm text-slate-500">{filtered ? 'Try changing your search or filters.' : 'Try adding more skills or changing your preferences.'}</p>
  </section>;
}
