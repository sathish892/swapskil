import { Link } from 'react-router-dom';

export default function Home() {
  return <div className="bg-white">
    <main className="container-x grid min-h-[60vh] place-items-center py-16 text-center">
      <div className="max-w-2xl"><span className="rounded-full bg-brand-50 px-4 py-2 text-sm font-semibold text-brand-700">Learn together. Grow together.</span>
        <h1 className="mt-8 text-5xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-6xl">Share what you know.<br /><span className="text-brand-600">Learn what you love.</span></h1>
        <p className="mx-auto mt-6 max-w-xl text-lg leading-8 text-slate-500">Meet people who want to exchange skills, knowledge, and inspiration.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3"><Link to="/my-skills" className="btn-primary">Build my skill profile</Link><Link to="/matches" className="btn-secondary">Explore matches</Link></div>
      </div>
    </main>
    <section id="how-it-works" className="scroll-mt-28 border-t border-slate-100 bg-slate-50 py-12"><div className="container-x text-center"><h2 className="text-2xl font-bold text-slate-900">How SkillSwap works</h2><p className="mx-auto mt-3 max-w-2xl text-slate-600">Add skills you can teach and skills you want to learn. Find compatible members and send a swap request to start learning together.</p><Link to="/my-skills" className="mt-5 inline-block font-semibold text-brand-700">Set up your skills →</Link></div></section>
    <section id="about" className="scroll-mt-28 py-12"><div className="container-x text-center"><h2 className="text-2xl font-bold text-slate-900">About SkillSwap</h2><p className="mx-auto mt-3 max-w-2xl text-slate-600">A community for exchanging knowledge, discovering new interests, and growing through peer-to-peer learning.</p><Link to="/about" className="mt-4 inline-block font-semibold text-brand-700">Learn more about SkillSwap →</Link></div></section>
  </div>;
}
