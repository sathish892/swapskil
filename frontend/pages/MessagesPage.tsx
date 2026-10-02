import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiRequest } from '../service/api';
import type { ChatMessage, Conversation } from '../types';
import ConversationList from '../components/messaging/ConversationList';
import ChatWindow from '../components/messaging/ChatWindow';
import { useRealtimeEvent, type RealtimeEvent } from '../realtime/events';

type Peer={id:string;name:string;avatar:string|null};
const refreshEvents=['MESSAGE_CREATED','MESSAGE_READ','SWAP_REQUEST_CREATED','SWAP_REQUEST_ACCEPTED','SWAP_REQUEST_REJECTED','SESSION_CREATED','SESSION_UPDATED','SESSION_CANCELED','PAYMENT_SUCCESS','PAYMENT_FAILED','CONNECTION_READY'];
export default function MessagesPage(){
  const {conversationId}=useParams();const navigate=useNavigate();
  const [items,setItems]=useState<Conversation[]>([]);const [viewerId,setViewerId]=useState('');const [search,setSearch]=useState('');const [listLoading,setListLoading]=useState(true);const [listError,setListError]=useState('');const [messages,setMessages]=useState<ChatMessage[]>([]);const [peer,setPeer]=useState<Peer|null>(null);const peerIdRef=useRef<string|null>(null);peerIdRef.current=peer?.id||null;const [chatLoading,setChatLoading]=useState(false);const [chatError,setChatError]=useState('');const [sendError,setSendError]=useState('');const [sending,setSending]=useState(false);const [presence,setPresence]=useState<'ONLINE'|'OFFLINE'|'HIDDEN'|null>(null);const [typing,setTyping]=useState(false);
  const refreshList=useCallback(async()=>{try{const result=await apiRequest<{items:Conversation[]}>('/api/conversations');setItems(result.items);setListError('');}catch(e){setListError(e instanceof Error?e.message:'Failed to load conversations.');}finally{setListLoading(false);}},[]);
  useEffect(()=>{apiRequest<{user:{id:string}}>('/api/auth/session').then(r=>setViewerId(r.user.id)).catch(()=>setViewerId(''));void refreshList();},[refreshList]);
  useRealtimeEvent(refreshEvents,()=>void refreshList());
  useEffect(()=>{
    if(!conversationId){setMessages([]);setPeer(null);setChatError('');setPresence(null);setTyping(false);return;}
    let live=true,fetching=false;setChatLoading(true);setChatError('');setPeer(null);setMessages([]);setPresence(null);setTyping(false);
    const load=async()=>{if(fetching||document.visibilityState!=='visible')return;fetching=true;try{await apiRequest(`/api/conversations/${encodeURIComponent(conversationId)}/read`,{method:'PATCH'});const result=await apiRequest<{items:ChatMessage[];otherUser:Peer}>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);if(live){setMessages(result.items);setPeer(result.otherUser);setChatError('');void refreshList();void apiRequest<{visible:boolean;state?:'ONLINE'|'OFFLINE'}>(`/api/realtime/presence/${encodeURIComponent(result.otherUser.id)}`).then(x=>{if(live)setPresence(x.visible?x.state||'OFFLINE':'HIDDEN')}).catch(()=>{if(live)setPresence(null)});}}catch(e){if(live){setChatError(e instanceof Error&&'status'in e&&(e as {status:number}).status===404?'This conversation is unavailable.':'Failed to load messages. Please try again.');setPeer(null);}}finally{if(live)setChatLoading(false);fetching=false;}};
    const onRealtime=(raw:Event)=>{const {detail}=raw as CustomEvent<RealtimeEvent>;if(!detail)return;
      if(detail.type==='CONNECTION_READY'){void load();return;}
      if(detail.conversationId!==conversationId)return;
      if(detail.type==='MESSAGE_CREATED'){const message=detail.message as ChatMessage|undefined;if(message)setMessages(current=>current.some(x=>x.id===message.id)?current:[...current,message]);void refreshList();}
      if(detail.type==='MESSAGE_READ'&&detail.readerId!==viewerId){const now=new Date().toISOString();setMessages(current=>current.map(message=>message.senderId===viewerId&&!message.readAt?{...message,readAt:now}:message));}
      if(detail.type==='PRESENCE_CHANGED'&&detail.userId===peerIdRef.current)setPresence(detail.state==='ONLINE'?'ONLINE':'OFFLINE');
      if(detail.type==='TYPING_STARTED'&&detail.userId===peerIdRef.current)setTyping(true);
      if(detail.type==='TYPING_STOPPED'&&detail.userId===peerIdRef.current)setTyping(false);
    };
    window.addEventListener('skillswap-realtime-event',onRealtime);void load();const visibility=()=>{if(document.visibilityState==='visible')void load();};document.addEventListener('visibilitychange',visibility);return()=>{live=false;document.removeEventListener('skillswap-realtime-event',onRealtime);document.removeEventListener('visibilitychange',visibility);};
  },[conversationId,refreshList,viewerId]);
  const send=async(content:string)=>{if(!conversationId)return;setSending(true);setSendError('');try{const result=await apiRequest<{item:ChatMessage}>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`,{method:'POST',body:JSON.stringify({content})});setMessages(current=>current.some(x=>x.id===result.item.id)?current:[...current,result.item]);void refreshList();}catch(e){const message=e instanceof Error?e.message:'Failed to send message. Please try again.';setSendError(message);throw e;}finally{setSending(false);}};
  const sendTyping=useCallback((active:boolean)=>{if(!conversationId)return;void apiRequest('/api/realtime/typing',{method:'POST',body:JSON.stringify({conversationId,action:active?'start':'stop'})}).catch(()=>{});},[conversationId]);
  const select=(id:string)=>navigate(`/messages/${encodeURIComponent(id)}`);
  return <div className="mx-auto max-w-7xl"><div className="mb-4 hidden md:block"><p className="text-xs font-bold uppercase tracking-[.18em] text-brand-600">SkillSwap conversations</p><h1 className="mt-1 text-2xl font-extrabold text-slate-900">Messages</h1></div><div className="grid h-[calc(100dvh-12rem)] min-h-[500px] max-h-[820px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm md:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]"><div className={`${conversationId?'hidden md:flex':'flex'} min-h-0 flex-col`}><ConversationList items={items} selectedId={conversationId} search={search} onSearch={setSearch} onSelect={select} loading={listLoading} error={listError} onRetry={()=>{setListLoading(true);void refreshList();}}/></div><div className={`${conversationId?'flex':'hidden md:flex'} min-h-0 flex-col`}><ChatWindow peer={peer} messages={messages} currentUserId={viewerId} loading={chatLoading} sending={sending} error={sendError||chatError} onSend={send} presence={presence} typing={typing} onTyping={sendTyping}/></div></div></div>;
}
