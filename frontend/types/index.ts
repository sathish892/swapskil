export interface Skill {
  id: string;
  name: string;
  icon: string;
  category?: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  skillsOffered: string[];
  skillsWanted: string[];
}

export type SkillKind = 'TEACH' | 'LEARN';
export type SkillLevel = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | 'EXPERT';

export interface CatalogSkill {
  id: string;
  name: string;
  category: string;
  description: string;
}

export interface UserSkill {
  id: string;
  skillId: string;
  name: string;
  category: string;
  description: string;
  type: SkillKind;
  level: SkillLevel;
  createdAt?: string;
}

export interface MatchSkill {
  skillId: string;
  name: string;
  category: string;
  description: string;
  level: SkillLevel;
}

export interface SkillMatch {
  user: { id: string; name: string; bio: string; avatar: string | null; location?:string;createdAt?:string;verificationStatus?:string;teachingRating?:{averageRating:number;totalReviews:number};learningRating?:{averageRating:number;totalReviews:number} };
  teaches: MatchSkill[];
  learns: MatchSkill[];
  directSkills: Array<{ skillId: string; name: string; category: string; yourLevel: SkillLevel; theirLevel: SkillLevel }>;
  mutualSkills: Array<{ skillId: string; name: string; category: string; yourLevel: SkillLevel; theirLevel: SkillLevel }>;
  matchType: 'DIRECT' | 'MUTUAL';
  label: 'Strong Match' | 'Good Match' | 'Potential Match';
  offeredSkills: MatchSkill[];
}

export interface RecommendedUser {
  user: SkillMatch['user']; relevantSkill: {skillId:string;name:string;category:string}|null; reason:string; reasons:string[];
  matchScore:number; recommendationScore:number; availabilityCompatibility:boolean|null; rating?:{averageRating:number;totalReviews:number};
  verificationStatus?:string; teaches:SkillMatch['teaches']; learns:SkillMatch['learns'];
}
export interface RecommendedSkill {skillId:string;name:string;category:string;description:string;teachers:number;learners:number;levels:string[];reason:string;recommendationScore:number;suggestion:true}

export interface SwapRequest {
  id: string;
  senderId: string;
  senderName?: string;
  receiverId: string;
  receiverName?: string;
  skillOfferedId: string;
  skillOffered?: string;
  skillWantedId: string;
  skillWanted?: string;
  direction?: 'SENT' | 'RECEIVED';
  status: 'PENDING' | 'ACCEPTED' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'CANCELLED';
  message: string;
  senderCompletedAt?: string | null;
  receiverCompletedAt?: string | null;
  completedAt?: string | null;
  acceptedAt?: string | null;
  startedAt?: string | null;
  cancelledAt?: string | null;
  conversationId?: string | null;
  myReviewId?: string | null;
  myTeachingReviewId?: string | null;
  myLearningReviewId?: string | null;
  myTeachingReviewRating?: number | null;
  myTeachingReviewComment?: string | null;
  myLearningReviewRating?: number | null;
  myLearningReviewComment?: string | null;
  myReviewRating?: number | null;
  myReviewComment?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  conversationId: string;
  userId: string;
  name: string;
  avatar: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  isSystem?: boolean;
}

export type NotificationType = 'NEW_MATCH'|'SWAP_REQUEST'|'SWAP_ACCEPTED'|'SWAP_REJECTED'|'NEW_MESSAGE'|'PROFILE_ACTIVITY'|'SYSTEM'|'REVIEW_RECEIVED'|'SESSION_PROPOSED'|'SESSION_CONFIRMED'|'SESSION_DECLINED'|'SESSION_RESCHEDULED'|'SESSION_CANCELLED'|'SESSION_COMPLETED'|'PAYMENT_SUCCESS'|'PAYMENT_FAILED'|'PAYMENT_REFUNDED';
export interface AppNotification {
  id:string;
  type:NotificationType;
  title:string;
  message:string;
  relatedUserId:string|null;
  relatedConversationId:string|null;
  relatedSwapRequestId:string|null;
  relatedSkillId:string|null;
  relatedSessionId:string|null;
  isRead:boolean;
  createdAt:string;
  updatedAt:string;
}
