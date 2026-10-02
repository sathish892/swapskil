import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../service/api';
import type { AppNotification } from '../types';
import NotificationFilters from '../components/notifications/NotificationFilters';
import NotificationList from '../components/notifications/NotificationList';
import { useRealtimeEvent } from '../realtime/events';

type Response = { items: AppNotification[]; page: number; total: number; unreadCount: number; hasMore: boolean };
export default function NotificationsPage() {
  const [filter, setFilter] = useState<'all'|'unread'>('all'); const [page, setPage] = useState(1); const [data, setData] = useState<Response>({items:[],page:1,total:0,unreadCount:0,hasMore:false}); const [loading,setLoading]=useState(true); const [error,setError]=useState('');
  const refresh = useCallback(async () => { setLoading(true);setError('');try{setData(await apiRequest<Response>(`/api/notifications?filter=${filter}&page=${page}&limit=20`));}catch(e){setError(e instanceof Error?e.message:'Could not load notifications.');}finally{setLoading(false);}},[filter,page]);
  useEffect(()=>{void refresh();},[refresh]);
  useRealtimeEvent('NOTIFICATION_CREATED',()=>void refresh());
  function changed(){window.dispatchEvent(new Event('skillswap-notifications-changed'));}
  async function markRead(id:string){try{await apiRequest(`/api/notifications/${encodeURIComponent(id)}/read`,{method:'PATCH'});setData(old=>({...old,items:filter==='unread'?old.items.filter(item=>item.id!==id):old.items.map(item=>item.id===id?{...item,isRead:true}:item),total:filter==='unread'?Math.max(0,old.total-1):old.total,unreadCount:Math.max(0,old.unreadCount-1)}));changed();}catch(e){setError(e instanceof Error?e.message:'Could not update notification.');}}
  async function markAll(){try{await apiRequest('/api/notifications/read-all',{method:'PATCH'});setData(old=>({...old,items:filter==='unread'?[]:old.items.map(item=>({...item,isRead:true})),total:filter==='unread'?0:old.total,unreadCount:0}));changed();}catch(e){setError(e instanceof Error?e.message:'Could not update notifications.');}}
  async function clearRead(){try{const result=await apiRequest<{deleted:number}>('/api/notifications/read',{method:'DELETE'});setData(old=>({...old,items:filter==='all'?old.items.filter(item=>!item.isRead):old.items,total:filter==='all'?Math.max(0,old.total-result.deleted):old.total}));changed();}catch(e){setError(e instanceof Error?e.message:'Could not clear read notifications.');}}
  async function remove(id:string){try{await apiRequest(`/api/notifications/${encodeURIComponent(id)}`,{method:'DELETE'});setData(old=>({...old,items:old.items.filter(item=>item.id!==id),total:Math.max(0,old.total-1),unreadCount:Math.max(0,old.unreadCount-(old.items.some(item=>item.id===id&&!item.isRead)?1:0))}));changed();}catch(e){setError(e instanceof Error?e.message:'Could not delete notification.');}}
  return <section className="mx-auto max-w-4xl">
    <p className="text-xs font-bold uppercase tracking-[.18em] text-brand-600">Your updates</p><div className="mt-2 flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-3xl font-extrabold tracking-tight text-slate-900">Notifications</h1><p className="mt-2 text-slate-500">Stay updated with your SkillSwap activity.</p></div><div className="flex gap-2"><button onClick={()=>void clearRead()} disabled={!data.total||loading} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Clear read</button><button onClick={()=>void markAll()} disabled={!data.unreadCount} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Mark all as read</button></div></div>
    <div className="mt-6"><NotificationFilters value={filter} onChange={value=>{setFilter(value);setPage(1);}}/></div>
    {error&&<div role="alert" className="mt-4 rounded-xl bg-rose-50 p-4 text-sm text-rose-700">{error}<button onClick={()=>void refresh()} className="ml-2 font-semibold underline">Retry</button></div>}
    <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white"><NotificationList items={data.items} loading={loading} onRead={id=>void markRead(id)} onDelete={id=>void remove(id)}/></div>
    {!loading&&data.total>0&&<div className="mt-4 flex items-center justify-between text-sm text-slate-500"><span>{data.total} notification{data.total===1?'':'s'} · page {page}</span><div className="flex gap-2"><button disabled={page<=1} onClick={()=>setPage(n=>n-1)} className="rounded-lg border px-3 py-1.5 disabled:opacity-40">Previous</button><button disabled={!data.hasMore} onClick={()=>setPage(n=>n+1)} className="rounded-lg border px-3 py-1.5 disabled:opacity-40">Next</button></div></div>}
  </section>;
}
