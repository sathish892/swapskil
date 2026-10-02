import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import UnreadBadge from '../components/messaging/UnreadBadge';
import NotificationBell from '../components/notifications/NotificationBell';
import { emitRealtime } from '../realtime/events';

type SessionUser = { id: string; name: string; role: string; status?: string };

export default function MainLayout() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [unreadCount,setUnreadCount]=useState(0);
  const [connection,setConnection]=useState<'connecting'|'connected'|'reconnecting'>('connecting');
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    fetch('/api/auth/session', { credentials: 'include' })
      .then(async response => response.ok ? (await response.json() as { user: SessionUser }).user : null)
      .then(setUser).catch(() => setUser(null));
  }, [location.pathname]);
  useEffect(()=>{if(!user){setUnreadCount(0);setConnection('connecting');return;}if(user.status!=='active')return;let live=true;const refresh=()=>fetch('/api/conversations/unread-count',{credentials:'include'}).then(r=>r.ok?r.json():{unreadCount:0}).then((r:{unreadCount:number})=>{if(live)setUnreadCount(Number(r.unreadCount)||0)}).catch(()=>{});void refresh();const source=new EventSource('/api/realtime/events');source.onopen=()=>{if(live){setConnection('connected');void refresh();emitRealtime({type:'CONNECTION_READY'});}};source.onerror=()=>{if(live)setConnection('reconnecting');};source.onmessage=event=>{try{const value=JSON.parse(event.data) as {type:string};if(value.type==='SESSION_REVOKED'){source.close();setUser(null);navigate('/login',{replace:true});return;}if(value.type==='SESSION_UNAVAILABLE'){source.close();void fetch('/api/auth/session',{credentials:'include'}).then(async response=>{if(!live)return;if(response.ok)setUser((await response.json() as {user:SessionUser}).user);else{setUser(null);navigate('/login',{replace:true});}});return;}emitRealtime(value);if(['MESSAGE_CREATED','MESSAGE_READ'].includes(value.type))void refresh();}catch{/* Ignore malformed event frames and keep the connection alive. */}};return()=>{live=false;source.close();};},[user?.id,user?.status,navigate]);
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setUser(null); navigate('/', { replace: true });
  }
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="container-x flex min-h-16 flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
          <Link to="/" className="shrink-0 text-xl font-extrabold tracking-tight text-brand-700">SkillSwap<span className="text-brand-400">.</span></Link>
          <nav aria-label="Main navigation" className="order-3 flex w-full flex-wrap items-center gap-x-4 gap-y-2 text-sm font-medium text-slate-600 sm:order-none sm:w-auto">
            <Link to="/" className="whitespace-nowrap hover:text-brand-700">Home</Link>
            <Link to="/find-skills" className="whitespace-nowrap hover:text-brand-700">Find Skills</Link>
            <Link to="/matches" className="whitespace-nowrap hover:text-brand-700">Matches</Link>
            {user&&<Link to="/messages" aria-label={`Messages${unreadCount?`, ${unreadCount} unread`:''}`} className="inline-flex items-center gap-1.5 whitespace-nowrap hover:text-brand-700">Messages<UnreadBadge count={unreadCount}/></Link>}
            {user&&<NotificationBell/>}
            {user?.role==='user'&&<Link to="/dashboard" className="whitespace-nowrap hover:text-brand-700">Dashboard</Link>}
            {user?.role==='user'&&<Link to="/availability" className="whitespace-nowrap hover:text-brand-700">Availability</Link>}
            {user?.role==='user'&&<Link to="/sessions" className="whitespace-nowrap hover:text-brand-700">Sessions</Link>}
            {user?.role==='user'&&<Link to="/payments" className="whitespace-nowrap hover:text-brand-700">Payments</Link>}
            {user?.role==='user'&&<Link to="/subscription" className="whitespace-nowrap hover:text-brand-700">Subscription</Link>}
            <Link to="/#how-it-works" className="whitespace-nowrap hover:text-brand-700">How It Works</Link>
            <Link to="/about" className="whitespace-nowrap hover:text-brand-700">About</Link>
            {user && <Link to="/profile" className="whitespace-nowrap hover:text-brand-700">Profile</Link>}
            {user?.role==='user'&&<Link to="/profile/edit" className="whitespace-nowrap hover:text-brand-700">Settings</Link>}
            {user?.role==='user'&&<Link to="/settings/privacy" className="whitespace-nowrap hover:text-brand-700">Privacy & Safety</Link>}
            <Link to="/safety" className="whitespace-nowrap hover:text-brand-700">Safety</Link>
            {user && <Link to="/swap-requests" className="whitespace-nowrap hover:text-brand-700">Swap Requests</Link>}
          </nav>
          <div className="flex items-center gap-3 text-sm">
            {user ? <><span className="hidden max-w-36 truncate font-medium text-slate-600 sm:inline">Hi, {user.name}</span>{user.role === 'admin' && <Link to="/admin/dashboard" className="font-semibold text-brand-700">Admin</Link>}<button onClick={() => void logout()} className="font-semibold text-slate-600 hover:text-slate-900">Logout</button></> : <><Link to="/login" className="font-semibold text-slate-600 hover:text-brand-700">Sign in</Link><Link to="/register" className="rounded-xl bg-brand-600 px-3.5 py-2 font-semibold text-white hover:bg-brand-700">Join</Link></>}
          </div>
        </div>
      </header>
      {user?.status==='suspended'&&<div role="alert" className="border-b border-rose-200 bg-rose-50 px-4 py-3 text-center text-sm font-semibold text-rose-800">Your account is currently suspended. Please contact support.</div>}
      {user&&connection!=='connecting'&&<div role="status" className={`border-b px-4 py-1.5 text-center text-xs font-medium ${connection==='connected'?'border-emerald-100 bg-emerald-50 text-emerald-800':'border-amber-200 bg-amber-50 text-amber-800'}`}>{connection==='connected'?'Connected':'Reconnecting…'}</div>}
      <main className="container-x w-full flex-1 py-7 sm:py-10">
        <Outlet />
      </main>
      <footer className="border-t border-slate-200 bg-white py-5"><div className="container-x flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500"><span>Learn together. Grow together.</span><Link to="/about" className="font-semibold hover:text-brand-700">About SkillSwap</Link></div></footer>
    </div>
  );
}
