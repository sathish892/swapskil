import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiRequest } from '../service/api';
import type { SwapRequest } from '../types';
import { useRealtimeEvent } from '../realtime/events';

type Tab='Received'|'Sent'|'Active'|'Completed';
const tabs:Tab[]=['Received','Sent','Active','Completed'];
function title(status:SwapRequest['status']){return status==='IN_PROGRESS'?'In progress':status==='PENDING'?'Pending':status.charAt(0)+status.slice(1).toLowerCase();}
export default function SwapRequestsPage(){
  const [items,setItems]=useState<SwapRequest[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[tab,setTab]=useState<Tab>('Received');
  async function refresh(){const result=await apiRequest<{items:SwapRequest[]}>('/api/swap-requests');setItems(result.items);}
  useEffect(()=>{void refresh().catch(e=>setError(e.message||'Could not load exchanges.')).finally(()=>setLoading(false));},[]);
  useRealtimeEvent(['NOTIFICATION_CREATED','CONNECTION_READY'],()=>void refresh().catch(e=>setError(e.message||'Could not refresh exchanges.')));
  const grouped=useMemo(()=>({Received:items.filter(i=>i.direction==='RECEIVED'&&['PENDING','REJECTED','CANCELLED'].includes(i.status)),Sent:items.filter(i=>i.direction==='SENT'&&['PENDING','REJECTED','CANCELLED'].includes(i.status)),Active:items.filter(i=>['ACCEPTED','IN_PROGRESS'].includes(i.status)),Completed:items.filter(i=>i.status==='COMPLETED')}),[items]);
  const current=grouped[tab];
  return <main className="mx-auto max-w-5xl"><p className="text-xs font-bold uppercase tracking-[.18em] text-brand-600">Skill exchanges</p><h1 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-900">Swap Requests</h1><p className="mt-2 text-slate-500">Follow requests from the first hello through a completed exchange.</p>
    {error&&<p role="alert" className="mt-5 rounded-xl bg-rose-50 p-4 text-sm text-rose-700">{error}</p>}
    <div role="tablist" aria-label="Exchange requests" className="mt-6 flex gap-2 overflow-x-auto border-b border-slate-200">{tabs.map(name=><button key={name} role="tab" aria-selected={tab===name} onClick={()=>setTab(name)} className={`min-h-11 shrink-0 border-b-2 px-3 text-sm font-semibold ${tab===name?'border-brand-600 text-brand-700':'border-transparent text-slate-500 hover:text-slate-800'}`}>{name}<span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs">{grouped[name].length}</span></button>)}</div>
    {loading?<p className="py-12 text-center text-sm text-slate-500">Loading exchanges…</p>:current.length===0?<div className="mt-5 rounded-3xl border border-slate-200 bg-white p-10 text-center"><p className="font-semibold text-slate-800">No {tab.toLowerCase()} exchanges yet.</p><p className="mt-2 text-sm text-slate-500">Your requests and active exchanges will appear here.</p><Link to="/matches" className="mt-4 inline-flex min-h-10 items-center rounded-xl bg-brand-700 px-4 text-sm font-semibold text-white">Explore skills</Link></div>:<div className="mt-5 grid gap-3 md:grid-cols-2">{current.map(item=>{const sent=item.direction==='SENT';return <article key={item.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-slate-900">{sent?`With ${item.receiverName}`:`With ${item.senderName}`}</p><p className="mt-1 text-sm text-slate-600">{item.skillOffered} <span className="text-brand-600">↔</span> {item.skillWanted}</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">{title(item.status)}</span></div>{item.message&&<p className="mt-3 line-clamp-2 text-sm text-slate-500">“{item.message}”</p>}<p className="mt-3 text-xs text-slate-400">Requested {new Date(item.createdAt).toLocaleDateString()}</p><div className="mt-4 flex flex-wrap gap-2"><Link to={`/swap-requests/${encodeURIComponent(item.id)}`} className="inline-flex min-h-10 items-center rounded-lg bg-brand-700 px-4 text-sm font-semibold text-white hover:bg-brand-800">View exchange</Link>{item.conversationId&&<Link to={`/messages/${encodeURIComponent(item.conversationId)}`} className="inline-flex min-h-10 items-center rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700">Open chat</Link>}</div></article>;})}</div>}
  </main>;
}
