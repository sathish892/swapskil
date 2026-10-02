import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../../service/api';
import ReviewModal from './ReviewModal';
import ReviewList from './ReviewList';
import RatingSummary, { type RatingSummaryData } from './RatingSummary';
import type { Review } from './ReviewCard';
import type { ReviewValues } from './ReviewForm';

type ListResponse={items:Review[];page:number;limit:number;total:number;hasMore:boolean};
export default function ProfileReviews({userId,viewerId}:{userId:string;viewerId?:string}) {
  const [summary,setSummary]=useState<RatingSummaryData>({teachingAverageRating:0,teachingReviewCount:0,learningAverageRating:0,learningReviewCount:0,breakdowns:{TEACHING:{5:0,4:0,3:0,2:0,1:0},LEARNING:{5:0,4:0,3:0,2:0,1:0}}});const [items,setItems]=useState<Review[]>([]);const [page,setPage]=useState(1);const [hasMore,setHasMore]=useState(false);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [editing,setEditing]=useState<Review|null>(null);
  const load=useCallback(async(nextPage=1,append=false)=>{setLoading(true);setError('');try{const [s,list]=await Promise.all([apiRequest<RatingSummaryData>(`/api/reviews/user/${encodeURIComponent(userId)}/summary`),apiRequest<ListResponse>(`/api/reviews/user/${encodeURIComponent(userId)}?page=${nextPage}&limit=8`)]);setSummary(s);setItems(old=>append?[...old,...list.items]:list.items);setPage(list.page);setHasMore(list.hasMore);}catch(e){setError(e instanceof Error?e.message:'Unable to load reviews.');}finally{setLoading(false);}},[userId]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{if(window.location.hash==='#reviews')window.setTimeout(()=>document.getElementById('reviews')?.scrollIntoView({behavior:'smooth',block:'start'}),250);},[userId]);
  async function save(values:ReviewValues){if(!editing)return;await apiRequest(`/api/reviews/${encodeURIComponent(editing.id)}`,{method:'PATCH',body:JSON.stringify(values)});setEditing(null);await load();}
  async function remove(review:Review){try{await apiRequest(`/api/reviews/${encodeURIComponent(review.id)}`,{method:'DELETE'});await load();}catch(e){setError(e instanceof Error?e.message:'Unable to delete your review.');}}
  return <section id="reviews" className="scroll-mt-24 space-y-4"><h2 className="text-2xl font-extrabold text-slate-900">Reviews</h2><RatingSummary summary={summary}/><ReviewList items={items} loading={loading} error={error} hasMore={hasMore} onLoadMore={()=>void load(page+1,true)} onRetry={()=>void load()} viewerId={viewerId} onEdit={(review)=>setEditing(review)} onDelete={remove}/><ReviewModal open={!!editing} onClose={()=>setEditing(null)} onSubmit={save} initial={editing?{rating:editing.rating,comment:editing.comment,reviewType:editing.reviewType}:undefined} title="Edit Review"/></section>;
}
