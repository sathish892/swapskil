import RatingStars from './RatingStars';

export type RatingSummaryData = {
  teachingAverageRating: number;
  teachingReviewCount: number;
  learningAverageRating: number;
  learningReviewCount: number;
  breakdowns: Record<'TEACHING' | 'LEARNING', Record<number, number>>;
};

export default function RatingSummary({ summary, compact = false }: { summary: RatingSummaryData; compact?: boolean }) {
  const rows = [
    { label: 'Teaching rating', average: summary.teachingAverageRating, count: summary.teachingReviewCount },
    { label: 'Learning rating', average: summary.learningAverageRating, count: summary.learningReviewCount },
  ];
  return <div className={`rounded-2xl border border-slate-200 bg-white ${compact ? 'p-4' : 'p-5 sm:p-6'}`}>
    <h2 className="text-lg font-bold text-slate-900">Separate ratings</h2>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">{rows.map(row => <section key={row.label} className="rounded-xl bg-slate-50 p-4">
      <h3 className="text-sm font-semibold text-slate-700">{row.label}</h3>
      {row.count ? <><div className="mt-1 flex items-center gap-2"><span className="text-2xl font-extrabold tabular-nums text-slate-900">{row.average.toFixed(1)}</span><span className="text-sm text-slate-500">/ 5</span></div><RatingStars value={Math.round(row.average)} size="sm"/><p className="mt-1 text-xs text-slate-500">{row.count} review{row.count === 1 ? '' : 's'}</p></> : <p className="mt-2 text-sm text-slate-500">No reviews yet</p>}
    </section>)}</div>
  </div>;
}
