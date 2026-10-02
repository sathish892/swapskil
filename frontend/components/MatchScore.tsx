export default function MatchScore({ label, type }: { label: string; type: 'DIRECT' | 'MUTUAL' }) {
  const styles = type === 'MUTUAL' ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-brand-50 text-brand-800 ring-brand-200';
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold ring-1 ring-inset ${styles}`}>{type === 'MUTUAL' ? '↔' : '✓'} {label}</span>;
}
