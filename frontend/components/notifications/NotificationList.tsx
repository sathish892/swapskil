import type { AppNotification } from '../../types';
import NotificationItem from './NotificationItem';
import NotificationSkeleton from './NotificationSkeleton';
import NotificationEmptyState from './NotificationEmptyState';

export default function NotificationList({ items, loading, onRead, onDelete, compact = false }: { items: AppNotification[]; loading: boolean; onRead: (id: string) => void; onDelete?: (id: string) => void; compact?: boolean }) {
  if (loading) return <NotificationSkeleton />;
  if (!items.length) return <NotificationEmptyState compact={compact} />;
  return <div className="divide-y divide-slate-100">{items.map(item => <NotificationItem key={item.id} item={item} onRead={onRead} onDelete={onDelete} compact={compact} />)}</div>;
}
