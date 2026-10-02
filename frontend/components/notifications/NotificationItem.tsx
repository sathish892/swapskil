import type { AppNotification } from '../../types';
import { Link } from 'react-router-dom';
import { notificationHref, notificationIcon, notificationTime } from './notificationUtils';

export default function NotificationItem({ item, onRead, onDelete, compact = false }: { item: AppNotification; onRead: (id: string) => void; onDelete?: (id: string) => void; compact?: boolean }) {
  const href = notificationHref(item);
  return <article className={`group flex gap-3 ${compact ? 'p-3' : 'p-4 sm:p-5'} ${item.isRead ? 'bg-white' : 'bg-brand-50/60'}`}>
    <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white text-lg shadow-sm">{notificationIcon(item.type)}</span>
    <div className="min-w-0 flex-1">
      <Link to={href} onClick={() => !item.isRead && onRead(item.id)} className="font-semibold text-slate-900 hover:text-brand-700">{item.title}</Link>
      <p className="mt-1 text-sm leading-5 text-slate-600">{item.message}</p>
      <p className="mt-1.5 text-xs text-slate-400">{notificationTime(item.createdAt)}</p>
    </div>
    <div className="flex shrink-0 items-start gap-2">
      {!item.isRead && <span aria-label="Unread" className="mt-2 h-2 w-2 rounded-full bg-brand-600" />}
      {onDelete && <button type="button" aria-label="Delete notification" onClick={() => onDelete(item.id)} className="rounded-md px-1.5 py-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600">×</button>}
    </div>
  </article>;
}
