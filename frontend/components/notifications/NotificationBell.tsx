import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { apiRequest } from '../../service/api';
import NotificationBadge from './NotificationBadge';
import NotificationDropdown from './NotificationDropdown';
import { useRealtimeEvent } from '../../realtime/events';

export default function NotificationBell() {
  const [count, setCount] = useState(0); const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => { let live = true; const refresh = () => apiRequest<{ unreadCount: number }>('/api/notifications/unread-count').then(data => { if (live) setCount(data.unreadCount); }).catch(() => {}); void refresh(); const onChange = () => void refresh(); window.addEventListener('skillswap-notifications-changed', onChange); return () => { live = false; window.removeEventListener('skillswap-notifications-changed', onChange); }; }, []);
  useRealtimeEvent(['NOTIFICATION_CREATED','CONNECTION_READY'],()=>window.dispatchEvent(new Event('skillswap-notifications-changed')));
  return <div className="relative"><button type="button" aria-label={`Notifications${count ? `, ${count} unread` : ''}`} aria-expanded={open} onClick={() => setOpen(value => !value)} className="relative grid h-9 w-9 place-items-center rounded-full text-lg text-slate-600 hover:bg-slate-100 hover:text-brand-700">🔔<NotificationBadge count={count}/></button>{open && <><button className="fixed inset-0 z-20 cursor-default" aria-label="Close notifications" onClick={() => setOpen(false)} /><NotificationDropdown open={open} onChanged={() => window.dispatchEvent(new Event('skillswap-notifications-changed'))}/></>}</div>;
}
