import type { Review, } from './ReviewCard';
import type { ReviewValues } from './ReviewForm';
import ReviewCard from './ReviewCard';
import ReviewSkeleton from './ReviewSkeleton';
import ReviewEmptyState from './ReviewEmptyState';
export default function ReviewList({items,loading,error,hasMore,onLoadMore,viewerId,onEdit,onDelete,onRetry}:{items:Review[];loading:boolean;error:string;hasMore:boolean;onLoadMore:()=>void;viewerId?:string;onEdit?:(review:Review,values:ReviewValues)=>void;onDelete?:(review:Review)=>void;onRetry?:()=>void}) {
  if(loading&&!items.length)return <ReviewSkeleton/>;if(error&&!items.length)return <div className="rounded-xl bg-rose-50 p-4 text-sm text-rose-700" role="alert">Unable to load reviews.<p className="mt-1">Please try again.</p><button onClick={onRetry} className="mt-2 font-semibold underline">Retry</button></div>;if(!items.length)return <ReviewEmptyState/>;
  return <div className="space-y-3">{error&&<p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">Unable to load more reviews. <button onClick={onRetry} className="font-semibold underline">Retry</button></p>}{items.map(review=><ReviewCard key={review.id} review={review} canEdit={review.reviewerId===viewerId} onEdit={values=>onEdit?.(review,values)} onDelete={()=>onDelete?.(review)}/>)}{hasMore&&<button onClick={onLoadMore} disabled={loading} className="w-full rounded-xl border border-slate-200 bg-white py-3 text-sm font-semibold text-brand-700 disabled:opacity-50">{loading?'Loading…':'Load more reviews'}</button>}</div>;
}
