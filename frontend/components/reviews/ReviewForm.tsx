import { useEffect, useState, type FormEvent } from 'react';
import RatingStars from './RatingStars';

export type ReviewType = 'TEACHING' | 'LEARNING';
export type ReviewValues = { rating: number; comment: string; reviewType: ReviewType };
export default function ReviewForm({ initial, onSubmit, submitLabel = 'Submit Review', busy = false, error = '', success = '' }: { initial?: ReviewValues; onSubmit: (value: ReviewValues) => Promise<void>; submitLabel?: string; busy?: boolean; error?: string; success?: string }) {
  const [rating,setRating]=useState(initial?.rating||0);const [comment,setComment]=useState(initial?.comment||'');const [reviewType,setReviewType]=useState<ReviewType>(initial?.reviewType||'TEACHING');
  useEffect(()=>{setRating(initial?.rating||0);setComment(initial?.comment||'');setReviewType(initial?.reviewType||'TEACHING');},[initial?.rating,initial?.comment,initial?.reviewType]);
  async function submit(event:FormEvent){event.preventDefault();if(rating<1||rating>5)return;await onSubmit({rating,comment,reviewType});}
  return <form onSubmit={submit} className="space-y-5">
    <label className="block text-sm font-bold text-slate-800">Review type<select value={reviewType} onChange={e=>setReviewType(e.target.value as ReviewType)} className="mt-2 block min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal"><option value="TEACHING">Teaching experience</option><option value="LEARNING">Learning experience</option></select></label>
    <fieldset><legend className="mb-2 text-sm font-bold text-slate-800">How was the {reviewType==='TEACHING'?'teaching':'learning'} experience? <span className="text-rose-600">*</span></legend><RatingStars value={rating} onChange={setRating} label="Choose a rating" size="lg"/>{!rating&&<p className="mt-1 text-xs text-slate-500">Choose 1 to 5 stars.</p>}</fieldset>
    <div><label htmlFor="review-comment" className="mb-2 block text-sm font-bold text-slate-800">Comment <span className="font-normal text-slate-400">(optional)</span></label><textarea id="review-comment" maxLength={500} rows={4} value={comment} onChange={event=>setComment(event.target.value)} placeholder="Share your experience with this skill exchange..." className="w-full resize-y rounded-xl border border-slate-200 px-3.5 py-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"/><p className="mt-1 text-right text-xs text-slate-400">{comment.length} / 500</p></div>
    {error&&<p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}{success&&<p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">{success}</p>}
    <button disabled={busy||rating===0} className="w-full rounded-xl bg-brand-700 px-5 py-3 text-sm font-bold text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-50">{busy?'Submitting…':submitLabel}</button>
  </form>;
}
