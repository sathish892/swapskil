import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, apiRequest } from '../service/api';
import type { AppNotification } from '../types';
import type { DashboardData } from '../components/dashboard/dashboardTypes';
import { useRealtimeEvent } from '../realtime/events';
import DashboardHeader from '../components/dashboard/DashboardHeader';
import DashboardStatCard from '../components/dashboard/DashboardStatCard';
import DashboardSkeleton from '../components/dashboard/DashboardSkeleton';
import DashboardEmptyState from '../components/dashboard/DashboardEmptyState';
import ProfileCompletionCard from '../components/dashboard/ProfileCompletionCard';
import QuickActions from '../components/dashboard/QuickActions';
import MySkillsCard from '../components/dashboard/MySkillsCard';
import RecommendedMatches from '../components/dashboard/RecommendedMatches';
import PendingSwapRequests from '../components/dashboard/PendingSwapRequests';
import RecentConversations from '../components/dashboard/RecentConversations';
import NotificationPreview from '../components/dashboard/NotificationPreview';
import RecentActivity from '../components/dashboard/RecentActivity';
import DashboardLearningGoals from '../components/dashboard/DashboardLearningGoals';
import ActiveSkillExchanges from '../components/dashboard/ActiveSkillExchanges';
import RecommendationSection from '../components/recommendations/RecommendationSection';
import LearningPathCard from '../components/recommendations/LearningPathCard';
import { Link } from 'react-router-dom';
import { PaymentStatusBadge, paymentAmountLabel } from '../components/payments/Payments';

export default function DashboardPage(){
  const [data,setData]=useState<DashboardData|null>(null);const [loading,setLoading]=useState(true);const [refreshing,setRefreshing]=useState(false);const [error,setError]=useState('');const navigate=useNavigate();
  const load=useCallback(async(initial=false)=>{if(initial)setLoading(true);else setRefreshing(true);setError('');try{setData(await apiRequest<DashboardData>('/api/dashboard'));}catch(e){if(e instanceof ApiError&&e.status===403){navigate('/admin/dashboard',{replace:true});return;}setError('We couldn’t load your dashboard. Please try again.');}finally{setLoading(false);setRefreshing(false);}},[navigate]);
  useEffect(()=>{void load(true);},[load]);
  useRealtimeEvent('NOTIFICATION_CREATED',()=>void load());
  async function markNotification(item:AppNotification){try{await apiRequest(`/api/notifications/${encodeURIComponent(item.id)}/read`,{method:'PATCH'});void load();}catch{setError('We couldn’t update that notification. Please try again.');}}
  if(loading&&!data)return <DashboardSkeleton/>;
  if(error&&!data)return <div className="mx-auto max-w-2xl rounded-2xl border border-rose-100 bg-white p-8 text-center"><h1 className="text-xl font-bold text-slate-900">Something went wrong.</h1><p className="mt-2 text-sm text-slate-600">We couldn’t load your dashboard.</p><button onClick={()=>void load(true)} className="mt-4 min-h-11 rounded-xl bg-brand-700 px-5 font-semibold text-white hover:bg-brand-800">Try Again</button></div>;
  if(!data)return null;
  const empty=!data.skills.teaching.length&&!data.skills.learning.length&&!data.stats.matches&&!data.stats.pendingRequests&&!data.stats.activeExchanges&&!data.stats.completedExchanges&&!data.conversations.length&&!data.notifications.length&&!data.upcomingSessions.length&&!data.stats.teachingReviewCount&&!data.stats.learningReviewCount;
  return <div className="mx-auto max-w-7xl space-y-5" aria-busy={refreshing}>
    <DashboardHeader name={data.profile.name} matches={data.stats.matches} pending={data.stats.pendingRequests}/>
        <section className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between"><h2 className="text-lg font-bold text-slate-900">Recent payments</h2><Link to="/payments" className="text-sm font-semibold text-brand-700">View payment history</Link></div>{data.recentPayments.length?<ul className="mt-3 divide-y divide-slate-100">{data.recentPayments.map(item=><li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3"><span><Link to={`/payments?id=${encodeURIComponent(item.id)}`} className="block font-semibold text-slate-800 hover:underline">{item.description}</Link><time className="text-xs text-slate-500" dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleDateString()}</time></span><span className="flex items-center gap-2"><strong className="text-sm">{paymentAmountLabel(item.amount,item.currency)}</strong><PaymentStatusBadge status={item.status}/></span></li>)}</ul>:<p className="mt-3 text-sm text-slate-500">No payments yet. Your session transactions will appear here.</p>}</section>
    {error&&<p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
    <section aria-label="Your SkillSwap statistics" className="grid grid-cols-2 gap-3 lg:grid-cols-4"><DashboardStatCard title="Matches" value={data.stats.matches} caption="Skill matches" icon="✦" href="/matches"/><DashboardStatCard title="Swap Requests" value={data.stats.pendingRequests} caption="Pending requests" icon="⇄" href="/swap-requests"/><DashboardStatCard title="Active Exchanges" value={data.stats.activeExchanges} caption="Accepted or in progress" icon="↔" href="/swap-requests"/><DashboardStatCard title="Teaching rating" value={data.stats.teachingReviewCount?`${data.stats.teachingAverageRating.toFixed(1)} ★`:'—'} caption={`${data.stats.teachingReviewCount} reviews`} icon="★" href="/profile#reviews"/><DashboardStatCard title="Learning rating" value={data.stats.learningReviewCount?`${data.stats.learningAverageRating.toFixed(1)} ★`:'—'} caption={`${data.stats.learningReviewCount} reviews`} icon="★" href="/profile#reviews"/><DashboardStatCard title="Subscription" value={data.subscription?.status||'None'} caption={data.subscription?.endAt?`Until ${new Date(data.subscription.endAt).toLocaleDateString()}`:'View available plans'} icon="◇" href="/subscription"/></section>
    {empty&&<DashboardEmptyState/>}

    <RecommendationSection mode="all" title="Recommended for You"/>
    <LearningPathCard/>

    <section className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between"><h2 className="text-lg font-bold text-slate-900">Upcoming sessions</h2><Link to="/sessions" className="text-sm font-semibold text-brand-700">All sessions</Link></div>{data.upcomingSessions.length?<ul className="mt-3 divide-y divide-slate-100">{data.upcomingSessions.map(item=><li key={item.id} className="py-3"><Link to={`/sessions/${encodeURIComponent(item.id)}`} className="flex flex-wrap items-center justify-between gap-2"><span><span className="block font-semibold text-slate-800">With {item.peerName}</span><span className="text-sm text-slate-500">{item.skillOffered} ↔ {item.skillWanted} · {item.status==='PROPOSED'?'Awaiting response':'Confirmed'}</span></span><time className="text-sm text-brand-700" dateTime={item.startAt}>{new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',timeZone:item.timezone}).format(new Date(item.startAt))} ({item.timezone})</time></Link></li>)}</ul>:<p className="mt-3 text-sm text-slate-500">No upcoming sessions yet. Set your availability or schedule one from an active exchange.</p>}<Link to="/availability" className="mt-3 inline-flex min-h-10 items-center rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700">Set availability</Link></section>
    <div className="grid items-start gap-4 lg:grid-cols-12"><div className="space-y-4 lg:col-span-7"><ProfileCompletionCard value={data.profile.completion}/><MySkillsCard teaching={data.skills.teaching} learning={data.skills.learning}/><DashboardLearningGoals goals={data.profile.learningGoals}/><RecentActivity items={data.recentActivity}/></div><div className="space-y-4 lg:col-span-5"><QuickActions/><RecommendedMatches items={data.matches}/><PendingSwapRequests items={data.swapRequests} onChanged={()=>void load()}/><ActiveSkillExchanges items={data.activeSwaps}/><RecentConversations items={data.conversations}/><NotificationPreview items={data.notifications} onOpen={item=>void markNotification(item)}/></div></div>
  </div>;
}
