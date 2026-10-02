import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AppNotification } from '../../types';
import { apiRequest } from '../../service/api';
import NotificationList from './NotificationList';
import { useRealtimeEvent } from '../../realtime/events';

export default function NotificationDropdown({ open, onChanged }: { open: boolean; onChanged: () => void }) {
  const [items, setItems] = useState<AppNotification[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  async function refresh() { setLoading(true); setError(''); try { const data = await apiRequest<{ items: AppNotification[] }>('/api/notifications?limit=5'); setItems(data.items); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load notifications.'); } finally { setLoading(false); } }
  useEffect(() => { if (open) void refresh(); }, [open]);
  useRealtimeEvent('NOTIFICATION_CREATED',()=>{if(open)void refresh();});
  async function read(id: string) { try { await apiRequest(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'PATCH' }); setItems(old => old.map(item => item.id === id ? { ...item, isRead: true } : item)); onChanged(); } catch { /* The page can retry if the request fails. */ } }
  async function readAll() { try { await apiRequest('/api/notifications/read-all', { method: 'PATCH' }); setItems(old => old.map(item => ({ ...item, isRead: true }))); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not update notifications.'); } }
  return <div className="absolute right-0 top-full z-30 mt-3 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
    <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3"><h2 className="font-bold text-slate-900">Notifications</h2><button onClick={() => void readAll()} className="text-xs font-semibold text-brand-700 hover:underline">Mark all read</button></div>
    {error ? <div className="p-4 text-sm text-rose-700"><p role="alert">{error}</p><button onClick={() => void refresh()} className="mt-2 font-semibold underline">Try again</button></div> : <NotificationList items={items} loading={loading} onRead={id => void read(id)} compact />}
    <Link to="/notifications" className="block border-t border-slate-100 px-4 py-3 text-center text-sm font-semibold text-brand-700 hover:bg-slate-50">View all notifications</Link>
  </div>;
}
