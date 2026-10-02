import { Link } from 'react-router-dom';

const sections = [
  { title: 'What is SkillSwap?', body: 'SkillSwap helps people exchange knowledge with compatible peers: teach a skill you know, and learn a skill you want to practice.' },
  { title: 'How SkillSwap works', body: 'Add the skills you can teach and the skills you want to learn. SkillSwap helps you discover people whose skills and learning goals fit yours.' },
  { title: 'Learn and teach', body: 'Share practical knowledge with another member while learning something new from them. Keep your teaching and learning skills in separate parts of your profile.' },
  { title: 'Skill matching', body: 'Browse skills and compatible members, review their profiles, and send a skill exchange request when you find a good fit.' },
  { title: 'Communicate and schedule', body: 'Use messaging to coordinate your exchange, then arrange a learning session that works for both people.' },
];

export default function AboutPage() {
  return <main className="mx-auto max-w-4xl space-y-8">
    <header className="rounded-3xl bg-brand-700 px-6 py-10 text-white sm:px-10"><p className="text-xs font-bold uppercase tracking-[.18em] text-brand-100">About SkillSwap</p><h1 className="mt-3 text-3xl font-extrabold sm:text-4xl">Learn from each other. Grow together.</h1><p className="mt-4 max-w-2xl leading-7 text-brand-50">SkillSwap is a peer learning platform for people who want to teach skills they know, learn skills they want, and connect through shared knowledge.</p></header>
    <section className="grid gap-4 sm:grid-cols-2" aria-label="How SkillSwap works">{sections.map(section => <article key={section.title} className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="text-lg font-bold text-slate-900">{section.title}</h2><p className="mt-2 text-sm leading-6 text-slate-600">{section.body}</p></article>)}</section>
    <section className="rounded-2xl border border-brand-100 bg-brand-50 p-6"><h2 className="text-lg font-bold text-slate-900">Our mission</h2><p className="mt-2 leading-7 text-slate-600">Make learning more collaborative by helping people exchange useful skills, build a profile of what they know and want to learn, and find compatible learning partners.</p><Link to="/find-skills" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-brand-700 px-4 font-semibold text-white">Explore skills</Link></section>
  </main>;
}
