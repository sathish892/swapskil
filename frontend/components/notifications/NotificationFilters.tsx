export default function NotificationFilters({ value, onChange }: { value: 'all' | 'unread'; onChange: (value: 'all' | 'unread') => void }) {
  return <div className="flex gap-2" role="group" aria-label="Filter notifications">{(['all', 'unread'] as const).map(filter => <button key={filter} onClick={() => onChange(filter)} className={`rounded-full px-4 py-2 text-sm font-semibold capitalize ${value === filter ? 'bg-brand-700 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'}`}>{filter}</button>)}</div>;
}
