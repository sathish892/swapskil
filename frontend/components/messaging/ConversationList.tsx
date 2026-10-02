import type { Conversation } from '../../types';
import ConversationItem from './ConversationItem';
import EmptyConversation from './EmptyConversation';
import MessageLoading from './MessageLoading';

export default function ConversationList({items,selectedId,search,onSearch,onSelect,loading,error,onRetry}:{items:Conversation[];selectedId?:string;search:string;onSearch:(value:string)=>void;onSelect:(id:string)=>void;loading:boolean;error:string;onRetry:()=>void}){
  const filtered=items.filter(item=>item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <aside className="flex min-h-0 flex-col border-r border-slate-200 bg-white"><div className="border-b border-slate-100 p-4"><h1 className="text-xl font-bold text-slate-900">Messages</h1><label className="sr-only" htmlFor="conversation-search">Search conversations</label><input id="conversation-search" value={search} onChange={e=>onSearch(e.target.value)} placeholder="Search conversations…" className="mt-3 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100"/></div><div className="min-h-0 flex-1 overflow-y-auto">{error?<div role="alert" className="p-5 text-center text-sm text-rose-700">{error}<button onClick={onRetry} className="mt-2 block w-full font-semibold text-brand-700">Try again</button></div>:loading?<MessageLoading label="Loading conversations…"/>:!items.length?<EmptyConversation/>:!filtered.length?<p className="p-6 text-center text-sm text-slate-500">No conversations found.</p>:filtered.map(item=><ConversationItem key={item.conversationId} item={item} selected={item.conversationId===selectedId} onClick={()=>onSelect(item.conversationId)}/>)}</div></aside>;
}
