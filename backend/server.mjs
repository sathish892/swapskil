import { createServer } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, openDatabase } from './config.mjs';
import { findMatches, findDiscovery, findDiscoverySkills, getPublicProfile } from './matching.mjs';
import { configuredPaymentProvider } from './services/payments/payment.provider.mjs';
import { createPaymentService } from './services/payments/payment.service.mjs';
import { createSubscriptionService, subscriptionPlans } from './services/payments/subscription.service.mjs';
import { handleAdminApi, createUserReport } from './admin.mjs';
import { createRecommendationService } from './services/recommendations/recommendation.service.mjs';

loadEnv();
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || Buffer.byteLength(sessionSecret) < 32) {
  logEvent('error','startup.configuration_missing',{variable:'SESSION_SECRET'});
  process.exit(1);
}
if(process.env.NODE_ENV==='production'){
  try{if(new URL(process.env.FRONTEND_URL||'').protocol!=='https:')throw new Error();}
  catch{logEvent('error','startup.configuration_invalid',{variable:'FRONTEND_URL',requirement:'absolute_https_url'});process.exit(1);}
}
const db = openDatabase();
const recommendations = createRecommendationService({ db });
const isProduction = process.env.NODE_ENV === 'production';
const cookieName = 'skillswap_session';
const sessions = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
const usersByEmail = db.prepare('SELECT id, name, email, password_hash, role, status, deleted_at AS deletedAt FROM users WHERE email = ?');
const userById = db.prepare('SELECT id, name, email, role, status, bio, avatar FROM users WHERE id = ?');
const userSkillSelect = db.prepare(`
  SELECT us.id, us.skill_id AS skillId, us.type, us.level, us.created_at AS createdAt,
    s.name, s.category, s.description
  FROM user_skills us JOIN skills s ON s.id = us.skill_id
  WHERE us.user_id = ? ORDER BY us.created_at, s.name COLLATE NOCASE
`);
const avatarDir = join(dirname(fileURLToPath(import.meta.url)), 'uploads', 'avatars');
const avatarPath = file => /^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(String(file)) ? join(avatarDir, file) : join(avatarDir, '__invalid_avatar__');
const imageTypes = { 'image/jpeg': ['jpg', Buffer.from([0xff, 0xd8, 0xff])], 'image/png': ['png', Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])], 'image/webp': ['webp', Buffer.from('RIFF')] };
async function rawBody(req, limit = 5 * 1024 * 1024) {
  const declaredLength=Number(req.headers['content-length']);
  if(Number.isFinite(declaredLength)&&declaredLength>limit){req.resume();throw Object.assign(new Error('Request body is too large.'),{status:413});}
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('Image must be 5 MB or smaller.'), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function profileAllowed(row, viewer) {
  if (!row) return false;
  if (row.id === viewer?.id) return true;
  if (row.profile_visibility === 'PRIVATE') return false;
  if (row.profile_visibility === 'USERS' && !viewer) return false;
  return true;
}
function profileCompletion(userId, user) {
  const skills = userSkillSelect.all(userId);
  const checks = [!!user.name?.trim(), !!user.avatar, !!user.bio?.trim(), !!user.college?.trim(), !!user.location?.trim(), skills.some(s => s.type === 'TEACH'), skills.some(s => s.type === 'LEARN'), !!user.learning_goals?.trim()];
  return Math.round(checks.filter(Boolean).length / checks.length * 100);
}
function mapOwnProfile(user) {
  const skills = userSkillSelect.all(user.id);
  return { id:user.id, name:user.name, email:user.email, avatar:user.avatar ? `/api/profile/avatar/${encodeURIComponent(user.id)}` : null, bio:user.bio, college:user.college, location:user.location, website:user.website, learningGoals:user.learning_goals, profileVisibility:user.profile_visibility, showEmail:!!user.show_email, verificationStatus:user.verification_status||'UNVERIFIED', allowDirectMessages:!!user.allow_direct_messages, allowSwapRequests:!!user.allow_swap_requests, showAvailability:!!user.show_availability, showReviews:!!user.show_reviews, createdAt:user.created_at, updatedAt:user.updated_at, skills, completion:profileCompletion(user.id,user), activity:{ teachingSkills:skills.filter(s=>s.type==='TEACH').length, learningSkills:skills.filter(s=>s.type==='LEARN').length, swapRequests:db.prepare('SELECT COUNT(*) AS n FROM swap_requests WHERE sender_id=? OR receiver_id=?').get(user.id,user.id).n } };
}
function sendAvatar(res, status, data, type) { res.writeHead(status, {'Content-Type':type,'Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff'}); res.end(data); }

function hash(value) { return createHmac('sha256', sessionSecret).update(value).digest('hex'); }
function verifyPassword(password, stored) {
  const [algorithm, saltHex, hashHex] = (stored || '').split(':');
  if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function cookie(value, maxAge) {
  return `${cookieName}=${value}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}${isProduction ? '; Secure' : ''}`;
}
function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  const body=status>=400&&data&&typeof data==='object'&&!Array.isArray(data)?{...data,success:false,message:data.message||data.error||'The request could not be completed.',requestId:res.getHeader('X-Request-Id')}:data;
  res.end(JSON.stringify(body));
}
function logEvent(level,event,fields={}){process.stdout.write(`${JSON.stringify({timestamp:new Date().toISOString(),level,event,...fields})}\n`);}
async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw Object.assign(new Error('Request body too large.'), { status: 413 });
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}
function cookieValue(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === cookieName) return value.join('=');
  }
  return '';
}
function authenticatedUser(req) {
  const token = cookieValue(req);
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.name, u.email, u.role, u.status, u.deleted_at AS deletedAt FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`)
    .get(hash(token), Date.now());
  if(row?.deletedAt)return null;
  if(row)db.prepare('UPDATE sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE token_hash=?').run(hash(token));
  return row || null;
}
function adminOnly(req, res) {
  const user = authenticatedUser(req);
  if (!user) { send(res, 401, { error: 'Authentication required.' }); return null; }
  if (user.status !== 'active') { send(res, 403, { error: 'Your account is currently suspended. Please contact support.' }); return null; }
  if (user.role !== 'admin') { send(res, 403, { error: 'Administrator access required.' }); return null; }
  return user;
}
function userOnly(req, res) {
  const user = authenticatedUser(req);
  if (!user) { send(res, 401, { error: 'Authentication required.' }); return null; }
  if (user.status !== 'active') { send(res, 403, { error: 'Your account is currently suspended. Please contact support.' }); return null; }
  return user;
}
function auditAdmin(adminId, action, targetType, targetId, metadata = {}) {
  db.prepare('INSERT INTO admin_audit_logs(id,admin_id,action,target_type,target_id,metadata) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), adminId, action, targetType, targetId, JSON.stringify(metadata));
}
function adminNotification(userId, title, message, key) {
  createNotification({ userId, type: 'SYSTEM', title, message, dedupeKey: key });
}
function startSession(userId, res, req) {
  const token = randomBytes(32).toString('base64url');
  sessions.run(hash(token), userId, Date.now() + 7 * 24 * 60 * 60 * 1000);
  db.prepare('UPDATE sessions SET user_agent=?,last_seen_at=CURRENT_TIMESTAMP WHERE token_hash=?').run(String(req?.headers['user-agent']||'').slice(0,300),hash(token));
  return cookie(token, 7 * 24 * 60 * 60);
}
const messageRate = new Map();
const avatarRate = new Map();
const loginAttempts = new Map();
const swapRequestRate = new Map();
const discoveryRate = new Map();
const realtimeStreams = new Map();
const typingTimers = new Map();
const typingRate = new Map();
const realtimeConnectRate = new Map();
function publishRealtime(userId, type, payload = {}) {
  const streamSet = realtimeStreams.get(userId);
  if (!streamSet?.size) return;
  if(!db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(userId)){closeRealtimeForUser(userId);return;}
  const frame = `event: message\ndata: ${JSON.stringify({ eventId:randomUUID(),type, ...payload, createdAt: new Date().toISOString() })}\n\n`;
  for (const stream of [...streamSet]) {
    if (stream.destroyed || stream.writableEnded) { streamSet.delete(stream); continue; }
    try { stream.write(frame); } catch { streamSet.delete(stream); }
  }
  if (!streamSet.size) realtimeStreams.delete(userId);
}
function conversationUsers(conversationId) {
  return db.prepare(`SELECT u.id,u.status FROM conversation_participants p JOIN users u ON u.id=p.user_id WHERE p.conversation_id=?`).all(conversationId);
}
function publishConversation(conversationId, type, payload = {}, excludeUserId = null) {
  if (conversationUsers(conversationId).length !== 2) return;
  const peers = conversationUsers(conversationId);
  if (peers.some(peer => peer.status !== 'active') || usersBlocked(peers[0].id, peers[1].id)) return;
  for (const peer of peers) if (peer.id !== excludeUserId) publishRealtime(peer.id, type, payload);
}
function closeRealtimeForUser(userId, reason='SESSION_UNAVAILABLE') {
  const streams = realtimeStreams.get(userId);
  if (!streams) return;
  realtimeStreams.delete(userId);
  const frame=`event: message\ndata: ${JSON.stringify({eventId:randomUUID(),type:reason,createdAt:new Date().toISOString()})}\n\n`;
  for (const stream of streams) { clearInterval(stream.heartbeat);try{stream.write(frame)}catch{}stream.end(); }
}
function presenceVisible(userId, peerId) {
  if (usersBlocked(userId, peerId)) return false;
  return !!db.prepare(`SELECT 1 FROM users target WHERE target.id=? AND target.status='active' AND target.show_presence=1 AND target.profile_visibility!='PRIVATE'
    AND EXISTS(SELECT 1 FROM conversations c JOIN conversation_participants a ON a.conversation_id=c.id AND a.user_id=?
      JOIN conversation_participants b ON b.conversation_id=c.id AND b.user_id=? WHERE c.user_one_id=? AND c.user_two_id=? OR c.user_one_id=? AND c.user_two_id=?)`).get(userId,userId,peerId,userId,peerId,peerId,userId);
}
function broadcastPresence(userId, state) {
  const eligible = db.prepare(`SELECT DISTINCT peer.id FROM conversation_participants mine
    JOIN conversations c ON c.id=mine.conversation_id
    JOIN conversation_participants theirs ON theirs.conversation_id=c.id AND theirs.user_id!=mine.user_id
    JOIN users peer ON peer.id=theirs.user_id AND peer.status='active'
    JOIN users target ON target.id=mine.user_id AND target.status='active' AND target.show_presence=1 AND target.profile_visibility!='PRIVATE'
    WHERE mine.user_id=?`).all(userId);
  for (const { id } of eligible) if (!usersBlocked(userId,id)) publishRealtime(id,'PRESENCE_CHANGED',{userId,state});
}
function conversationAccess(conversationId, userId) {
  return db.prepare('SELECT conversation_id FROM conversation_participants WHERE conversation_id=? AND user_id=?').get(conversationId,userId);
}
function usersBlocked(userA,userB){return !!db.prepare('SELECT 1 FROM user_blocks WHERE (blocker_id=? AND blocked_user_id=?) OR (blocker_id=? AND blocked_user_id=?)').get(userA,userB,userB,userA);}
function loginRateKey(req,email){return `${req.socket.remoteAddress||'unknown'}:${String(email||'').trim().toLowerCase()}`;}
function loginIpKey(req){return `ip:${req.socket.remoteAddress||'unknown'}`;}
function loginRateLimited(req,email){const now=Date.now(),key=loginRateKey(req,email),ipKey=loginIpKey(req),recent=(loginAttempts.get(key)||[]).filter(t=>now-t<15*60_000),ipRecent=(loginAttempts.get(ipKey)||[]).filter(t=>now-t<15*60_000);loginAttempts.set(key,recent);loginAttempts.set(ipKey,ipRecent);return recent.length>=10||ipRecent.length>=40;}
function recordLoginFailure(req,email){const now=Date.now();for(const key of [loginRateKey(req,email),loginIpKey(req)]){const recent=(loginAttempts.get(key)||[]).filter(t=>now-t<15*60_000);recent.push(now);loginAttempts.set(key,recent);}if(loginAttempts.size>10000)for(const [key,times] of loginAttempts)if(!times.some(t=>now-t<15*60_000))loginAttempts.delete(key);}
function peerFor(conversationId,userId) {
  return db.prepare(`SELECT u.id,u.name,CASE WHEN u.avatar IS NULL OR u.avatar='' THEN NULL ELSE '/api/profile/avatar/'||u.id END AS avatar FROM conversations c
    JOIN users u ON u.id=CASE WHEN c.user_one_id=? THEN c.user_two_id ELSE c.user_one_id END
    WHERE c.id=? AND EXISTS (SELECT 1 FROM conversation_participants p WHERE p.conversation_id=c.id AND p.user_id=?)`).get(userId,conversationId,userId);
}
function createNotification({userId,type,title,message,relatedUserId=null,relatedConversationId=null,relatedSwapRequestId=null,relatedSkillId=null,relatedSessionId=null,dedupeKey}) {
  const id=randomUUID(),timestamp=new Date().toISOString();
  const result=db.prepare(`INSERT OR IGNORE INTO notifications
    (id,user_id,type,title,message,related_user_id,related_conversation_id,related_swap_request_id,related_skill_id,related_session_id,dedupe_key,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,userId,type,title,message,relatedUserId,relatedConversationId,relatedSwapRequestId,relatedSkillId,relatedSessionId,dedupeKey,timestamp,timestamp);
  if(result.changes){
    const excess=db.prepare('SELECT id FROM notifications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 500').all(userId);
    for(const row of excess) db.prepare('DELETE FROM notifications WHERE id=? AND user_id=?').run(row.id,userId);
    const notification={ id, type, title, message, relatedUserId, relatedConversationId, relatedSwapRequestId, relatedSkillId, relatedSessionId, createdAt: timestamp };
    publishRealtime(userId, 'NOTIFICATION_CREATED', { notification });
    const eventType=({SWAP_REQUEST:'SWAP_REQUEST_CREATED',SWAP_ACCEPTED:'SWAP_REQUEST_ACCEPTED',SWAP_REJECTED:'SWAP_REQUEST_REJECTED',SESSION_PROPOSED:'SESSION_PROPOSED',SESSION_CONFIRMED:'SESSION_CONFIRMED',SESSION_DECLINED:'SESSION_DECLINED',SESSION_RESCHEDULED:'SESSION_RESCHEDULED',SESSION_CANCELLED:'SESSION_CANCELLED',SESSION_COMPLETED:'SESSION_COMPLETED',PAYMENT_SUCCESS:'PAYMENT_SUCCESS',PAYMENT_FAILED:'PAYMENT_FAILED',PAYMENT_REFUNDED:'PAYMENT_REFUNDED'})[type]
      ||(type==='SYSTEM'&&title==='Exchange Started'?'SWAP_STARTED':type==='SYSTEM'&&title==='Exchange Completed'?'SWAP_COMPLETED':type==='SYSTEM'&&title==='Exchange Cancelled'?'SWAP_REQUEST_CANCELLED':null);
    if(eventType)publishRealtime(userId,eventType,{notificationId:id,relatedSwapRequestId,relatedSessionId});
  }
}
function exchangeConversation(userA,userB) {
  const [one,two]=[userA,userB].sort();
  let conversation=db.prepare('SELECT id FROM conversations WHERE user_one_id=? AND user_two_id=?').get(one,two);
  if(!conversation){const id=randomUUID(),now=new Date().toISOString();db.prepare('INSERT OR IGNORE INTO conversations(id,user_one_id,user_two_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,one,two,now,now);conversation=db.prepare('SELECT id FROM conversations WHERE user_one_id=? AND user_two_id=?').get(one,two);}
  db.prepare('INSERT OR IGNORE INTO conversation_participants(conversation_id,user_id) VALUES(?,?)').run(conversation.id,one);
  db.prepare('INSERT OR IGNORE INTO conversation_participants(conversation_id,user_id) VALUES(?,?)').run(conversation.id,two);
  return conversation.id;
}
function addSystemMessage(conversationId,senderId,content){const id=randomUUID(),now=new Date().toISOString();db.prepare('INSERT INTO messages(id,conversation_id,sender_id,content,is_system,created_at,updated_at) VALUES(?,?,?,?,1,?,?)').run(id,conversationId,senderId,content,now,now);db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now,conversationId);}
function notificationItem(row){return {...row,isRead:!!row.isRead};}
const paymentService=createPaymentService({db,provider:configuredPaymentProvider(),notify:payload=>setImmediate(()=>createNotification(payload))});
const subscriptionService=createSubscriptionService({db,provider:paymentService.provider,notify:payload=>setImmediate(()=>createNotification(payload))});
const paymentRate=new Map();
function paymentLimit(userId,key,limit=8){const timestamp=Date.now(),list=(paymentRate.get(`${userId}:${key}`)||[]).filter(value=>timestamp-value<60_000);if(list.length>=limit)return false;list.push(timestamp);paymentRate.set(`${userId}:${key}`,list);return true;}
function validTimezone(value){try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format();return true;}catch{return false;}}
function localInstant(date,time,timezone){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||!validTimezone(timezone))return null;
  const [year,month,day]=date.split('-').map(Number),[hour,minute]=time.split(':').map(Number),target=Date.UTC(year,month-1,day,hour,minute);
  let guess=target;
  for(let i=0;i<4;i++){
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess));
    const value=Object.fromEntries(parts.map(part=>[part.type,part.value]));
    const represented=Date.UTC(Number(value.year),Number(value.month)-1,Number(value.day),Number(value.hour),Number(value.minute));
    guess+=target-represented;
  }
  const check=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess));
  const p=Object.fromEntries(check.map(part=>[part.type,part.value]));
  if(`${p.year}-${p.month}-${p.day}`!==date||`${p.hour}:${p.minute}`!==time)return null;
  return new Date(guess).toISOString();
}
function localParts(instant,timezone){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant));return Object.fromEntries(parts.map(part=>[part.type,part.value]));}
function sessionRow(id,userId){return db.prepare(`SELECT ss.id,ss.swap_request_id AS swapRequestId,ss.proposer_id AS proposerId,ss.start_at AS startAt,ss.end_at AS endAt,ss.timezone,ss.status,ss.meeting_link AS meetingLink,ss.notes,ss.reschedules_session_id AS reschedulesSessionId,ss.proposer_completed_at AS proposerCompletedAt,ss.partner_completed_at AS partnerCompletedAt,ss.created_at AS createdAt,ss.updated_at AS updatedAt,sr.sender_id AS senderId,sr.receiver_id AS receiverId,COALESCE(sr.workflow_status,sr.status) AS exchangeStatus,peer.name AS peerName,peer.id AS peerId,offered.name AS skillOffered,wanted.name AS skillWanted,(SELECT c.id FROM conversations c WHERE c.user_one_id=CASE WHEN sr.sender_id<sr.receiver_id THEN sr.sender_id ELSE sr.receiver_id END AND c.user_two_id=CASE WHEN sr.sender_id<sr.receiver_id THEN sr.receiver_id ELSE sr.sender_id END) AS conversationId FROM skill_sessions ss JOIN swap_requests sr ON sr.id=ss.swap_request_id JOIN users peer ON peer.id=CASE WHEN sr.sender_id=? THEN sr.receiver_id ELSE sr.sender_id END JOIN skills offered ON offered.id=sr.skill_offered_id JOIN skills wanted ON wanted.id=sr.skill_wanted_id WHERE ss.id=? AND (sr.sender_id=? OR sr.receiver_id=?)`).get(userId,id,userId,userId);}
function hasSessionConflict(userIds,startAt,endAt,excludeSessionId=null){return !!db.prepare(`SELECT 1 FROM skill_sessions ss JOIN swap_requests sr ON sr.id=ss.swap_request_id WHERE ss.status IN ('PROPOSED','CONFIRMED') AND (? IS NULL OR ss.id!=?) AND ss.start_at<? AND ss.end_at>? AND (sr.sender_id IN (?,?) OR sr.receiver_id IN (?,?)) LIMIT 1`).get(excludeSessionId,excludeSessionId,endAt,startAt,...userIds,...userIds);}
function sessionSystemMessage(item,senderId,content){const conversationId=exchangeConversation(item.senderId,item.receiverId);addSystemMessage(conversationId,senderId,content);}
function sessionNotify(session,type,title,message){const row=db.prepare('SELECT sender_id AS senderId,receiver_id AS receiverId FROM swap_requests WHERE id=?').get(session.swapRequestId);if(!row)return;for(const userId of [row.senderId,row.receiverId])if(userId!==session.actorId)createNotification({userId,type,title,message,relatedSwapRequestId:session.swapRequestId,relatedSessionId:session.id,dedupeKey:`${type}:${session.id}:${session.updatedAt}`});}
function createDueSessionReminders(){
  const now=new Date(),from=now.toISOString(),until=new Date(now.getTime()+30*60_000).toISOString();
  const due=db.prepare(`SELECT ss.id,ss.start_at AS startAt,ss.swap_request_id AS swapRequestId,sr.sender_id AS senderId,sr.receiver_id AS receiverId
    FROM skill_sessions ss JOIN swap_requests sr ON sr.id=ss.swap_request_id
    WHERE ss.status='CONFIRMED' AND ss.start_at>=? AND ss.start_at<=?`).all(from,until);
  for(const session of due)for(const userId of [session.senderId,session.receiverId])createNotification({userId,type:'SYSTEM',title:'Session reminder',message:`Your SkillSwap session starts at ${new Date(session.startAt).toLocaleString()}.`,relatedSwapRequestId:session.swapRequestId,relatedSessionId:session.id,dedupeKey:`session-reminder:30m:${session.id}:${userId}`});
}

const server = createServer(async (req, res) => {
  const requestId=randomUUID(),startedAt=Date.now();
  res.setHeader('X-Request-Id',requestId);
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if(isProduction)res.setHeader('Strict-Transport-Security','max-age=31536000');
  res.on('finish',()=>{const path=(req.url||'/').split('?')[0];if(path!='/api/health'&&path!='/api/ready')logEvent('info','http.request',{requestId,method:req.method,status:res.statusCode,durationMs:Date.now()-startedAt});});
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method || 'GET';

    if(['POST','PUT','PATCH','DELETE'].includes(method)&&req.headers.origin){
      let expectedOrigin=process.env.FRONTEND_URL;
      try{if(expectedOrigin)expectedOrigin=new URL(expectedOrigin).origin;else{const scheme=process.env.TRUST_PROXY==='true'?(String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()||'http'):(req.socket.encrypted?'https':'http');expectedOrigin=`${scheme}://${req.headers.host}`;}}catch{return send(res,403,{error:'Request origin is not allowed.'});}
      if(req.headers.origin!==expectedOrigin)return send(res,403,{error:'Request origin is not allowed.'});
    }

    if (method === 'GET' && path === '/api/health') return send(res, 200, { ok: true });
    if (method === 'GET' && path === '/api/ready') {try{db.prepare('SELECT 1').get();if(db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)throw new Error('foreign keys disabled');return send(res,200,{ok:true});}catch{return send(res,503,{error:'Service is not ready.'});}}

    // The sole admin entry point verifies credentials and the persisted admin role.
    if (method === 'POST' && path === '/api/admin/auth/login') {
      const input = await bodyJson(req);
      const email=String(input.email||'').trim().toLowerCase();if(loginRateLimited(req,email))return send(res,429,{error:'Too many sign-in attempts. Please wait and try again.'},{'Retry-After':'900'});const user = usersByEmail.get(email);
      if (!user || user.role !== 'admin' || user.status !== 'active' || !verifyPassword(String(input.password || ''), user.password_hash)) {
        recordLoginFailure(req,email);
        return send(res, 401, { error: 'Invalid email or password.' });
      }
      loginAttempts.delete(loginRateKey(req,email));
      const sessionCookie = startSession(user.id, res, req);
      return send(res, 200, { user: { id: user.id, name: user.name, email: user.email, role: user.role } }, { 'Set-Cookie': sessionCookie });
    }

    if (method === 'POST' && path === '/api/auth/login') {
      const input = await bodyJson(req);
      const email=String(input.email||'').trim().toLowerCase();if(loginRateLimited(req,email))return send(res,429,{error:'Too many sign-in attempts. Please wait and try again.'},{'Retry-After':'900'});const user = usersByEmail.get(email);
      if (!user || user.role !== 'user' || !verifyPassword(String(input.password || ''), user.password_hash)) {
        recordLoginFailure(req,email);
        return send(res, 401, { error: 'Invalid email or password.' });
      }
      loginAttempts.delete(loginRateKey(req,email));
      if(user.deletedAt)return send(res,403,{error:'This account is no longer available. Please contact support if you believe this was a mistake.'});
      if(user.status!=='active')return send(res,403,{error:'Your account is currently suspended. Please contact support.'});
      const sessionCookie = startSession(user.id, res, req);
      const { password_hash: _privateHash, ...safeUser } = user;
      return send(res, 200, { user: safeUser }, { 'Set-Cookie': sessionCookie });
    }

    if (method === 'GET' && path === '/api/auth/session') {
      const user = authenticatedUser(req);
      return user ? send(res, 200, { user }) : send(res, 401, { error: 'Not signed in.' });
    }
    if (method === 'POST' && path === '/api/auth/logout') {
      const token = cookieValue(req),user=authenticatedUser(req);
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
      if(user)closeRealtimeForUser(user.id,'SESSION_REVOKED');
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    }

    if(path==='/api/blocks'||path.startsWith('/api/blocks/')){
      const user=userOnly(req,res);if(!user)return;
      if(path==='/api/blocks'&&method==='GET'){const items=db.prepare(`SELECT b.id,b.created_at AS createdAt,u.id AS userId,u.name,u.avatar,u.profile_visibility AS profileVisibility FROM user_blocks b JOIN users u ON u.id=b.blocked_user_id WHERE b.blocker_id=? ORDER BY b.created_at DESC`).all(user.id).map(x=>({...x,avatar:x.avatar?`/api/profile/avatar/${encodeURIComponent(x.userId)}`:null}));return send(res,200,{items});}
      const match=path.match(/^\/api\/blocks\/([^/]+)(?:\/(status))?$/);if(!match)return send(res,404,{error:'Not found.'});let targetId;try{targetId=decodeURIComponent(match[1]);}catch{return send(res,404,{error:'Member not found.'});}
      if(match[2]==='status'&&method==='GET'){return send(res,200,{blockedByYou:!!db.prepare('SELECT 1 FROM user_blocks WHERE blocker_id=? AND blocked_user_id=?').get(user.id,targetId),blockedYou:!!db.prepare('SELECT 1 FROM user_blocks WHERE blocker_id=? AND blocked_user_id=?').get(targetId,user.id)});}
      if(targetId===user.id)return send(res,400,{error:'You cannot block your own account.'});if(!db.prepare("SELECT id FROM users WHERE id=? AND status='active'").get(targetId))return send(res,404,{error:'Member not found.'});
      if(method==='POST'){const result=db.prepare('INSERT OR IGNORE INTO user_blocks(id,blocker_id,blocked_user_id) VALUES(?,?,?)').run(randomUUID(),user.id,targetId);if(!result.changes)return send(res,409,{error:'This member is already blocked.'});return send(res,201,{ok:true});}
      if(method==='DELETE'){const result=db.prepare('DELETE FROM user_blocks WHERE blocker_id=? AND blocked_user_id=?').run(user.id,targetId);return result.changes?send(res,200,{ok:true}):send(res,404,{error:'This member is not in your blocked list.'});}
      return send(res,405,{error:'Method not allowed.'});
    }

    if(path==='/api/settings/privacy'){
      const user=userOnly(req,res);if(!user)return;
      if(method==='GET'){const row=db.prepare('SELECT profile_visibility AS profileVisibility,show_email AS showEmail,allow_direct_messages AS allowDirectMessages,allow_swap_requests AS allowSwapRequests,show_availability AS showAvailability,show_reviews AS showReviews,show_presence AS showPresence FROM users WHERE id=?').get(user.id);return send(res,200,{settings:{...row,showEmail:!!row.showEmail,allowDirectMessages:!!row.allowDirectMessages,allowSwapRequests:!!row.allowSwapRequests,showAvailability:!!row.showAvailability,showReviews:!!row.showReviews,showPresence:!!row.showPresence}});}
      if(method==='PATCH'){const input=await bodyJson(req),visibility=String(input.profileVisibility||'').toUpperCase();if(!['PUBLIC','USERS','PRIVATE'].includes(visibility))return send(res,400,{error:'Choose a valid profile visibility.'});for(const key of ['showEmail','allowDirectMessages','allowSwapRequests','showAvailability','showReviews','showPresence'])if(typeof input[key]!=='boolean')return send(res,400,{error:'Choose true or false for each privacy setting.'});db.prepare('UPDATE users SET profile_visibility=?,show_email=?,allow_direct_messages=?,allow_swap_requests=?,show_availability=?,show_reviews=?,show_presence=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(visibility,+input.showEmail,+input.allowDirectMessages,+input.allowSwapRequests,+input.showAvailability,+input.showReviews,+input.showPresence,user.id);if(!input.showPresence||visibility==='PRIVATE'){const peers=db.prepare('SELECT DISTINCT theirs.user_id AS id FROM conversation_participants mine JOIN conversation_participants theirs ON theirs.conversation_id=mine.conversation_id AND theirs.user_id!=mine.user_id WHERE mine.user_id=?').all(user.id);for(const peer of peers)if(!usersBlocked(user.id,peer.id))publishRealtime(peer.id,'PRESENCE_CHANGED',{userId:user.id,state:'HIDDEN'});}else broadcastPresence(user.id,realtimeStreams.get(user.id)?.size?'ONLINE':'OFFLINE');return send(res,200,{ok:true});}
      return send(res,405,{error:'Method not allowed.'});
    }

    if(path==='/api/account/security'||path==='/api/account/password'||path==='/api/account/logout-all'){
      const user=userOnly(req,res);if(!user)return;
      if(path==='/api/account/security'&&method==='GET'){const sessions=db.prepare('SELECT token_hash AS tokenHash,created_at AS createdAt,last_seen_at AS lastActivity,user_agent AS userAgent FROM sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC').all(user.id,Date.now()).map((s,i)=>({current:s.tokenHash===hash(cookieValue(req)),createdAt:s.createdAt,lastActivity:s.lastActivity,device:s.userAgent.slice(0,180)||'Browser session'}));return send(res,200,{sessions});}
      if(path==='/api/account/logout-all'&&method==='POST'){const current=hash(cookieValue(req)),saved=db.prepare('SELECT expires_at,user_agent FROM sessions WHERE token_hash=? AND user_id=?').get(current,user.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);if(saved)db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,user_agent,last_seen_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)').run(current,user.id,saved.expires_at,saved.user_agent);return send(res,200,{ok:true});}
      if(path==='/api/account/password'&&method==='POST'){const input=await bodyJson(req),row=db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);if(!verifyPassword(String(input.currentPassword||''),row.password_hash))return send(res,400,{error:'Current password is incorrect.'});const next=String(input.newPassword||'');if(Buffer.byteLength(next)<12||next.length>200)return send(res,400,{error:'Use a new password between 12 and 200 characters.'});const salt=randomBytes(16),passwordHash=`scrypt:${salt.toString('hex')}:${scryptSync(next,salt,64).toString('hex')}`,token=cookieValue(req),currentHash=hash(token),session=db.prepare('SELECT expires_at,user_agent FROM sessions WHERE token_hash=? AND user_id=?').get(currentHash,user.id);db.prepare('UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(passwordHash,user.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);if(session)db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,user_agent,last_seen_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)').run(currentHash,user.id,session.expires_at,session.user_agent);return send(res,200,{ok:true});}
      return send(res,405,{error:'Method not allowed.'});
    }

    if(path==='/api/auth/password-reset'&&method==='POST'){const key=`reset:${req.socket.remoteAddress}`,attempts=loginAttempts.get(key)||[],now=Date.now(),fresh=attempts.filter(t=>now-t<15*60_000);if(fresh.length>=5)return send(res,429,{error:'Please wait before trying again.'},{'Retry-After':'900'});fresh.push(now);loginAttempts.set(key,fresh);await bodyJson(req);return send(res,503,{error:'Password reset is not configured. Please contact support.'});}

    if(path==='/api/account/export'&&method==='POST'){
      const user=userOnly(req,res);if(!user)return;await bodyJson(req);const profile=db.prepare('SELECT id,name,email,bio,college,location,website,learning_goals AS learningGoals,profile_visibility AS profileVisibility,show_email AS showEmail,created_at AS createdAt FROM users WHERE id=?').get(user.id);const skills=db.prepare('SELECT s.name,s.category,us.type,us.level,us.created_at AS createdAt FROM user_skills us JOIN skills s ON s.id=us.skill_id WHERE us.user_id=? ORDER BY us.created_at').all(user.id);const swaps=db.prepare('SELECT id,sender_id AS senderId,receiver_id AS receiverId,skill_offered_id AS skillOfferedId,skill_wanted_id AS skillWantedId,COALESCE(workflow_status,status) AS status,message,created_at AS createdAt,updated_at AS updatedAt FROM swap_requests WHERE sender_id=? OR receiver_id=?').all(user.id,user.id);const sessions=db.prepare('SELECT ss.id,ss.swap_request_id AS swapRequestId,ss.start_at AS startAt,ss.end_at AS endAt,ss.timezone,ss.status,ss.created_at AS createdAt FROM skill_sessions ss JOIN swap_requests sr ON sr.id=ss.swap_request_id WHERE sr.sender_id=? OR sr.receiver_id=?').all(user.id,user.id);const reviews=db.prepare('SELECT id,reviewer_id AS reviewerId,reviewee_id AS revieweeId,swap_request_id AS swapRequestId,rating,comment,created_at AS createdAt FROM reviews WHERE reviewer_id=? OR reviewee_id=?').all(user.id,user.id);const notifications=db.prepare('SELECT type,title,message,is_read AS isRead,created_at AS createdAt FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 500').all(user.id);const payments=db.prepare('SELECT id,amount,currency,status,provider,description,created_at AS createdAt FROM payments WHERE user_id=? ORDER BY created_at DESC LIMIT 500').all(user.id);return send(res,200,{exportedAt:new Date().toISOString(),profile,skills,swaps,sessions,reviews,notifications,payments});
    }
    if(path==='/api/account/deletion-request'){
      const user=userOnly(req,res);if(!user)return;if(method==='POST'){const input=await bodyJson(req);if(input.confirmation!==user.email)return send(res,400,{error:'Enter your account email to confirm the request.'});const existing=db.prepare("SELECT id FROM account_deletion_requests WHERE user_id=? AND status='PENDING'").get(user.id);if(existing)return send(res,409,{error:'A deletion request is already pending.'});const id=randomUUID();db.prepare("INSERT INTO account_deletion_requests(id,user_id,status) VALUES(?,?,'PENDING')").run(id,user.id);return send(res,202,{ok:true,status:'PENDING'});}if(method==='DELETE'){const result=db.prepare("UPDATE account_deletion_requests SET status='CANCELLED',cancelled_at=CURRENT_TIMESTAMP WHERE user_id=? AND status='PENDING'").run(user.id);return result.changes?send(res,200,{ok:true,status:'CANCELLED'}):send(res,404,{error:'No pending deletion request.'});}if(method==='GET'){return send(res,200,{request:db.prepare('SELECT status,requested_at AS requestedAt FROM account_deletion_requests WHERE user_id=? ORDER BY requested_at DESC LIMIT 1').get(user.id)||null});}return send(res,405,{error:'Method not allowed.'});
    }

    if(path==='/api/availability/me' || path==='/api/availability' || path.startsWith('/api/availability/')){
      const user=userOnly(req,res);if(!user)return;
      if(path==='/api/availability/me'&&method==='GET'){
        const defaultZone=String(url.searchParams.get('timezone')||'UTC');
        const settings=db.prepare('SELECT timezone,visibility FROM availability_settings WHERE user_id=?').get(user.id)||{timezone:validTimezone(defaultZone)?defaultZone:'UTC',visibility:'MATCHES'};
        const items=db.prepare('SELECT id,day_of_week AS dayOfWeek,start_time AS startTime,end_time AS endTime,timezone,is_active AS isActive,created_at AS createdAt,updated_at AS updatedAt FROM availability_slots WHERE user_id=? ORDER BY day_of_week,start_time').all(user.id).map(row=>({...row,isActive:!!row.isActive}));
        return send(res,200,{settings,items});
      }
      if(path==='/api/availability/settings'&&method==='PATCH'){
        const input=await bodyJson(req),timezone=String(input.timezone||'').trim(),visibility=String(input.visibility||'').toUpperCase();
        if(!validTimezone(timezone)||!['PUBLIC','MATCHES','PARTNERS'].includes(visibility))return send(res,400,{error:'Choose a valid time zone and availability privacy option.'});
        const existingSlots=db.prepare('SELECT day_of_week AS day,start_time AS start,end_time AS end,is_active AS active FROM availability_slots WHERE user_id=? ORDER BY day_of_week,start_time').all(user.id);let lastByDay=new Map();for(const slot of existingSlots){if(!slot.active)continue;const previous=lastByDay.get(slot.day);if(previous&&slot.start<previous.end)return send(res,409,{error:'Changing your time zone would make two weekly slots overlap. Edit or remove one of the overlapping slots first.'});lastByDay.set(slot.day,slot);}
        const changedAt=new Date().toISOString();db.prepare(`INSERT INTO availability_settings(user_id,timezone,visibility,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET timezone=excluded.timezone,visibility=excluded.visibility,updated_at=excluded.updated_at`).run(user.id,timezone,visibility,changedAt);db.prepare('UPDATE availability_slots SET timezone=?,updated_at=? WHERE user_id=?').run(timezone,changedAt,user.id);
        return send(res,200,{settings:{timezone,visibility}});
      }
      if(path==='/api/availability'&&method==='POST'){
        const input=await bodyJson(req),dayOfWeek=Number(input.dayOfWeek),startTime=String(input.startTime||''),endTime=String(input.endTime||''),timezone=String(input.timezone||'UTC');
        if(!Number.isInteger(dayOfWeek)||dayOfWeek<0||dayOfWeek>6||!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)||startTime>=endTime||!validTimezone(timezone))return send(res,400,{error:'Check the day, time range, and time zone.'});
        const currentSettings=db.prepare('SELECT timezone FROM availability_settings WHERE user_id=?').get(user.id);if(currentSettings&&currentSettings.timezone!==timezone)return send(res,400,{error:'Use your saved availability time zone for every weekly slot.'});
        const minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3));if(minutes(endTime)-minutes(startTime)<15||minutes(endTime)-minutes(startTime)>480)return send(res,400,{error:'Availability slots must be between 15 minutes and 8 hours.'});
        if(db.prepare('SELECT 1 FROM availability_slots WHERE user_id=? AND day_of_week=? AND timezone=? AND is_active=1 AND start_time<? AND end_time>?').get(user.id,dayOfWeek,timezone,endTime,startTime))return send(res,409,{error:'This time overlaps another weekly availability slot.'});
        const id=randomUUID(),now=new Date().toISOString();db.prepare('INSERT INTO availability_slots(id,user_id,day_of_week,start_time,end_time,timezone,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,user.id,dayOfWeek,startTime,endTime,timezone,now,now);
        db.prepare(`INSERT OR IGNORE INTO availability_settings(user_id,timezone,visibility) VALUES(?,?,'MATCHES')`).run(user.id,timezone);
        return send(res,201,{item:{id,dayOfWeek,startTime,endTime,timezone,isActive:true,createdAt:now,updatedAt:now}});
      }
      const availabilityRoute=path.match(/^\/api\/availability\/([^/]+)$/);
      if(availabilityRoute&&availabilityRoute[1]!=='settings'&&availabilityRoute[1]!=='me'&&availabilityRoute[1]!=='user'){
        let id;try{id=decodeURIComponent(availabilityRoute[1]);}catch{return send(res,404,{error:'Availability slot not found.'});}
        if(method==='DELETE'){const result=db.prepare('DELETE FROM availability_slots WHERE id=? AND user_id=?').run(id,user.id);return result.changes?send(res,200,{ok:true}):send(res,404,{error:'Availability slot not found.'});}
        if(method==='PATCH'){
          const old=db.prepare('SELECT * FROM availability_slots WHERE id=? AND user_id=?').get(id,user.id);if(!old)return send(res,404,{error:'Availability slot not found.'});
          const input=await bodyJson(req),dayOfWeek=Number(input.dayOfWeek??old.day_of_week),startTime=String(input.startTime??old.start_time),endTime=String(input.endTime??old.end_time),timezone=String(input.timezone??old.timezone),isActive=input.isActive===undefined?old.is_active:(input.isActive?1:0);
          if(!Number.isInteger(dayOfWeek)||dayOfWeek<0||dayOfWeek>6||!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)||startTime>=endTime||!validTimezone(timezone)||![0,1].includes(isActive))return send(res,400,{error:'Check the day, time range, and time zone.'});
          const currentSettings=db.prepare('SELECT timezone FROM availability_settings WHERE user_id=?').get(user.id);if(currentSettings&&currentSettings.timezone!==timezone)return send(res,400,{error:'Use your saved availability time zone for every weekly slot.'});
          const minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3));if(minutes(endTime)-minutes(startTime)<15||minutes(endTime)-minutes(startTime)>480)return send(res,400,{error:'Availability slots must be between 15 minutes and 8 hours.'});
          if(isActive&&db.prepare('SELECT 1 FROM availability_slots WHERE user_id=? AND id!=? AND day_of_week=? AND timezone=? AND is_active=1 AND start_time<? AND end_time>?').get(user.id,id,dayOfWeek,timezone,endTime,startTime))return send(res,409,{error:'This time overlaps another weekly availability slot.'});
          const now=new Date().toISOString();db.prepare('UPDATE availability_slots SET day_of_week=?,start_time=?,end_time=?,timezone=?,is_active=?,updated_at=? WHERE id=? AND user_id=?').run(dayOfWeek,startTime,endTime,timezone,isActive,now,id,user.id);return send(res,200,{item:{id,dayOfWeek,startTime,endTime,timezone,isActive:!!isActive,updatedAt:now}});
        }
        return send(res,405,{error:'Method not allowed.'});
      }
      const peerRoute=path.match(/^\/api\/availability\/user\/([^/]+)$/);
      if(peerRoute&&method==='GET'){
        let peerId;try{peerId=decodeURIComponent(peerRoute[1]);}catch{return send(res,404,{error:'Availability is private.'});}
        if(usersBlocked(user.id,peerId))return send(res,403,{error:"You can't interact with this user because one of you has blocked the other."});
        const privacy=db.prepare('SELECT show_availability FROM users WHERE id=? AND status=\'active\'').get(peerId);if(!privacy||!privacy.show_availability)return send(res,200,{items:[],visibility:'PRIVATE'});const settings=db.prepare('SELECT timezone,visibility FROM availability_settings WHERE user_id=?').get(peerId)||{timezone:'UTC',visibility:'MATCHES'};
        const partner=!!db.prepare("SELECT 1 FROM swap_requests WHERE COALESCE(workflow_status,status) IN ('ACCEPTED','IN_PROGRESS') AND ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?))").get(user.id,peerId,peerId,user.id);
        const match=user.id!==peerId&&!!db.prepare(`SELECT 1 FROM user_skills mine JOIN user_skills theirs ON theirs.skill_id=mine.skill_id AND theirs.user_id=? AND ((mine.type='LEARN' AND theirs.type='TEACH') OR (mine.type='TEACH' AND theirs.type='LEARN')) JOIN users peer ON peer.id=theirs.user_id AND peer.status='active' WHERE mine.user_id=? LIMIT 1`).get(peerId,user.id);
        if(user.id!==peerId&&!partner&&!(settings.visibility==='PUBLIC'||(settings.visibility==='MATCHES'&&match)))return send(res,200,{items:[],visibility:'PRIVATE'});
        const items=db.prepare('SELECT id,day_of_week AS dayOfWeek,start_time AS startTime,end_time AS endTime,timezone FROM availability_slots WHERE user_id=? AND is_active=1 ORDER BY day_of_week,start_time').all(peerId);
        return send(res,200,{items,timezone:settings.timezone,visibility:settings.visibility});
      }
      return send(res,404,{error:'Not found.'});
    }

    if(path==='/api/payments/webhook'&&method==='POST'){
      const provider=paymentService.provider;if(!provider?.verifyWebhook)return send(res,503,{error:'Payment webhook is not configured.'});
      const raw=await rawBody(req,1024*1024),signature=String(req.headers['x-razorpay-signature']||''),eventId=String(req.headers['x-razorpay-event-id']||'').slice(0,200);
      if(!provider.verifyWebhook(raw,signature))return send(res,401,{error:'Invalid payment webhook signature.'});
      if(!eventId)return send(res,400,{error:'Webhook event id is required.'});
      let payload;try{payload=JSON.parse(raw.toString('utf8'));}catch{return send(res,400,{error:'Invalid webhook payload.'});}
      const eventType=String(payload.event||'');
      try{const entity=payload?.payload?.payment?.entity,refund=payload?.payload?.refund?.entity,lookup=eventType==='refund.processed'?refund?.payment_id:entity?.order_id,field=eventType==='refund.processed'?'provider_payment_id':'provider_order_id',record=lookup?db.prepare(`SELECT metadata FROM payments WHERE ${field}=?`).get(lookup):null,metadata=JSON.parse(record?.metadata||'{}'),result=metadata.product==='subscription'?subscriptionService.applyWebhookEvent(eventId,eventType,payload):paymentService.applyWebhookEvent(eventId,eventType,payload);return send(res,200,{ok:true,duplicate:!!result.duplicate});}
      catch(error){logEvent('error','payment.webhook.failed',{requestId,errorType:error?.name||'Error'});return send(res,500,{error:'Payment webhook could not be processed.'});}
    }

    if(path==='/api/payments'||path.startsWith('/api/payments/')){
      const user=userOnly(req,res);if(!user)return;
      if(path==='/api/payments/create'&&method==='POST'){
        if(!paymentLimit(user.id,'create',6))return send(res,429,{error:'Too many payment attempts. Please wait a minute and try again.'},{'Retry-After':'60'});
        const input=await bodyJson(req),sessionId=String(input.sessionId||'');if(!/^[0-9a-f-]{36}$/i.test(sessionId))return send(res,400,{error:'A valid session is required.'});
        try{const result=await paymentService.create({userId:user.id,sessionId});return send(res,201,result);}
        catch(error){logEvent('warn','payment.order_creation.failed',{requestId,status:error.status||502,errorType:error?.name||'Error'});return send(res,error.status||502,{error:error.message||'Payment setup failed.'});}
      }
      if(path==='/api/payments/verify'&&method==='POST'){
        if(!paymentLimit(user.id,'verify',12))return send(res,429,{error:'Too many verification attempts. Please wait a minute and try again.'},{'Retry-After':'60'});
        const input=await bodyJson(req);try{const item=await paymentService.verify({userId:user.id,paymentId:String(input.paymentId||''),providerPaymentId:String(input.providerPaymentId||''),providerOrderId:String(input.providerOrderId||''),signature:String(input.signature||'')});return send(res,200,{item});}
        catch(error){logEvent('warn','payment.verification.failed',{requestId,status:error.status||502,errorType:error?.name||'Error'});return send(res,error.status||502,{error:error.message||'Payment verification failed.'});}
      }
      if(path==='/api/payments'&&method==='GET'){
        const filter=String(url.searchParams.get('status')||'ALL').toUpperCase();if(filter!=='ALL'&&!paymentService.statusValues.includes(filter))return send(res,400,{error:'Choose a valid payment status.'});
        const where=filter==='ALL'?'':filter==='PENDING'?"AND p.status IN ('CREATED','PENDING')":'AND p.status=?';const args=filter==='ALL'||filter==='PENDING'?[user.id]:[user.id,filter];
        const items=db.prepare(`SELECT p.id,p.user_id AS userId,p.swap_request_id AS swapRequestId,p.session_id AS sessionId,p.amount,p.currency,p.status,p.provider,p.provider_payment_id AS providerPaymentId,p.provider_order_id AS providerOrderId,p.description,p.metadata,p.created_at AS createdAt,p.updated_at AS updatedAt,ss.start_at AS sessionStartAt,ss.timezone AS sessionTimezone FROM payments p LEFT JOIN skill_sessions ss ON ss.id=p.session_id WHERE p.user_id=? ${where} ORDER BY p.created_at DESC LIMIT 100`).all(...args).map(item=>({...item,metadata:JSON.parse(item.metadata||'{}')}));
        return send(res,200,{items});
      }
      const paymentRoute=path.match(/^\/api\/payments\/([^/]+)(?:\/(refund))?$/);
      if(paymentRoute){let id;try{id=decodeURIComponent(paymentRoute[1]);}catch{return send(res,404,{error:'Payment not found.'});}const row=paymentService.paymentById(id);if(!row||(row.userId!==user.id&&user.role!=='admin'))return send(res,404,{error:'Payment not found.'});
        if(method==='GET'&&!paymentRoute[2]){const related=db.prepare('SELECT start_at AS sessionStartAt,timezone AS sessionTimezone FROM skill_sessions WHERE id=?').get(row.sessionId)||null;return send(res,200,{item:{...row,...(related||{})}});}
        if(method==='POST'&&paymentRoute[2]==='refund'){
          if(user.role!=='admin')return send(res,403,{error:'Only an administrator can initiate refunds.'});
          if(!paymentLimit(user.id,'refund',4))return send(res,429,{error:'Too many refund attempts. Please wait and try again.'},{'Retry-After':'60'});
          try{return send(res,200,{item:await paymentService.refund(id)});}catch(error){logEvent('warn','payment.refund.failed',{requestId,status:error.status||502,errorType:error?.name||'Error'});return send(res,error.status||502,{error:error.message||'Refund could not be initiated.'});}
        }
      }
      return send(res,404,{error:'Not found.'});
    }

    if(path==='/api/subscriptions'||path.startsWith('/api/subscriptions/')){
      const user=userOnly(req,res);if(!user)return;
      if(method==='GET'&&path==='/api/subscriptions')return send(res,200,{current:subscriptionService.current(user.id),items:subscriptionService.list(user.id),paymentsEnabled:subscriptionService.paymentsEnabled,plans:Object.values(subscriptionPlans)});
      if(method==='GET'&&path==='/api/subscriptions/current')return send(res,200,{item:subscriptionService.current(user.id),active:subscriptionService.hasActiveSubscription(user.id)});
      if(method==='POST'&&path==='/api/subscriptions/checkout'){
        if(!paymentLimit(user.id,'subscription-checkout',5))return send(res,429,{error:'Too many subscription attempts. Please wait a minute.'},{'Retry-After':'60'});
        const input=await bodyJson(req);try{return send(res,201,await subscriptionService.checkout({userId:user.id,plan:input.plan}));}catch(error){return send(res,error.status||502,{error:error.message||'Subscription checkout failed.'});}
      }
      if(method==='POST'&&path==='/api/subscriptions/verify'){
        if(!paymentLimit(user.id,'subscription-verify',10))return send(res,429,{error:'Too many verification attempts. Please wait a minute.'},{'Retry-After':'60'});
        const input=await bodyJson(req);try{return send(res,200,{item:await subscriptionService.verify({userId:user.id,paymentId:String(input.paymentId||''),providerPaymentId:String(input.providerPaymentId||''),providerOrderId:String(input.providerOrderId||''),signature:String(input.signature||'')})});}catch(error){return send(res,error.status||502,{error:error.message||'Subscription payment could not be verified.'});}
      }
      const cancelPath=path.match(/^\/api\/subscriptions\/([^/]+)\/cancel$/);if(method==='POST'&&cancelPath){let id;try{id=decodeURIComponent(cancelPath[1]);}catch{return send(res,404,{error:'Pending subscription not found.'});}try{return send(res,200,{item:subscriptionService.cancel(user.id,id)});}catch(error){return send(res,error.status||400,{error:error.message||'Subscription could not be cancelled.'});}}
      return send(res,404,{error:'Not found.'});
    }

    if(path==='/api/reports'){
      const user=userOnly(req,res);if(!user)return;
      return createUserReport({req,res,url,db,user,send,randomUUID,adminNotification});
    }

    if(path==='/api/sessions'||path.startsWith('/api/sessions/')){
      const user=userOnly(req,res);if(!user)return;
      if(method==='GET'&&path==='/api/sessions/suggestions'){
        const swapRequestId=String(url.searchParams.get('swapRequestId')||''),swap=db.prepare("SELECT id,sender_id AS senderId,receiver_id AS receiverId FROM swap_requests WHERE id=? AND COALESCE(workflow_status,status) IN ('ACCEPTED','IN_PROGRESS') AND (sender_id=? OR receiver_id=?)").get(swapRequestId,user.id,user.id);if(!swap)return send(res,404,{error:'An active exchange is required.'});
        const peerId=swap.senderId===user.id?swap.receiverId:swap.senderId,own=db.prepare('SELECT day_of_week AS dayOfWeek,start_time AS startTime,end_time AS endTime,timezone FROM availability_slots WHERE user_id=? AND is_active=1').all(user.id),other=db.prepare('SELECT day_of_week AS dayOfWeek,start_time AS startTime,end_time AS endTime,timezone FROM availability_slots WHERE user_id=? AND is_active=1').all(peerId),suggestions=[];
        for(let offset=0;offset<21&&suggestions.length<4;offset++)for(const a of own){if(suggestions.length>=4)break;for(let minute=Number(a.startTime.slice(0,2))*60+Number(a.startTime.slice(3));minute+60<=Number(a.endTime.slice(0,2))*60+Number(a.endTime.slice(3))&&suggestions.length<4;minute+=15){const today=localParts(Date.now()+offset*86400000,a.timezone),date=`${today.year}-${today.month}-${today.day}`,time=`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`,startAt=localInstant(date,time,a.timezone);if(!startAt||new Date(startAt)<=new Date())continue;const endMinutes=minute+60,endTime=`${String(Math.floor(endMinutes/60)).padStart(2,'0')}:${String(endMinutes%60).padStart(2,'0')}`,endAt=localInstant(date,endTime,a.timezone);if(!endAt)continue;const candidate=new Date(startAt),p=localParts(candidate,a.timezone),ownDay=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday),ownTime=`${p.hour}:${p.minute}`,peerParts=other.some(b=>{const q=localParts(candidate,b.timezone),day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(q.weekday),localTime=`${q.hour}:${q.minute}`,localEnd=new Intl.DateTimeFormat('en-GB',{timeZone:b.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(endAt));return day===b.dayOfWeek&&localTime>=b.startTime&&localEnd<=b.endTime;});if(ownDay===a.dayOfWeek&&ownTime>=a.startTime&&peerParts&&!suggestions.some(s=>s.startAt===startAt))suggestions.push({startAt,endAt,timezone:a.timezone,date,time});}}
        return send(res,200,{items:suggestions});
      }
      if(path==='/api/sessions'&&method==='GET'){
        const tab=String(url.searchParams.get('tab')||'upcoming');if(!['upcoming','past','cancelled'].includes(tab))return send(res,400,{error:'Choose an available session view.'});
        const conditions=tab==='cancelled'?"ss.status='CANCELLED'":tab==='past'?"(ss.status='COMPLETED' OR ss.end_at<?)":"ss.status IN ('PROPOSED','CONFIRMED') AND ss.end_at>=?";
        const rows=db.prepare(`SELECT ss.id,ss.swap_request_id AS swapRequestId,ss.proposer_id AS proposerId,ss.start_at AS startAt,ss.end_at AS endAt,ss.timezone,ss.status,ss.meeting_link AS meetingLink,ss.notes,ss.reschedules_session_id AS reschedulesSessionId,ss.proposer_completed_at AS proposerCompletedAt,ss.partner_completed_at AS partnerCompletedAt,ss.created_at AS createdAt,ss.updated_at AS updatedAt,peer.id AS peerId,peer.name AS peerName,offered.name AS skillOffered,wanted.name AS skillWanted FROM skill_sessions ss JOIN swap_requests sr ON sr.id=ss.swap_request_id JOIN users peer ON peer.id=CASE WHEN sr.sender_id=? THEN sr.receiver_id ELSE sr.sender_id END JOIN skills offered ON offered.id=sr.skill_offered_id JOIN skills wanted ON wanted.id=sr.skill_wanted_id WHERE (sr.sender_id=? OR sr.receiver_id=?) AND ${conditions} ORDER BY ss.start_at ${tab==='past'?'DESC':'ASC'} LIMIT 100`).all(...(tab==='cancelled'?[user.id,user.id,user.id]:[user.id,user.id,user.id,new Date().toISOString()]));
        return send(res,200,{items:rows.map(item=>({...item,isPast:new Date(item.endAt).getTime()<Date.now()}))});
      }
      if(path==='/api/sessions'&&method==='POST'){
        const input=await bodyJson(req),swapRequestId=String(input.swapRequestId||''),timezone=String(input.timezone||''),date=String(input.date||''),startTime=String(input.startTime||''),endTime=String(input.endTime||''),notes=String(input.notes||'').trim().slice(0,1000),meetingLink=String(input.meetingLink||'').trim();
        const swap=db.prepare("SELECT id,sender_id AS senderId,receiver_id AS receiverId FROM swap_requests WHERE id=? AND COALESCE(workflow_status,status) IN ('ACCEPTED','IN_PROGRESS') AND (sender_id=? OR receiver_id=?)").get(swapRequestId,user.id,user.id);if(!swap)return send(res,404,{error:'An active exchange is required to propose a session.'});if(usersBlocked(user.id,swap.senderId===user.id?swap.receiverId:swap.senderId))return send(res,403,{error:"You can't interact with this user because one of you has blocked the other."});
        const startAt=localInstant(date,startTime,timezone),endAt=localInstant(date,endTime,timezone);if(!startAt||!endAt||new Date(endAt)<=new Date(startAt)||new Date(startAt)<=new Date())return send(res,400,{error:'Choose a valid future time range and time zone.'});
        if(new Date(endAt)-new Date(startAt)>8*60*60*1000)return send(res,400,{error:'A session can be up to 8 hours long.'});
        if(hasSessionConflict([swap.senderId,swap.receiverId],startAt,endAt))return send(res,409,{error:'This time overlaps another scheduled session for one of the participants.'});
        if(meetingLink){try{const link=new URL(meetingLink);if(!['http:','https:'].includes(link.protocol)||link.username||link.password||meetingLink.length>500)throw new Error();}catch{return send(res,400,{error:'Meeting links must be public HTTP or HTTPS links.'});}}
        const id=randomUUID(),now=new Date().toISOString();db.prepare('INSERT INTO skill_sessions(id,swap_request_id,proposer_id,start_at,end_at,timezone,status,meeting_link,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,\'PROPOSED\',?,?,?,?)').run(id,swapRequestId,user.id,startAt,endAt,timezone,meetingLink||null,notes,now,now);
        const conversationId=exchangeConversation(swap.senderId,swap.receiverId);addSystemMessage(conversationId,user.id,`A skill session was proposed for ${new Intl.DateTimeFormat('en',{dateStyle:'medium',timeStyle:'short',timeZone:timezone}).format(new Date(startAt))} (${timezone}).`);const item=sessionRow(id,user.id);sessionNotify({...item,actorId:user.id},'SESSION_PROPOSED','Session proposed',`${user.name} proposed a skill session.`);
        return send(res,201,{item});
      }
      const sessionRoute=path.match(/^\/api\/sessions\/([^/]+)(?:\/(accept|decline|reschedule|cancel|complete|calendar\.ics))?$/);
      if(sessionRoute){let id;try{id=decodeURIComponent(sessionRoute[1]);}catch{return send(res,404,{error:'Session not found.'});}const action=sessionRoute[2],item=sessionRow(id,user.id);if(!item)return send(res,404,{error:'Session not found.'});if(['accept','decline','reschedule'].includes(action)&&usersBlocked(user.id,item.peerId))return send(res,403,{error:"You can't interact with this user because one of you has blocked the other."});
        if(method==='GET'&&!action){const latest=db.prepare('SELECT id,status,amount,currency FROM payments WHERE session_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1').get(id,user.id);const paymentEligible=item.status==='CONFIRMED'&&['ACCEPTED','IN_PROGRESS'].includes(item.exchangeStatus);return send(res,200,{item:{...item,isPast:new Date(item.endAt).getTime()<Date.now(),paymentEligible,paymentEnabled:paymentService.paymentsEnabled,paymentRequired:paymentService.paymentsEnabled&&paymentEligible,paymentAmount:paymentService.amount,paymentCurrency:paymentService.currency,payment:latest||null}});}
        if(method==='GET'&&action==='calendar.ics'){
          if(!['PROPOSED','CONFIRMED'].includes(item.status))return send(res,409,{error:'Only scheduled sessions can be added to a calendar.'});
          const esc=s=>String(s||'').replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
          const stamp=s=>new Date(s).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
          const body=`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SkillSwap//Session//EN\r\nBEGIN:VEVENT\r\nUID:${item.id}@skillswap\r\nDTSTAMP:${stamp(item.createdAt)}\r\nDTSTART:${stamp(item.startAt)}\r\nDTEND:${stamp(item.endAt)}\r\nSUMMARY:${esc(`SkillSwap: ${item.skillOffered} ↔ ${item.skillWanted}`)}\r\nDESCRIPTION:${esc(item.notes||'Skill exchange session')}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
          res.writeHead(200,{'Content-Type':'text/calendar; charset=utf-8','Content-Disposition':`attachment; filename="skillswap-${item.id}.ics"`,'Cache-Control':'private, no-store'});res.end(body);return;
        }
        if(method!=='POST')return send(res,405,{error:'Method not allowed.'});
        if(!['ACCEPTED','IN_PROGRESS'].includes(item.exchangeStatus)&&action!=='cancel')return send(res,409,{error:'The linked exchange is no longer active.'});
        const partnerId=item.senderId===user.id?item.receiverId:item.senderId,now=new Date().toISOString();
        if(action==='accept'||action==='decline'){
          if(item.status!=='PROPOSED'||item.proposerId===user.id)return send(res,409,{error:'Only the other exchange participant can respond to a pending proposal.'});
          if(action==='accept'&&item.reschedulesSessionId){db.prepare("UPDATE skill_sessions SET status='CANCELLED',updated_at=? WHERE id=? AND status='CONFIRMED'").run(now,item.reschedulesSessionId);}
          const next=action==='accept'?'CONFIRMED':'CANCELLED';db.prepare('UPDATE skill_sessions SET status=?,updated_at=? WHERE id=? AND status=\'PROPOSED\'').run(next,now,id);
          const type=action==='accept'?'SESSION_CONFIRMED':(item.reschedulesSessionId?'SESSION_RESCHEDULED':'SESSION_DECLINED');createNotification({userId:item.proposerId,type,title:action==='accept'?'Session confirmed':item.reschedulesSessionId?'Reschedule declined':'Session declined',message:action==='accept'?`${user.name} confirmed the session.`:`${user.name} declined the session proposal.`,relatedSwapRequestId:item.swapRequestId,relatedSessionId:id,dedupeKey:`${type}:${id}:${now}`});
          sessionSystemMessage(item,user.id,action==='accept'?'A proposed session was confirmed.':item.reschedulesSessionId?'A proposed new time was declined; the original confirmed time remains scheduled.':'A proposed session was declined.');
          return send(res,200,{item:sessionRow(id,user.id)});
        }
        if(action==='reschedule'){
          if(item.status!=='CONFIRMED')return send(res,409,{error:'Only confirmed sessions can be rescheduled.'});
          if(db.prepare("SELECT 1 FROM skill_sessions WHERE reschedules_session_id=? AND status='PROPOSED'").get(id))return send(res,409,{error:'A reschedule proposal is already waiting for a response.'});
          const input=await bodyJson(req),timezone=String(input.timezone||item.timezone),startAt=localInstant(String(input.date||''),String(input.startTime||''),timezone),endAt=localInstant(String(input.date||''),String(input.endTime||''),timezone),meetingLink=String(input.meetingLink??item.meetingLink??'').trim(),notes=String(input.notes??item.notes??'').trim().slice(0,1000);
          if(!startAt||!endAt||new Date(endAt)<=new Date(startAt)||new Date(startAt)<=new Date()||new Date(endAt)-new Date(startAt)>8*60*60*1000)return send(res,400,{error:'Choose a valid future time range and time zone.'});
          if(hasSessionConflict([item.senderId,item.receiverId],startAt,endAt,item.id))return send(res,409,{error:'This time overlaps another scheduled session for one of the participants.'});
          if(meetingLink){try{const link=new URL(meetingLink);if(!['http:','https:'].includes(link.protocol)||link.username||link.password||meetingLink.length>500)throw new Error();}catch{return send(res,400,{error:'Meeting links must be public HTTP or HTTPS links.'});}}
          const childId=randomUUID();db.prepare('INSERT INTO skill_sessions(id,swap_request_id,proposer_id,start_at,end_at,timezone,status,meeting_link,notes,reschedules_session_id,created_at,updated_at) VALUES(?,?,?,?,?,?,\'PROPOSED\',?,?,?,?,?)').run(childId,item.swapRequestId,user.id,startAt,endAt,timezone,meetingLink||null,notes,id,now,now);
          sessionSystemMessage(item,user.id,`A new session time was proposed for ${new Intl.DateTimeFormat('en',{dateStyle:'medium',timeStyle:'short',timeZone:timezone}).format(new Date(startAt))} (${timezone}).`);createNotification({userId:partnerId,type:'SESSION_RESCHEDULED',title:'Session reschedule proposed',message:`${user.name} suggested a new session time.`,relatedSwapRequestId:item.swapRequestId,relatedSessionId:childId,dedupeKey:`SESSION_RESCHEDULED:${childId}`});return send(res,201,{item:sessionRow(childId,user.id)});
        }
        if(action==='cancel'){
          if(!['PROPOSED','CONFIRMED'].includes(item.status))return send(res,409,{error:'This session can no longer be cancelled.'});
          db.prepare("UPDATE skill_sessions SET status='CANCELLED',updated_at=? WHERE id=? AND status IN ('PROPOSED','CONFIRMED')").run(now,id);
          sessionSystemMessage(item,user.id,'A skill session was cancelled.');
          createNotification({userId:partnerId,type:'SESSION_CANCELLED',title:'Session cancelled',message:`${user.name} cancelled the session.`,relatedSwapRequestId:item.swapRequestId,relatedSessionId:id,dedupeKey:`SESSION_CANCELLED:${id}:${now}`});
          return send(res,200,{item:sessionRow(id,user.id)});
        }
        if(action==='complete'){
          if(item.status!=='CONFIRMED')return send(res,409,{error:'Only confirmed sessions can be marked complete.'});
          const own=item.proposerId===user.id?'proposer_completed_at':'partner_completed_at',other=item.proposerId===user.id?'partner_completed_at':'proposer_completed_at';db.prepare(`UPDATE skill_sessions SET ${own}=COALESCE(${own},?),updated_at=? WHERE id=? AND status='CONFIRMED'`).run(now,now,id);
          const latest=db.prepare('SELECT proposer_completed_at AS proposerCompletedAt,partner_completed_at AS partnerCompletedAt FROM skill_sessions WHERE id=?').get(id);
          sessionSystemMessage(item,user.id,latest.proposerCompletedAt&&latest.partnerCompletedAt?'Both participants confirmed the session is complete.':`${user.name} marked the session complete. Waiting for the other participant to confirm.`);
          if(latest.proposerCompletedAt&&latest.partnerCompletedAt){db.prepare("UPDATE skill_sessions SET status='COMPLETED',updated_at=? WHERE id=? AND status='CONFIRMED'").run(now,id);for(const recipient of [item.senderId,item.receiverId])createNotification({userId:recipient,type:'SESSION_COMPLETED',title:'Session completed',message:'Both participants confirmed this skill session.',relatedSwapRequestId:item.swapRequestId,relatedSessionId:id,dedupeKey:`SESSION_COMPLETED:${id}:${recipient}`});return send(res,200,{item:sessionRow(id,user.id),completed:true});}
          createNotification({userId:partnerId,type:'SESSION_COMPLETED',title:'Confirm session completion',message:`${user.name} marked the session complete. Please confirm when ready.`,relatedSwapRequestId:item.swapRequestId,relatedSessionId:id,dedupeKey:`SESSION_COMPLETION_CONFIRM:${id}:${user.id}`});return send(res,200,{item:sessionRow(id,user.id),completed:false});
        }
        return send(res,404,{error:'Not found.'});
      }
      return send(res,404,{error:'Not found.'});
    }

    if (path.startsWith('/api/admin/')) {
      const admin = adminOnly(req, res);
      if (!admin) return;
      return handleAdminApi({req,res,path,method,url,db,admin,send,randomUUID,auditAdmin,adminNotification,revokeRealtime:userId=>closeRealtimeForUser(userId,'SESSION_REVOKED'),recommendationMetrics:recommendations.metrics,subscriptionService});
    }

    if (path === '/api/profile/me') {
      const user = userOnly(req, res); if (!user) return;
      if (method === 'GET') {
        const row = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
        return send(res, 200, { profile: mapOwnProfile(row) });
      }
      if (method === 'PATCH') {
        const input = await bodyJson(req);
        const current = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
        if (input.showEmail !== undefined && typeof input.showEmail !== 'boolean') return send(res,400,{error:'Show Email must be true or false.'});
        const fields = {
          name: String(input.name ?? current.name).trim(), bio: String(input.bio ?? current.bio).trim(),
          college: String(input.college ?? current.college).trim(), location: String(input.location ?? current.location).trim(),
          website: String(input.website ?? current.website).trim(), learning_goals: String(input.learningGoals ?? current.learning_goals).trim(),
          profile_visibility: String(input.profileVisibility ?? current.profile_visibility).toUpperCase(),
          show_email: input.showEmail === undefined ? current.show_email : (input.showEmail ? 1 : 0)
        };
        if (fields.name.length < 2 || fields.name.length > 100 || fields.bio.length > 500 || fields.college.length > 120 || fields.location.length > 120 || fields.website.length > 300 || fields.learning_goals.length > 500 || !['PUBLIC','USERS','PRIVATE'].includes(fields.profile_visibility) || (fields.website && !/^https?:\/\//i.test(fields.website))) return send(res, 400, { error: 'Check the profile fields and try again.' });
        db.prepare(`UPDATE users SET name=?,bio=?,college=?,location=?,website=?,learning_goals=?,profile_visibility=?,show_email=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(fields.name,fields.bio,fields.college,fields.location,fields.website,fields.learning_goals,fields.profile_visibility,fields.show_email,user.id);
        return send(res, 200, { profile: mapOwnProfile(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)) });
      }
      return send(res,405,{error:'Method not allowed.'});
    }
    if(path==='/api/dashboard'&&method==='GET'){
      const user=userOnly(req,res);if(!user)return;if(user.role!=='user')return send(res,403,{error:'Use the administrator dashboard for this account.'});
      const profileRow=db.prepare('SELECT id,name,avatar,bio,college,location,learning_goals AS learningGoals,profile_visibility AS profileVisibility FROM users WHERE id=?').get(user.id);
      const skills=userSkillSelect.all(user.id),completion=profileCompletion(user.id,{...profileRow,learning_goals:profileRow.learningGoals});
      const matchCount=db.prepare(`SELECT COUNT(DISTINCT peer.id) AS count FROM users peer JOIN user_skills peer_teach ON peer_teach.user_id=peer.id AND peer_teach.type='TEACH' JOIN user_skills own_learn ON own_learn.skill_id=peer_teach.skill_id AND own_learn.user_id=? AND own_learn.type='LEARN' WHERE peer.id!=? AND peer.status='active' AND coalesce(peer.profile_visibility,'PUBLIC')!='PRIVATE'`).get(user.id,user.id).count;
      const pendingRequests=db.prepare("SELECT COUNT(*) AS count FROM swap_requests WHERE status='PENDING' AND (sender_id=? OR receiver_id=?)").get(user.id,user.id).count;
      const activeExchanges=db.prepare("SELECT COUNT(*) AS count FROM swap_requests WHERE COALESCE(workflow_status,status) IN ('ACCEPTED','IN_PROGRESS') AND (sender_id=? OR receiver_id=?)").get(user.id,user.id).count;
      const completedExchanges=db.prepare("SELECT COUNT(*) AS count FROM swap_requests WHERE COALESCE(workflow_status,status)='COMPLETED' AND (sender_id=? OR receiver_id=?)").get(user.id,user.id).count;
      const unreadMessages=db.prepare(`SELECT COUNT(*) AS count FROM messages m JOIN conversation_participants p ON p.conversation_id=m.conversation_id AND p.user_id=? WHERE m.sender_id!=? AND m.read_at IS NULL`).get(user.id,user.id).count;
      const ratings=db.prepare("SELECT review_type AS reviewType,COUNT(*) AS total,COALESCE(AVG(rating),0) AS average FROM reviews WHERE reviewee_id=? GROUP BY review_type").all(user.id),teachingRating=ratings.find(x=>x.reviewType==='TEACHING'),learningRating=ratings.find(x=>x.reviewType==='LEARNING');
      const matches=findMatches(db,user.id,new URLSearchParams({page:'1',pageSize:'4'})).items;
      const swapRequests=db.prepare(`SELECT sr.id,sr.sender_id AS senderId,sender.name AS senderName,sr.receiver_id AS receiverId,receiver.name AS receiverName,sr.skill_offered_id AS skillOfferedId,offered.name AS skillOffered,sr.skill_wanted_id AS skillWantedId,wanted.name AS skillWanted,CASE WHEN sr.sender_id=? THEN 'SENT' ELSE 'RECEIVED' END AS direction,sr.status,sr.message,sr.created_at AS createdAt,sr.sender_completed_at AS senderCompletedAt,sr.receiver_completed_at AS receiverCompletedAt,sr.completed_at AS completedAt FROM swap_requests sr JOIN users sender ON sender.id=sr.sender_id JOIN users receiver ON receiver.id=sr.receiver_id JOIN skills offered ON offered.id=sr.skill_offered_id JOIN skills wanted ON wanted.id=sr.skill_wanted_id WHERE sr.status='PENDING' AND (sr.sender_id=? OR sr.receiver_id=?) ORDER BY sr.created_at DESC LIMIT 4`).all(user.id,user.id,user.id);
      const conversations=db.prepare(`SELECT c.id AS conversationId,peer.id AS userId,peer.name,CASE WHEN peer.avatar IS NULL OR peer.avatar='' THEN NULL ELSE '/api/profile/avatar/'||peer.id END AS avatar,(SELECT m.content FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS lastMessage,(SELECT m.created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS lastMessageAt,(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.sender_id!=? AND m.read_at IS NULL) AS unreadCount,c.updated_at AS updatedAt FROM conversations c JOIN users peer ON peer.id=CASE WHEN c.user_one_id=? THEN c.user_two_id ELSE c.user_one_id END JOIN conversation_participants p ON p.conversation_id=c.id AND p.user_id=? WHERE peer.status='active' ORDER BY COALESCE(lastMessageAt,c.updated_at) DESC LIMIT 4`).all(user.id,user.id,user.id);
      const notifications=db.prepare(`SELECT id,type,title,message,related_user_id AS relatedUserId,related_conversation_id AS relatedConversationId,related_swap_request_id AS relatedSwapRequestId,related_skill_id AS relatedSkillId,related_session_id AS relatedSessionId,is_read AS isRead,created_at AS createdAt,updated_at AS updatedAt FROM notifications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 5`).all(user.id).map(notificationItem);
      const recentActivity=db.prepare(`SELECT id,type,title,message,related_user_id AS relatedUserId,related_conversation_id AS relatedConversationId,related_swap_request_id AS relatedSwapRequestId,related_skill_id AS relatedSkillId,related_session_id AS relatedSessionId,is_read AS isRead,created_at AS createdAt,updated_at AS updatedAt FROM notifications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 8`).all(user.id).map(notificationItem);
      const upcomingSessions=db.prepare(`SELECT ss.id,ss.swap_request_id AS swapRequestId,ss.start_at AS startAt,ss.end_at AS endAt,ss.timezone,ss.status,peer.name AS peerName,offered.name AS skillOffered,wanted.name AS skillWanted FROM skill_sessions ss JOIN swap_requests sr ON sr.id=ss.swap_request_id JOIN users peer ON peer.id=CASE WHEN sr.sender_id=? THEN sr.receiver_id ELSE sr.sender_id END JOIN skills offered ON offered.id=sr.skill_offered_id JOIN skills wanted ON wanted.id=sr.skill_wanted_id WHERE (sr.sender_id=? OR sr.receiver_id=?) AND ss.status IN ('PROPOSED','CONFIRMED') AND ss.end_at>=? ORDER BY ss.start_at LIMIT 4`).all(user.id,user.id,user.id,new Date().toISOString());
      const activeSwaps=db.prepare(`SELECT sr.id,sr.sender_id AS senderId,sender.name AS senderName,sr.receiver_id AS receiverId,receiver.name AS receiverName,sr.skill_offered_id AS skillOfferedId,offered.name AS skillOffered,sr.skill_wanted_id AS skillWantedId,wanted.name AS skillWanted,CASE WHEN sr.sender_id=? THEN 'SENT' ELSE 'RECEIVED' END AS direction,COALESCE(sr.workflow_status,sr.status) AS status,sr.message,sr.sender_completed_at AS senderCompletedAt,sr.receiver_completed_at AS receiverCompletedAt,sr.completed_at AS completedAt,sr.created_at AS createdAt,sr.updated_at AS updatedAt FROM swap_requests sr JOIN users sender ON sender.id=sr.sender_id JOIN users receiver ON receiver.id=sr.receiver_id JOIN skills offered ON offered.id=sr.skill_offered_id JOIN skills wanted ON wanted.id=sr.skill_wanted_id WHERE COALESCE(sr.workflow_status,sr.status) IN ('ACCEPTED','IN_PROGRESS') AND (sr.sender_id=? OR sr.receiver_id=?) ORDER BY sr.updated_at DESC LIMIT 4`).all(user.id,user.id,user.id);
      const recentPayments=db.prepare('SELECT p.id,p.amount,p.currency,p.status,p.description,p.created_at AS createdAt,p.session_id AS sessionId FROM payments p WHERE p.user_id=? ORDER BY p.created_at DESC LIMIT 3').all(user.id);
      return send(res,200,{profile:{id:profileRow.id,name:profileRow.name,avatar:profileRow.avatar?`/api/profile/avatar/${encodeURIComponent(user.id)}`:null,bio:profileRow.bio,college:profileRow.college,location:profileRow.location,learningGoals:profileRow.learningGoals,completion},stats:{matches:matchCount,pendingRequests,activeExchanges,completedExchanges,unreadMessages,teachingAverageRating:Number((teachingRating?.average||0).toFixed(2)),teachingReviewCount:teachingRating?.total||0,learningAverageRating:Number((learningRating?.average||0).toFixed(2)),learningReviewCount:learningRating?.total||0},subscription:(()=>{const s=subscriptionService.current(user.id);return s?{status:s.status,plan:s.plan,endAt:s.endAt}:null})(),skills:{teaching:skills.filter(s=>s.type==='TEACH'),learning:skills.filter(s=>s.type==='LEARN')},matches,swapRequests,activeSwaps,conversations,notifications,recentActivity,upcomingSessions,recentPayments});
    }
    if(path==='/api/realtime/events'&&method==='GET'){
      const user=userOnly(req,res);if(!user)return;
      const streams=realtimeStreams.get(user.id)||new Set();
      const attempts=(realtimeConnectRate.get(user.id)||[]).filter(t=>Date.now()-t<60_000);if(attempts.length>=60)return send(res,429,{error:'Live updates are reconnecting too often. Wait a moment and retry.'},{'Retry-After':'60'});attempts.push(Date.now());realtimeConnectRate.set(user.id,attempts);
      if(streams.size>=3)return send(res,429,{error:'Too many live connections. Close another tab and retry.'});
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write('retry: 3000\n\n');
      const wasOnline=streams.size>0;streams.add(res);realtimeStreams.set(user.id,streams);res.heartbeat=setInterval(()=>{if(!db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(user.id)){closeRealtimeForUser(user.id);return;}if(!res.destroyed&&!res.writableEnded)try{res.write(': keep-alive\n\n')}catch{res.destroy();}},25_000);
      res.on('close',()=>{clearInterval(res.heartbeat);const current=realtimeStreams.get(user.id);if(current){current.delete(res);if(!current.size){realtimeStreams.delete(user.id);broadcastPresence(user.id,'OFFLINE');}}});
      if(!wasOnline)broadcastPresence(user.id,'ONLINE');return;
    }
    if(path.startsWith('/api/realtime/presence/')&&method==='GET'){
      const user=userOnly(req,res);if(!user)return;let targetId;try{targetId=decodeURIComponent(path.slice('/api/realtime/presence/'.length));}catch{return send(res,404,{error:'Member not found.'});}
      if(targetId===user.id)return send(res,200,{visible:true,state:'ONLINE'});
      if(!presenceVisible(targetId,user.id))return send(res,200,{visible:false});
      return send(res,200,{visible:true,state:realtimeStreams.get(targetId)?.size?'ONLINE':'OFFLINE'});
    }
    if(path==='/api/realtime/typing'&&method==='POST'){
      const user=userOnly(req,res);if(!user)return;const input=await bodyJson(req),conversationId=String(input.conversationId||''),action=input.action;
      if(!conversationId||!['start','stop'].includes(action))return send(res,400,{error:'Choose a conversation and typing action.'});
      if(!conversationAccess(conversationId,user.id))return send(res,404,{error:'Conversation not found.'});
      const peer=peerFor(conversationId,user.id);if(!peer||usersBlocked(user.id,peer.id))return send(res,403,{error:"You can't interact with this user because one of you has blocked the other."});
      const timerKey=`${conversationId}:${user.id}`;
      if(action==='start'){
        const now=Date.now(),last=typingRate.get(timerKey)||0;if(now-last<1000)return send(res,200,{ok:true});typingRate.set(timerKey,now);
        const old=typingTimers.get(timerKey);if(old)clearTimeout(old);
        publishConversation(conversationId,'TYPING_STARTED',{conversationId,userId:user.id,name:user.name});
        typingTimers.set(timerKey,setTimeout(()=>{typingTimers.delete(timerKey);publishConversation(conversationId,'TYPING_STOPPED',{conversationId,userId:user.id});},3500));
      }else{const timer=typingTimers.get(timerKey);if(timer){clearTimeout(timer);typingTimers.delete(timerKey);publishConversation(conversationId,'TYPING_STOPPED',{conversationId,userId:user.id});}}
      return send(res,200,{ok:true});
    }

    if (path === '/api/conversations' || path.startsWith('/api/conversations/')) {
      const user = userOnly(req,res); if (!user) return;
      if (method === 'GET' && path === '/api/conversations') {
        const items = db.prepare(`SELECT c.id AS conversationId,peer.id AS userId,peer.name,CASE WHEN peer.avatar IS NULL OR peer.avatar='' THEN NULL ELSE '/api/profile/avatar/'||peer.id END AS avatar,
          (SELECT m.content FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS lastMessage,
          (SELECT m.created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS lastMessageAt,
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.sender_id!=? AND m.read_at IS NULL) AS unreadCount,
          c.created_at AS createdAt,c.updated_at AS updatedAt
          FROM conversations c JOIN users peer ON peer.id=CASE WHEN c.user_one_id=? THEN c.user_two_id ELSE c.user_one_id END
          JOIN conversation_participants p ON p.conversation_id=c.id AND p.user_id=?
          WHERE peer.status='active' ORDER BY COALESCE(lastMessageAt,c.updated_at) DESC,c.id`).all(user.id,user.id,user.id);
        return send(res,200,{items});
      }
      if (method === 'POST' && path === '/api/conversations') {
        const input=await bodyJson(req); const peerId=String(input.userId||'');
        if (!peerId || peerId===user.id) return send(res,400,{error:'Choose another SkillSwap member.'});
        const peer=db.prepare('SELECT id,status,profile_visibility,allow_direct_messages AS allowDirectMessages FROM users WHERE id=?').get(peerId);
        if (!peer || peer.status!=='active') return send(res,404,{error:'Member not found.'});
        if(usersBlocked(user.id,peerId))return send(res,403,{error:"You can't interact with this user because one of you has blocked the other."});if(!peer.allowDirectMessages)return send(res,403,{error:'This member is not accepting direct messages.'});
        const one=user.id<peerId?user.id:peerId, two=user.id<peerId?peerId:user.id;
        let conversation=db.prepare('SELECT id FROM conversations WHERE user_one_id=? AND user_two_id=?').get(one,two); let created=false;
        if (!conversation) {
          if (!profileAllowed(peer,user)) return send(res,404,{error:'Member not found.'});
          const id=randomUUID();
          created=!!db.prepare('INSERT OR IGNORE INTO conversations (id,user_one_id,user_two_id) VALUES (?,?,?)').run(id,one,two).changes;
          conversation=db.prepare('SELECT id FROM conversations WHERE user_one_id=? AND user_two_id=?').get(one,two);
          db.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id,user_id) VALUES (?,?)').run(conversation.id,one);
          db.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id,user_id) VALUES (?,?)').run(conversation.id,two);
        }
        return send(res,200,{conversationId:conversation.id,created});
      }
      if (method === 'GET' && path === '/api/conversations/unread-count') {
        const unreadCount=db.prepare(`SELECT COUNT(*) AS count FROM messages m JOIN conversation_participants p ON p.conversation_id=m.conversation_id AND p.user_id=? WHERE m.sender_id!=? AND m.read_at IS NULL`).get(user.id,user.id).count;
        return send(res,200,{unreadCount});
      }
      const conversationPath=path.match(/^\/api\/conversations\/([^/]+)(?:\/(messages|read))?$/);
      if (!conversationPath) return send(res,404,{error:'Not found.'});
      let conversationId; try { conversationId=decodeURIComponent(conversationPath[1]); } catch { return send(res,404,{error:'Conversation not found.'}); }
      if (!conversationAccess(conversationId,user.id)) return send(res,404,{error:'Conversation not found.'});
      if (method==='GET' && conversationPath[2]==='messages') {
        const items=db.prepare(`SELECT m.id,m.conversation_id AS conversationId,m.sender_id AS senderId,
          CASE WHEN m.is_system=1 THEN 'SkillSwap' ELSE sender.name END AS senderName,m.content,m.is_system AS isSystem,m.created_at AS createdAt,m.updated_at AS updatedAt,m.read_at AS readAt
          FROM messages m JOIN users sender ON sender.id=m.sender_id WHERE m.conversation_id=?
          ORDER BY m.created_at DESC,m.id DESC LIMIT 100`).all(conversationId).reverse();
        return send(res,200,{items,otherUser:peerFor(conversationId,user.id)});
      }
      if (method==='PATCH' && conversationPath[2]==='read') {
        const result=db.prepare('UPDATE messages SET read_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE conversation_id=? AND sender_id!=? AND read_at IS NULL').run(conversationId,user.id);
        if(result.changes)publishConversation(conversationId,'MESSAGE_READ',{conversationId,readerId:user.id});
        return send(res,200,{ok:true});
      }
      if (method==='POST' && conversationPath[2]==='messages') {
        const peer=peerFor(conversationId,user.id);if(!peer||usersBlocked(user.id,peer.id))return send(res,403,{error:"You can't interact with this user because one of you has blocked the other."});
        if(!db.prepare('SELECT allow_direct_messages FROM users WHERE id=?').get(peer.id)?.allow_direct_messages)return send(res,403,{error:'This member is not accepting direct messages.'});
        const input=await bodyJson(req);
        if (typeof input.content!=='string') return send(res,400,{error:'Enter a message before sending.'});
        const content=input.content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,'').trim();
        if (!content) return send(res,400,{error:'Enter a message before sending.'});
        if (content.length>2000) return send(res,400,{error:'Messages must be 2,000 characters or fewer.'});
        const now=Date.now(); const recent=(messageRate.get(user.id)||[]).filter(time=>now-time<60_000);
        if (recent.length>=30) { messageRate.set(user.id,recent); return send(res,429,{error:'You are sending messages too quickly. Please wait a moment.'},{'Retry-After':'60'}); }
        recent.push(now); messageRate.set(user.id,recent);
        if (messageRate.size>10000) for (const [id,times] of messageRate) if (!times.some(time=>now-time<60_000)) messageRate.delete(id);
        const id=randomUUID(),timestamp=new Date().toISOString(); db.prepare('INSERT INTO messages (id,conversation_id,sender_id,content,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id,conversationId,user.id,content,timestamp,timestamp);
        db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(timestamp,conversationId);
        const receiver=db.prepare(`SELECT u.id FROM conversation_participants p JOIN users u ON u.id=p.user_id
          WHERE p.conversation_id=? AND p.user_id!=? AND u.status='active'`).get(conversationId,user.id);
        if(receiver) createNotification({userId:receiver.id,type:'NEW_MESSAGE',title:'New Message',message:`${user.name} sent you a message.`,relatedUserId:user.id,relatedConversationId:conversationId,dedupeKey:`message:${id}`});
        const item=db.prepare(`SELECT id,conversation_id AS conversationId,sender_id AS senderId,content,is_system AS isSystem,created_at AS createdAt,updated_at AS updatedAt,read_at AS readAt FROM messages WHERE id=?`).get(id);
        publishConversation(conversationId,'MESSAGE_CREATED',{conversationId,message:{...item,isSystem:!!item.isSystem}});
        return send(res,201,{item});
      }
      return send(res,405,{error:'Method not allowed.'});
    }

    if (path === '/api/reviews' || path.startsWith('/api/reviews/')) {
      if(method==='POST'&&path==='/api/reviews'){
        const user=userOnly(req,res);if(!user)return;const input=await bodyJson(req);
        const revieweeId=String(input.revieweeId||''),swapRequestId=String(input.swapRequestId||''),rating=Number(input.rating),reviewType=String(input.reviewType||'TEACHING').toUpperCase();
        if(!revieweeId||!swapRequestId||!Number.isInteger(rating)||rating<1||rating>5)return send(res,400,{error:'Select an exchange and a rating from 1 to 5.'});
        if(!['TEACHING','LEARNING'].includes(reviewType))return send(res,400,{error:'Choose a teaching or learning review.'});
        if(typeof input.comment!=='string'&&input.comment!==undefined)return send(res,400,{error:'Review comments must be text.'});
        const comment=String(input.comment||'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F<>]/g,'').trim();if(comment.length>500)return send(res,400,{error:'Review comments must be 500 characters or fewer.'});
        const swap=db.prepare('SELECT sender_id AS senderId,receiver_id AS receiverId,skill_offered_id AS skillOfferedId,skill_wanted_id AS skillWantedId,completed_at AS completedAt FROM swap_requests WHERE id=?').get(swapRequestId);
        if(!swap||!swap.completedAt)return send(res,403,{error:'Reviews are available after both members confirm the exchange is complete.'});
        const other=swap.senderId===user.id?swap.receiverId:swap.receiverId===user.id?swap.senderId:null;if(!other)return send(res,403,{error:'You did not take part in this exchange.'});
        if(revieweeId!==other||revieweeId===user.id)return send(res,400,{error:'You can review only the other member in this exchange.'});
        const subjectSkillId=reviewType==='TEACHING'?(revieweeId===swap.senderId?swap.skillOfferedId:swap.skillWantedId):(revieweeId===swap.senderId?swap.skillWantedId:swap.skillOfferedId);
        if(!subjectSkillId)return send(res,403,{error:'This exchange does not include the selected teaching or learning role.'});
        const id=randomUUID(),timestamp=new Date().toISOString();
        try{db.prepare('INSERT INTO reviews (id,reviewer_id,reviewee_id,swap_request_id,rating,comment,review_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id,user.id,revieweeId,swapRequestId,rating,comment,reviewType,timestamp,timestamp);}
        catch(error){if(String(error.message).includes('UNIQUE'))return send(res,409,{error:`You already left a ${reviewType.toLowerCase()} review for this exchange.`});throw error;}
        createNotification({userId:revieweeId,type:'REVIEW_RECEIVED',title:'New Review',message:`${user.name} left you a ${rating}-star ${reviewType.toLowerCase()} review.`,relatedUserId:user.id,relatedSwapRequestId:swapRequestId,dedupeKey:`review:${id}`});
        return send(res,201,{item:{id,reviewerId:user.id,revieweeId,swapRequestId,rating,comment,reviewType,createdAt:timestamp,updatedAt:timestamp}});
      }
      const reviewPath=path.match(/^\/api\/reviews\/([^/]+)$/);
      if(reviewPath&&method==='PATCH'){
        const user=userOnly(req,res);if(!user)return;let id;try{id=decodeURIComponent(reviewPath[1]);}catch{return send(res,404,{error:'Review not found.'});}
        const review=db.prepare('SELECT reviewer_id AS reviewerId FROM reviews WHERE id=?').get(id);if(!review)return send(res,404,{error:'Review not found.'});if(review.reviewerId!==user.id)return send(res,403,{error:'Only the original reviewer can edit this review.'});
        const input=await bodyJson(req),rating=Number(input.rating);if(!Number.isInteger(rating)||rating<1||rating>5)return send(res,400,{error:'Choose a rating from 1 to 5.'});if(typeof input.comment!=='string'&&input.comment!==undefined)return send(res,400,{error:'Review comments must be text.'});
        const comment=String(input.comment||'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F<>]/g,'').trim();if(comment.length>500)return send(res,400,{error:'Review comments must be 500 characters or fewer.'});
        db.prepare('UPDATE reviews SET rating=?,comment=?,updated_at=? WHERE id=? AND reviewer_id=?').run(rating,comment,new Date().toISOString(),id,user.id);return send(res,200,{ok:true});
      }
      if(reviewPath&&method==='DELETE'){
        const user=authenticatedUser(req);if(!user)return send(res,401,{error:'Authentication required.'});let id;try{id=decodeURIComponent(reviewPath[1]);}catch{return send(res,404,{error:'Review not found.'});}
        const review=db.prepare('SELECT reviewer_id AS reviewerId FROM reviews WHERE id=?').get(id);if(!review)return send(res,404,{error:'Review not found.'});if(user.role!=='admin'&&review.reviewerId!==user.id)return send(res,403,{error:'Only the original reviewer or an administrator can delete this review.'});
        db.prepare('DELETE FROM reviews WHERE id=?').run(id);return send(res,200,{ok:true});
      }
      const summaryPath=path.match(/^\/api\/reviews\/user\/([^/]+)\/summary$/);
      const listPath=path.match(/^\/api\/reviews\/user\/([^/]+)$/);
      if((method==='GET'&&summaryPath)||(method==='GET'&&listPath)){
        const match=summaryPath||listPath;let revieweeId;try{revieweeId=decodeURIComponent(match[1]);}catch{return send(res,404,{error:'Profile not found.'});}
        const target=db.prepare("SELECT id,profile_visibility,show_reviews AS showReviews FROM users WHERE id=? AND status='active'").get(revieweeId),viewer=authenticatedUser(req);if(!profileAllowed(target,viewer))return send(res,404,{error:'Profile not found.'});if(!target.showReviews&&viewer?.id!==target.id)return summaryPath?send(res,200,{teachingAverageRating:0,teachingReviewCount:0,learningAverageRating:0,learningReviewCount:0,breakdowns:{TEACHING:{5:0,4:0,3:0,2:0,1:0},LEARNING:{5:0,4:0,3:0,2:0,1:0}}}):send(res,200,{items:[],page:1,limit:10,total:0,hasMore:false});
        const summaryRows=db.prepare('SELECT review_type AS reviewType,COUNT(*) AS total,COALESCE(AVG(rating),0) AS average FROM reviews WHERE reviewee_id=? GROUP BY review_type').all(revieweeId);
        const teaching=summaryRows.find(row=>row.reviewType==='TEACHING'),learning=summaryRows.find(row=>row.reviewType==='LEARNING');
        const breakdowns={TEACHING:{5:0,4:0,3:0,2:0,1:0},LEARNING:{5:0,4:0,3:0,2:0,1:0}};for(const row of db.prepare('SELECT review_type AS reviewType,rating,COUNT(*) AS count FROM reviews WHERE reviewee_id=? GROUP BY review_type,rating').all(revieweeId))breakdowns[row.reviewType][row.rating]=row.count;
        if(summaryPath)return send(res,200,{teachingAverageRating:Number((teaching?.average||0).toFixed(2)),teachingReviewCount:teaching?.total||0,learningAverageRating:Number((learning?.average||0).toFixed(2)),learningReviewCount:learning?.total||0,breakdowns});
        const page=Math.max(1,Number.parseInt(url.searchParams.get('page')||'1',10)||1),limit=Math.min(50,Math.max(1,Number.parseInt(url.searchParams.get('limit')||'10',10)||10));
        const reviewType=String(url.searchParams.get('type')||'ALL').toUpperCase();if(!['ALL','TEACHING','LEARNING'].includes(reviewType))return send(res,400,{error:'Choose a teaching or learning review filter.'});
        const typeFilter=reviewType==='ALL'?'':' AND r.review_type=?',typeArgs=reviewType==='ALL'?[revieweeId]:[revieweeId,reviewType];
        const total=Number(db.prepare(`SELECT COUNT(*) AS n FROM reviews r WHERE r.reviewee_id=?${typeFilter}`).get(...typeArgs).n);
        const items=db.prepare(`SELECT r.id,r.reviewer_id AS reviewerId,reviewer.name AS reviewerName,CASE WHEN reviewer.avatar IS NOT NULL AND reviewer.avatar!='' AND coalesce(reviewer.profile_visibility,'PUBLIC')!='PRIVATE' THEN '/api/profile/avatar/'||reviewer.id ELSE NULL END AS reviewerAvatar,r.reviewee_id AS revieweeId,r.swap_request_id AS swapRequestId,r.rating,r.comment,r.review_type AS reviewType,r.created_at AS createdAt,r.updated_at AS updatedAt,offered.name AS skillOffered,wanted.name AS skillWanted FROM reviews r JOIN users reviewer ON reviewer.id=r.reviewer_id JOIN swap_requests sr ON sr.id=r.swap_request_id JOIN skills offered ON offered.id=sr.skill_offered_id JOIN skills wanted ON wanted.id=sr.skill_wanted_id WHERE r.reviewee_id=?${typeFilter} ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?`).all(...typeArgs,limit,(page-1)*limit);
        return send(res,200,{items,page,limit,total,hasMore:page*limit<total});
      }
      return send(res,404,{error:'Not found.'});
    }

    if (path === '/api/notifications' || path.startsWith('/api/notifications/')) {
      const user=userOnly(req,res); if(!user)return;
      if(method==='GET'&&path==='/api/notifications'){
        const filter=String(url.searchParams.get('filter')||'all').toLowerCase();if(!['all','unread'].includes(filter))return send(res,400,{error:'Choose All or Unread.'});
        const page=Math.max(1,Number.parseInt(url.searchParams.get('page')||'1',10)||1),limit=Math.min(50,Math.max(1,Number.parseInt(url.searchParams.get('limit')||'20',10)||20));
        const where=filter==='unread'?'AND is_read=0':'';const total=db.prepare(`SELECT COUNT(*) AS count FROM notifications WHERE user_id=? ${where}`).get(user.id).count;
        const rows=db.prepare(`SELECT id,type,title,message,related_user_id AS relatedUserId,related_conversation_id AS relatedConversationId,related_swap_request_id AS relatedSwapRequestId,related_skill_id AS relatedSkillId,related_session_id AS relatedSessionId,is_read AS isRead,created_at AS createdAt,updated_at AS updatedAt FROM notifications WHERE user_id=? ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(user.id,limit,(page-1)*limit);
        const unreadCount=db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND is_read=0').get(user.id).count;
        return send(res,200,{items:rows.map(notificationItem),page,limit,total,unreadCount,hasMore:page*limit<total});
      }
      if(method==='GET'&&path==='/api/notifications/unread-count'){
        return send(res,200,{unreadCount:db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND is_read=0').get(user.id).count});
      }
      if(method==='PATCH'&&path==='/api/notifications/read-all'){
        const result=db.prepare('UPDATE notifications SET is_read=1,updated_at=? WHERE user_id=? AND is_read=0').run(new Date().toISOString(),user.id);
        return send(res,200,{ok:true,updated:result.changes});
      }
      if(method==='DELETE'&&path==='/api/notifications/read'){
        const result=db.prepare('DELETE FROM notifications WHERE user_id=? AND is_read=1').run(user.id);return send(res,200,{ok:true,deleted:result.changes});
      }
      const notificationRoute=path.match(/^\/api\/notifications\/([^/]+)(?:\/(read))?$/);
      if(notificationRoute){let id;try{id=decodeURIComponent(notificationRoute[1]);}catch{return send(res,404,{error:'Notification not found.'});}
        if(method==='PATCH'&&notificationRoute[2]==='read'){
          const result=db.prepare('UPDATE notifications SET is_read=1,updated_at=? WHERE id=? AND user_id=?').run(new Date().toISOString(),id,user.id);
          return result.changes?send(res,200,{ok:true}):send(res,404,{error:'Notification not found.'});
        }
        if(method==='DELETE'&&!notificationRoute[2]){
          const result=db.prepare('DELETE FROM notifications WHERE id=? AND user_id=?').run(id,user.id);
          return result.changes?send(res,200,{ok:true}):send(res,404,{error:'Notification not found.'});
        }
      }
      return send(res,404,{error:'Not found.'});
    }

    const avatarView = path.match(/^\/api\/profile\/avatar\/([^/]+)$/);
    if (method === 'GET' && avatarView) {
      const id = decodeURIComponent(avatarView[1]); const row = db.prepare('SELECT id,avatar,profile_visibility FROM users WHERE id=?').get(id); const viewer = authenticatedUser(req);
      if (!profileAllowed(row,viewer) || !row.avatar || !existsSync(avatarPath(row.avatar))) return send(res,404,{error:'Image not found.'});
      const mime = row.avatar.endsWith('.png') ? 'image/png' : row.avatar.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      res.writeHead(200,{'Content-Type':mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}); createReadStream(avatarPath(row.avatar)).pipe(res); return;
    }
    if (path === '/api/profile/avatar' && (method === 'POST' || method === 'DELETE')) {
      const user = userOnly(req,res); if (!user) return;
      if(method==='POST'){const now=Date.now(),recent=(avatarRate.get(user.id)||[]).filter(time=>now-time<60*60_000);if(recent.length>=12){avatarRate.set(user.id,recent);return send(res,429,{error:'Profile photos can be changed up to 12 times per hour. Please try again later.'},{'Retry-After':'3600'});}recent.push(now);avatarRate.set(user.id,recent);}
      const old = db.prepare('SELECT avatar FROM users WHERE id=?').get(user.id)?.avatar;
      if (method === 'DELETE') {
        db.prepare('UPDATE users SET avatar=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(user.id);
        if (old && existsSync(avatarPath(old))) unlinkSync(avatarPath(old));
        return send(res,200,{ok:true,avatar:null});
      }
      const type = String(req.headers['content-type'] || '').split(';')[0].toLowerCase(); const spec = imageTypes[type];
      if (!spec) { for await (const _chunk of req) {} return send(res,415,{error:'Choose a JPG, PNG, or WEBP image.'}); }
      const image = await rawBody(req); const signature = spec[1];
      const valid = image.length >= 12 && image.subarray(0,signature.length).equals(signature) && (type !== 'image/webp' || image.subarray(8,12).toString() === 'WEBP') && (type !== 'image/jpeg' || image.subarray(image.length-2).equals(Buffer.from([0xff,0xd9])));
      if (!valid) return send(res,400,{error:'The selected file is not a valid image of that type.'});
      mkdirSync(avatarDir,{recursive:true}); const filename = `${randomUUID()}.${spec[0]}`; writeFileSync(avatarPath(filename),image,{flag:'wx'});
      db.prepare('UPDATE users SET avatar=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(filename,user.id);
      if (old && existsSync(avatarPath(old))) unlinkSync(avatarPath(old));
      return send(res,201,{avatar:`/api/profile/avatar/${encodeURIComponent(user.id)}`});
    }
    const publicProfilePath = path.match(/^\/api\/profile\/([^/]+)(?:\/(skills))?$/);
    if (method === 'GET' && publicProfilePath && publicProfilePath[1] !== 'me' && publicProfilePath[1] !== 'avatar') {
      const viewer = authenticatedUser(req); const id = decodeURIComponent(publicProfilePath[1]);
      const row = db.prepare('SELECT * FROM users WHERE id=? AND status=?').get(id,'active');
      if (!profileAllowed(row,viewer)) return send(res,404,{error:'Profile not found.'});
      const skills = userSkillSelect.all(id);
      if (publicProfilePath[2] === 'skills') return send(res,200,{items:skills.map(({id:_id,skillId,name,category,type,level})=>({skillId,name,category,type,level}))});
      const shared = { id:row.id, name:row.name, avatar:row.avatar?`/api/profile/avatar/${encodeURIComponent(id)}`:null, bio:row.bio, college:row.college, skills:skills.map(({id:_id,...item})=>item), learningGoals:row.learning_goals, completion:profileCompletion(id,row), verificationStatus:row.verification_status||'UNVERIFIED' };
      const ratingSummary=db.prepare("SELECT review_type AS reviewType,COUNT(*) AS total,COALESCE(AVG(rating),0) AS average FROM reviews WHERE reviewee_id=? GROUP BY review_type").all(id),teaching=ratingSummary.find(x=>x.reviewType==='TEACHING'),learning=ratingSummary.find(x=>x.reviewType==='LEARNING');
      shared.teachingRating=row.show_reviews?{averageRating:Number((teaching?.average||0).toFixed(2)),totalReviews:teaching?.total||0}:null;shared.learningRating=row.show_reviews?{averageRating:Number((learning?.average||0).toFixed(2)),totalReviews:learning?.total||0}:null;shared.showReviews=!!row.show_reviews;
      if (row.show_email&&row.profile_visibility!=='PRIVATE') shared.email = row.email;
      let directSkills = [], reverse = [];
      if (viewer && viewer.id !== id) {
        const own = userSkillSelect.all(viewer.id); const taught = new Set(skills.filter(s=>s.type==='TEACH').map(s=>s.skillId));
        directSkills = own.filter(s=>s.type==='LEARN'&&taught.has(s.skillId)).map(s=>s.name);
        const ownTaught = new Set(own.filter(s=>s.type==='TEACH').map(s=>s.skillId)); reverse = skills.filter(s=>s.type==='LEARN'&&ownTaught.has(s.skillId)).map(s=>s.name);
        shared.matchExplanation = directSkills.length || reverse.length ? { directSkills, mutual:!!(directSkills.length&&reverse.length) } : null;
      }
      return send(res,200,{profile:shared});
    }

    if (path === '/api/skills' || path === '/api/skills/user' || path.startsWith('/api/skills/user/')) {
      const user = userOnly(req, res);
      if (!user) return;

      if (method === 'GET' && path === '/api/skills/user') {
        return send(res, 200, { items: userSkillSelect.all(user.id) });
      }
      if (method === 'GET' && path === '/api/skills') {
        const search = String(url.searchParams.get('search') || '').trim().toLowerCase().slice(0, 80);
        const items = search
          ? db.prepare("SELECT id, name, category, description FROM skills WHERE is_active=1 AND lower(name) LIKE ? ORDER BY name COLLATE NOCASE LIMIT 40").all(`%${search}%`)
          : db.prepare('SELECT id, name, category, description FROM skills WHERE is_active=1 ORDER BY name COLLATE NOCASE LIMIT 40').all();
        return send(res, 200, { items });
      }
      if (method === 'POST' && path === '/api/skills/user') {
        const input = await bodyJson(req);
        const type = String(input.type || '').toUpperCase();
        const level = String(input.level || '').toUpperCase();
        if (!['TEACH', 'LEARN'].includes(type)) return send(res, 400, { error: 'Choose whether you want to teach or learn this skill.' });
        if (!['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'].includes(level)) return send(res, 400, { error: 'Choose a valid skill level.' });

        let skill = input.skillId ? db.prepare('SELECT id, name, category, description FROM skills WHERE id = ? AND is_active=1').get(String(input.skillId)) : null;
        if (!skill && !input.skillId && String(input.skillName || '').trim()) {
          const name = String(input.skillName).trim().slice(0, 80);
          const category = String(input.category || 'Other').trim().slice(0, 40) || 'Other';
          const existing = db.prepare('SELECT id FROM skills WHERE name = ? COLLATE NOCASE').get(name);
          const id = existing?.id || randomUUID();
          if (!existing) db.prepare('INSERT OR IGNORE INTO skills (id, name, category, description) VALUES (?, ?, ?, ?)').run(id, name, category, '');
          skill = db.prepare('SELECT id, name, category, description FROM skills WHERE name = ? COLLATE NOCASE AND is_active=1').get(name);
        }
        if (!skill) return send(res, 400, { error: 'Choose a listed skill or enter a skill name.' });
        const id = randomUUID();
        try { db.prepare('INSERT INTO user_skills (id, user_id, skill_id, type, level) VALUES (?, ?, ?, ?, ?)').run(id, user.id, skill.id, type, level); }
        catch (error) {
          if (String(error.message).includes('UNIQUE')) return send(res, 409, { error: 'That skill is already in this list.' });
          throw error;
        }
        return send(res, 201, { item: { ...skill, id, skillId: skill.id, type, level } });
      }
      const deleteSkill = path.match(/^\/api\/skills\/user\/([^/]+)$/);
      if (method === 'DELETE' && deleteSkill) {
        const id = decodeURIComponent(deleteSkill[1]);
        const result = db.prepare('DELETE FROM user_skills WHERE id = ? AND user_id = ?').run(id, user.id);
        if (!result.changes) return send(res, 404, { error: 'Skill not found in your profile.' });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Not found.' });
    }

    const skillDetailsPath=path.match(/^\/api\/skills\/([^/]+)$/);
    if(method==='GET'&&skillDetailsPath){const user=userOnly(req,res);if(!user)return;let skillId;try{skillId=decodeURIComponent(skillDetailsPath[1])}catch{return send(res,404,{error:'Skill not found.'})}const item=db.prepare(`SELECT id AS skillId,name,category,description,created_at AS createdAt,(SELECT COUNT(DISTINCT us.user_id) FROM user_skills us JOIN users u ON u.id=us.user_id WHERE us.skill_id=skills.id AND us.type='TEACH' AND u.status='active' AND coalesce(u.profile_visibility,'PUBLIC')!='PRIVATE') AS teacherCount,(SELECT COUNT(DISTINCT us.user_id) FROM user_skills us JOIN users u ON u.id=us.user_id WHERE us.skill_id=skills.id AND us.type='LEARN' AND u.status='active' AND coalesce(u.profile_visibility,'PUBLIC')!='PRIVATE') AS learnerCount,(SELECT group_concat(DISTINCT us.level) FROM user_skills us JOIN users u ON u.id=us.user_id WHERE us.skill_id=skills.id AND us.type='TEACH' AND u.status='active' AND coalesce(u.profile_visibility,'PUBLIC')!='PRIVATE') AS levels FROM skills WHERE id=? AND is_active=1`).get(skillId);if(!item)return send(res,404,{error:'Skill not found.'});return send(res,200,{item:{...item,levels:item.levels?item.levels.split(','):[]}})}

    if (path.startsWith('/api/recommendations')) {
      const user=userOnly(req,res);if(!user)return;
      if(user.role!=='user')return send(res,403,{error:'Recommendations are available in the member dashboard.'});
      if(path==='/api/recommendations/feedback'&&method==='POST'){
        const input=await bodyJson(req),result=recommendations.submitFeedback(user.id,{targetType:String(input.targetType||'').toUpperCase(),targetId:String(input.targetId||''),feedback:String(input.feedback||'').toUpperCase()});
        if(result.rateLimited)return send(res,429,{error:'Recommendations are temporarily unavailable. Please try again later.'},{'Retry-After':'60'});
        return result.error?send(res,400,{error:result.error}):send(res,200,result);
      }
      if(method!=='GET')return send(res,405,{error:'Method not allowed.'});
      const recommendationPath=path.slice('/api/recommendations/'.length);
      if(!['users','skills','learning-path'].includes(recommendationPath))return send(res,404,{error:'Not found.'});
      if(url.searchParams.has('limit')){const limit=Number(url.searchParams.get('limit'));if(!Number.isInteger(limit)||limit<1||limit>8)return send(res,400,{error:'Limit must be between 1 and 8.'});}
      const result=await (recommendationPath==='users'?recommendations.users(user.id):recommendationPath==='skills'?recommendations.skills(user.id):recommendations.learningPath(user.id));
      if(result.rateLimited)return send(res,429,{error:'Recommendations are temporarily unavailable. Please try again later.'},{'Retry-After':'60'});
      const limit=Number(url.searchParams.get('limit')||8);if(Array.isArray(result.items))result.items=result.items.slice(0,limit);
      return send(res,200,result);
    }

    if (path === '/api/matches' || path.startsWith('/api/matches/')) {
      const user = userOnly(req, res);
      if (!user) return;
      if (method === 'GET' && path === '/api/matches') {
        const result=findMatches(db,user.id,url.searchParams);
        for(const match of result.items.filter(item=>item.matchType==='MUTUAL'||item.label==='Strong Match')){
          createNotification({userId:user.id,type:'NEW_MATCH',title:'New Skill Match',message:`You have a new skill match with ${match.user.name}.`,relatedUserId:match.user.id,dedupeKey:`match:${user.id}:${match.user.id}`});
        }
        return send(res, 200, result);
      }
      const profileRoute = path.match(/^\/api\/matches\/([^/]+)$/);
      if (method === 'GET' && profileRoute) {
        const profile = getPublicProfile(db, decodeURIComponent(profileRoute[1]), user.id);
        if (!profile || profile.user.id === user.id) return send(res, 404, { error: 'Profile not found.' });
        return send(res, 200, profile);
      }
      return send(res, 404, { error: 'Not found.' });
    }

    if(path==='/api/discovery'&&method==='GET'){
      const user=userOnly(req,res);if(!user)return;const now=Date.now(),recent=(discoveryRate.get(user.id)||[]).filter(t=>now-t<60_000);if(recent.length>=90)return send(res,429,{error:'Searches are temporarily limited. Please wait a moment.'},{'Retry-After':'60'});recent.push(now);discoveryRate.set(user.id,recent);
      const rawQuery=String(url.searchParams.get('q')||'');if(rawQuery.length>80)return send(res,400,{error:'Search terms must be 80 characters or fewer.'});
      const type=String(url.searchParams.get('type')||'all').toLowerCase(),params=new URLSearchParams(url.searchParams);if(!['all','people','skills','suggestions'].includes(type))return send(res,400,{error:'Choose a valid discovery result type.'});
      if(type==='suggestions'){
        const query=rawQuery.trim().toLocaleLowerCase();if(query.length<2)return send(res,200,{success:true,skills:[],people:[]});const pattern=`%${query}%`;
        const suggestedSkills=db.prepare("SELECT id AS skillId,name,category FROM skills WHERE is_active=1 AND (lower(name) LIKE ? OR lower(category) LIKE ?) ORDER BY CASE WHEN lower(name)=? THEN 0 WHEN lower(name) LIKE ? THEN 1 ELSE 2 END,name COLLATE NOCASE LIMIT 5").all(pattern,pattern,query,`${query}%`);
        const suggestedPeople=db.prepare("SELECT id,name,location FROM users WHERE id!=? AND status='active' AND coalesce(profile_visibility,'PUBLIC')!='PRIVATE' AND lower(name) LIKE ? AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id=? AND b.blocked_user_id=users.id) OR (b.blocker_id=users.id AND b.blocked_user_id=?)) ORDER BY CASE WHEN lower(name)=? THEN 0 WHEN lower(name) LIKE ? THEN 1 ELSE 2 END,name COLLATE NOCASE LIMIT 5").all(user.id,pattern,user.id,user.id,query,`${query}%`);
        return send(res,200,{success:true,skills:suggestedSkills,people:suggestedPeople});
      }
      const peopleData=['all','people'].includes(type)?findDiscovery(db,user.id,params):null,people=peopleData?.people||null,skills=['all','skills'].includes(type)?findDiscoverySkills(db,user.id,params):null;
      const sort=String(url.searchParams.get('sort')||'relevance').toLowerCase();if(!['relevance','rating','newest','reviews'].includes(sort))return send(res,400,{error:'Choose a valid sort order.'});
      return send(res,200,{success:true,people,skills,filters:{query:rawQuery.trim(),category:url.searchParams.get('category')||'',level:url.searchParams.get('level')||'',intent:url.searchParams.get('intent')||'all',rating:url.searchParams.get('rating')||'',location:url.searchParams.get('location')||'',sort},categories:peopleData?.categories||skills?.categories||db.prepare('SELECT DISTINCT category FROM skills ORDER BY category COLLATE NOCASE').all().map(row=>row.category)});
    }

    const exchangePath=path.match(/^\/api\/swap-requests\/([^/]+)\/(status|accept|reject|start|complete|confirm-completion|cancel)$/);
    if(exchangePath&&((method==='PATCH'&&(exchangePath[2]!=='complete'&&exchangePath[2]!=='confirm-completion'))||(method==='POST'&&(exchangePath[2]==='complete'||exchangePath[2]==='confirm-completion')))){
      const user=userOnly(req,res);if(!user)return;let requestId;try{requestId=decodeURIComponent(exchangePath[1]);}catch{return send(res,404,{error:'Swap request not found.'});}
      const request=db.prepare("SELECT id,sender_id AS senderId,receiver_id AS receiverId,COALESCE(workflow_status,status) AS status,sender_completed_at AS senderCompletedAt,receiver_completed_at AS receiverCompletedAt,completed_at AS completedAt FROM swap_requests WHERE id=?").get(requestId);
      if(!request)return send(res,404,{error:'Swap request not found.'});
      const isSender=request.senderId===user.id,isReceiver=request.receiverId===user.id,peerId=isSender?request.receiverId:request.senderId;
      if(!isSender&&!isReceiver)return send(res,403,{error:'Only members of this exchange can update it.'});
      let action=exchangePath[2];if(action==='status'){const input=await bodyJson(req);action=String(input.status||'').toUpperCase()==='ACCEPTED'?'accept':String(input.status||'').toUpperCase()==='REJECTED'?'reject':'';}
      const now=new Date().toISOString();
      if(action==='accept'||action==='reject'){
        if(!isReceiver)return send(res,403,{error:'Only the recipient can respond to this request.'});if(request.status!=='PENDING')return send(res,409,{error:'This request has already been updated.'});
        const status=action==='accept'?'ACCEPTED':'REJECTED';const changed=db.prepare("UPDATE swap_requests SET status=?,workflow_status=?,accepted_at=CASE WHEN ?='ACCEPTED' THEN ? ELSE accepted_at END,updated_at=? WHERE id=? AND workflow_status='PENDING'").run(status,status,status,now,now,requestId);
        if(!changed.changes)return send(res,409,{error:'This request has already been updated.'});
        if(action==='accept'){const conversationId=exchangeConversation(request.senderId,request.receiverId);addSystemMessage(conversationId,user.id,'Your SkillSwap exchange has been accepted. Use this chat to coordinate your learning sessions.');createNotification({userId:request.senderId,type:'SWAP_ACCEPTED',title:'Swap Request Accepted',message:`${user.name} accepted your skill swap request. Open the exchange to get started.`,relatedUserId:user.id,relatedConversationId:conversationId,relatedSwapRequestId:requestId,dedupeKey:`swap-status:${requestId}:ACCEPTED`});}
        else createNotification({userId:request.senderId,type:'SWAP_REJECTED',title:'Swap Request Update',message:'Your skill swap request was declined.',relatedUserId:user.id,relatedSwapRequestId:requestId,dedupeKey:`swap-status:${requestId}:REJECTED`});
        return send(res,200,{ok:true,status});
      }
      if(action==='start'){
        if(request.status!=='ACCEPTED')return send(res,409,{error:'Only an accepted exchange can be started.'});
        const changed=db.prepare("UPDATE swap_requests SET workflow_status='IN_PROGRESS',started_at=?,updated_at=? WHERE id=? AND workflow_status='ACCEPTED'").run(now,now,requestId);if(!changed.changes)return send(res,409,{error:'This exchange has already been started.'});
        const conversationId=exchangeConversation(request.senderId,request.receiverId);addSystemMessage(conversationId,user.id,'Your SkillSwap exchange has started. You can confirm completion when you have both finished.');
        createNotification({userId:peerId,type:'SYSTEM',title:'Exchange Started',message:`${user.name} started your skill exchange.`,relatedUserId:user.id,relatedConversationId:conversationId,relatedSwapRequestId:requestId,dedupeKey:`swap-started:${requestId}`});return send(res,200,{ok:true,status:'IN_PROGRESS',conversationId});
      }
      if(action==='cancel'){
        if(request.status==='COMPLETED'||request.status==='CANCELLED'||request.status==='REJECTED')return send(res,409,{error:'This exchange can no longer be cancelled.'});
        if(request.status==='PENDING'&&!isSender)return send(res,403,{error:'Only the sender can cancel a pending request.'});
        const changed=db.prepare("UPDATE swap_requests SET status='CANCELLED',workflow_status='CANCELLED',cancelled_at=?,updated_at=? WHERE id=? AND workflow_status IN ('PENDING','ACCEPTED','IN_PROGRESS')").run(now,now,requestId);if(!changed.changes)return send(res,409,{error:'This exchange has already changed.'});
        db.prepare("UPDATE skill_sessions SET status='CANCELLED',updated_at=? WHERE swap_request_id=? AND status IN ('PROPOSED','CONFIRMED')").run(now,requestId);
        createNotification({userId:peerId,type:'SYSTEM',title:'Exchange Cancelled',message:`${user.name} cancelled the skill exchange.`,relatedUserId:user.id,relatedSwapRequestId:requestId,dedupeKey:`swap-cancelled:${requestId}`});return send(res,200,{ok:true,status:'CANCELLED'});
      }
      if(request.status!=='IN_PROGRESS')return send(res,409,{error:'Only an in-progress exchange can be marked complete.'});
      if(request.completedAt)return send(res,200,{ok:true,completed:true,status:'COMPLETED'});
      const ownColumn=isSender?'sender_completed_at':'receiver_completed_at',peerColumn=isSender?'receiver_completed_at':'sender_completed_at';
      const changed=db.prepare(`UPDATE swap_requests SET ${ownColumn}=COALESCE(${ownColumn},?),updated_at=? WHERE id=? AND workflow_status='IN_PROGRESS'`).run(now,now,requestId);if(!changed.changes)return send(res,409,{error:'This exchange is no longer in progress.'});
      const confirmed=db.prepare('SELECT sender_completed_at AS senderCompletedAt,receiver_completed_at AS receiverCompletedAt,completed_at AS completedAt FROM swap_requests WHERE id=?').get(requestId);
      if(confirmed.completedAt)return send(res,200,{ok:true,completed:true,status:'COMPLETED'});
      if(confirmed[isSender?'receiverCompletedAt':'senderCompletedAt']){
        db.prepare("UPDATE swap_requests SET status='ACCEPTED',workflow_status='COMPLETED',completed_at=?,updated_at=? WHERE id=? AND workflow_status='IN_PROGRESS' AND completed_at IS NULL").run(now,now,requestId);
        for(const recipient of [request.senderId,request.receiverId])createNotification({userId:recipient,type:'SYSTEM',title:'Exchange Completed',message:'Both members confirmed this skill exchange is complete. You can now leave a review.',relatedUserId:recipient===user.id?peerId:user.id,relatedSwapRequestId:requestId,dedupeKey:`swap-completed:${requestId}:${recipient}`});
        return send(res,200,{ok:true,completed:true,status:'COMPLETED',confirmedByYou:true});
      }
      createNotification({userId:peerId,type:'SYSTEM',title:'Completion Confirmation Needed',message:`${user.name} confirmed their exchange is complete. Please confirm when you are finished too.`,relatedUserId:user.id,relatedSwapRequestId:requestId,dedupeKey:`swap-completion-confirmation:${requestId}:${user.id}`});
      return send(res,200,{ok:true,completed:false,status:'IN_PROGRESS',confirmedByYou:true});
    }

    if (path === '/api/swap-requests') {
      const user = userOnly(req, res);
      if (!user) return;
      if (method === 'GET') {
        const items = db.prepare(`
          SELECT sr.id, sr.sender_id AS senderId, sender.name AS senderName,
            sr.receiver_id AS receiverId, receiver.name AS receiverName,
            sr.skill_offered_id AS skillOfferedId, offered.name AS skillOffered,
            sr.skill_wanted_id AS skillWantedId, wanted.name AS skillWanted,
            CASE WHEN sr.sender_id = ? THEN 'SENT' ELSE 'RECEIVED' END AS direction,
            COALESCE(sr.workflow_status,sr.status) AS status, sr.message, sr.sender_completed_at AS senderCompletedAt,sr.receiver_completed_at AS receiverCompletedAt,sr.completed_at AS completedAt,
            sr.accepted_at AS acceptedAt,sr.started_at AS startedAt,sr.cancelled_at AS cancelledAt,
            (SELECT c.id FROM conversations c WHERE c.user_one_id=CASE WHEN sr.sender_id<sr.receiver_id THEN sr.sender_id ELSE sr.receiver_id END AND c.user_two_id=CASE WHEN sr.sender_id<sr.receiver_id THEN sr.receiver_id ELSE sr.sender_id END) AS conversationId,
            (SELECT id FROM reviews WHERE swap_request_id=sr.id AND reviewer_id=? AND review_type='TEACHING') AS myTeachingReviewId,
            (SELECT id FROM reviews WHERE swap_request_id=sr.id AND reviewer_id=? AND review_type='LEARNING') AS myLearningReviewId,
            (SELECT rating FROM reviews WHERE swap_request_id=sr.id AND reviewer_id=? AND review_type='LEARNING') AS myLearningReviewRating,
            (SELECT comment FROM reviews WHERE swap_request_id=sr.id AND reviewer_id=? AND review_type='LEARNING') AS myLearningReviewComment,
            (SELECT rating FROM reviews WHERE swap_request_id=sr.id AND reviewer_id=? AND review_type='TEACHING') AS myReviewRating,
            (SELECT comment FROM reviews WHERE swap_request_id=sr.id AND reviewer_id=? AND review_type='TEACHING') AS myReviewComment,
            sr.created_at AS createdAt, sr.updated_at AS updatedAt
          FROM swap_requests sr JOIN users sender ON sender.id=sr.sender_id
          JOIN users receiver ON receiver.id=sr.receiver_id
          JOIN skills offered ON offered.id=sr.skill_offered_id
          JOIN skills wanted ON wanted.id=sr.skill_wanted_id
          WHERE sr.sender_id = ? OR sr.receiver_id = ?
          ORDER BY sr.created_at DESC LIMIT 100
        `).all(user.id,user.id,user.id,user.id,user.id,user.id,user.id,user.id,user.id);
        return send(res, 200, { items });
      }
      if (method === 'POST') {
        const input = await bodyJson(req);
        const stamp=Date.now(),recent=(swapRequestRate.get(user.id)||[]).filter(t=>stamp-t<60*60_000);if(recent.length>=10){swapRequestRate.set(user.id,recent);return send(res,429,{error:'You have sent several exchange requests recently. Please try again later.'},{'Retry-After':'3600'});} 
        const receiverId = String(input.receiverId || '');
        const skillOfferedId = String(input.skillOfferedId || '');
        const skillWantedId = String(input.skillWantedId || '');
        const message = String(input.message || '').trim();
        if (message.length > 500) return send(res, 400, { error: 'Keep your note under 500 characters.' });
        if (!receiverId || receiverId === user.id || !skillOfferedId || !skillWantedId) return send(res, 400, { error: 'Select a member and both skills for the swap.' });
        const ownsOffer = db.prepare("SELECT 1 FROM user_skills us JOIN skills s ON s.id=us.skill_id AND s.is_active=1 WHERE us.user_id = ? AND us.skill_id = ? AND us.type = 'TEACH'").get(user.id, skillOfferedId);
        const wantsSkill = db.prepare("SELECT 1 FROM user_skills us JOIN skills s ON s.id=us.skill_id AND s.is_active=1 WHERE us.user_id = ? AND us.skill_id = ? AND us.type = 'LEARN'").get(user.id, skillWantedId);
        const canTeachWanted = db.prepare("SELECT 1 FROM user_skills us JOIN skills s ON s.id=us.skill_id AND s.is_active=1 WHERE us.user_id = ? AND us.skill_id = ? AND us.type = 'TEACH'").get(receiverId, skillWantedId);
        const receiver = db.prepare("SELECT id,allow_swap_requests AS allowSwapRequests FROM users WHERE id = ? AND status = 'active'").get(receiverId);
        if(receiver&&usersBlocked(user.id,receiverId))return send(res,403,{error:"You can't interact with this user because one of you has blocked the other."});if(receiver&&!receiver.allowSwapRequests)return send(res,403,{error:'This member is not accepting exchange requests.'});
        if (!receiver || !ownsOffer || !wantsSkill || !canTeachWanted) return send(res, 400, { error: 'This swap must use a skill you teach and want, and one the other member teaches.' });
        const duplicate = db.prepare(`
          SELECT id FROM swap_requests WHERE COALESCE(workflow_status,status) IN ('PENDING','ACCEPTED','IN_PROGRESS') AND (
            (sender_id = ? AND receiver_id = ? AND skill_offered_id = ? AND skill_wanted_id = ?)
            OR (sender_id = ? AND receiver_id = ? AND skill_offered_id = ? AND skill_wanted_id = ?)
          )
        `).get(user.id, receiverId, skillOfferedId, skillWantedId, receiverId, user.id, skillWantedId, skillOfferedId);
        if (duplicate) return send(res, 409, { error: 'A pending request already exists for these skills.' });
        recent.push(stamp);swapRequestRate.set(user.id,recent);
        const id = randomUUID();
        try {
          db.prepare(`INSERT INTO swap_requests
            (id, sender_id, receiver_id, skill_offered_id, skill_wanted_id, message,workflow_status)
            VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`).run(id, user.id, receiverId, skillOfferedId, skillWantedId, message);
        } catch (error) {
          if (String(error.message).includes('UNIQUE')) return send(res, 409, { error: 'A pending request already exists for these skills.' });
          throw error;
        }
        const wantedName=db.prepare('SELECT name FROM skills WHERE id=?').get(skillWantedId)?.name||'a skill',offeredName=db.prepare('SELECT name FROM skills WHERE id=?').get(skillOfferedId)?.name||'a skill';
        createNotification({userId:receiverId,type:'SWAP_REQUEST',title:'New Swap Request',message:`${user.name} wants to learn ${wantedName} and can teach you ${offeredName}.`,relatedUserId:user.id,relatedSwapRequestId:id,relatedSkillId:skillWantedId,dedupeKey:`swap-request:${id}`});
        const item = db.prepare(`SELECT id, sender_id AS senderId, receiver_id AS receiverId,
          skill_offered_id AS skillOfferedId, skill_wanted_id AS skillWantedId, workflow_status AS status, message,
          created_at AS createdAt, updated_at AS updatedAt FROM swap_requests WHERE id = ?`).get(id);
        return send(res, 201, { item });
      }
      return send(res, 405, { error: 'Method not allowed.' });
    }

    const swapDetailPath=path.match(/^\/api\/swap-requests\/([^/]+)$/);
    if(method==='GET'&&swapDetailPath){const user=userOnly(req,res);if(!user)return;let id;try{id=decodeURIComponent(swapDetailPath[1]);}catch{return send(res,404,{error:'Swap request not found.'});}const item=db.prepare(`SELECT sr.id,sr.sender_id AS senderId,sender.name AS senderName,sr.receiver_id AS receiverId,receiver.name AS receiverName,sr.skill_offered_id AS skillOfferedId,offered.name AS skillOffered,sr.skill_wanted_id AS skillWantedId,wanted.name AS skillWanted,CASE WHEN sr.sender_id=? THEN 'SENT' ELSE 'RECEIVED' END AS direction,COALESCE(sr.workflow_status,sr.status) AS status,sr.message,sr.sender_completed_at AS senderCompletedAt,sr.receiver_completed_at AS receiverCompletedAt,sr.completed_at AS completedAt,sr.accepted_at AS acceptedAt,sr.started_at AS startedAt,sr.cancelled_at AS cancelledAt,(SELECT c.id FROM conversations c WHERE c.user_one_id=CASE WHEN sr.sender_id<sr.receiver_id THEN sr.sender_id ELSE sr.receiver_id END AND c.user_two_id=CASE WHEN sr.sender_id<sr.receiver_id THEN sr.receiver_id ELSE sr.sender_id END) AS conversationId,(SELECT id FROM reviews WHERE swap_request_id=sr.id AND reviewer_id=? AND review_type='TEACHING') AS myTeachingReviewId,(SELECT id FROM reviews WHERE swap_request_id=sr.id AND reviewer_id=? AND review_type='LEARNING') AS myLearningReviewId,(SELECT rating FROM reviews WHERE swap_request_id=sr.id AND reviewer_id=? AND review_type='TEACHING') AS myReviewRating,(SELECT comment FROM reviews WHERE swap_request_id=sr.id AND reviewer_id=? AND review_type='TEACHING') AS myReviewComment,(SELECT rating FROM reviews WHERE swap_request_id=sr.id AND reviewer_id=? AND review_type='LEARNING') AS myLearningReviewRating,(SELECT comment FROM reviews WHERE swap_request_id=sr.id AND reviewer_id=? AND review_type='LEARNING') AS myLearningReviewComment,sr.created_at AS createdAt,sr.updated_at AS updatedAt FROM swap_requests sr JOIN users sender ON sender.id=sr.sender_id JOIN users receiver ON receiver.id=sr.receiver_id JOIN skills offered ON offered.id=sr.skill_offered_id JOIN skills wanted ON wanted.id=sr.skill_wanted_id WHERE sr.id=? AND (sr.sender_id=? OR sr.receiver_id=?)`).get(user.id,user.id,user.id,user.id,user.id,user.id,user.id,id,user.id,user.id);if(!item)return send(res,404,{error:'Swap request not found.'});return send(res,200,{item});}

    if (method === 'POST' && path === '/api/auth/register') {
      const input = await bodyJson(req);
      const name = String(input.name || '').trim();
      const email = String(input.email || '').trim().toLowerCase();
      const password = String(input.password || '');
      const bio = String(input.bio || '').trim().slice(0, 280);
      const avatar = String(input.avatar || '').trim().slice(0, 500);
      if (name.length < 2 || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || Buffer.byteLength(password) < 12) {
        return send(res, 400, { error: 'Enter a valid name, email, and password of at least 12 characters.' });
      }
      const salt = randomBytes(16);
      const passwordHash = `scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
      const id = randomUUID();
      try { db.prepare("INSERT INTO users (id,name,email,password_hash,bio,avatar) VALUES (?,?,?,?,?,?)").run(id, name, email, passwordHash, bio, avatar); }
      catch { return send(res, 409, { error: 'An account already uses that email.' }); }
      const sessionCookie = startSession(id, res, req);
      return send(res, 201, { user: userById.get(id) }, { 'Set-Cookie': sessionCookie });
    }
    return send(res, 404, { error: 'Not found.' });
  } catch (error) {
    if(res.headersSent){res.destroy();logEvent('error','http.request.failed',{requestId,method:req.method,errorType:error?.name||'Error'});return;}
    const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<500?error.status:500;
    if(status===500)logEvent('error','http.request.failed',{requestId,method:req.method,errorType:error?.name||'Error'});
    return send(res,status,{error:status<500?error.message:'An unexpected server error occurred.'});
  }
});

const apiPort = Number(process.env.PORT || process.env.API_PORT || 3001);
const apiHost = process.env.API_HOST || '0.0.0.0';
if(!Number.isInteger(apiPort)||apiPort<1||apiPort>65535)throw new Error('API_PORT must be an integer between 1 and 65535.');
server.listen(apiPort,apiHost,()=>logEvent('info','server.listening',{host:apiHost,port:apiPort,nodeEnv:process.env.NODE_ENV||'development'}));
const reminderTimer=setInterval(()=>{try{createDueSessionReminders();subscriptionService.expireDue();subscriptionService.notifyExpiringSoon()}catch(error){logEvent('error','subscription.maintenance.failed',{errorType:error?.name||'Error'})}},60_000);
try{createDueSessionReminders()}catch(error){logEvent('error','session.reminder.failed',{errorType:error?.name||'Error'})}
try{subscriptionService.expireDue();subscriptionService.notifyExpiringSoon()}catch(error){logEvent('error','subscription.maintenance.failed',{errorType:error?.name||'Error'})}
let shuttingDown=false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if(shuttingDown)return;shuttingDown=true;clearInterval(reminderTimer);
  for(const [key,timer] of typingTimers){clearTimeout(timer);typingTimers.delete(key);}
  for(const userId of [...realtimeStreams.keys()])closeRealtimeForUser(userId);
  const forceTimer=setTimeout(()=>{logEvent('error','server.shutdown.timeout');try{db.close()}catch{}process.exit(1)},10_000);
  server.close(error=>{clearTimeout(forceTimer);try{db.close();logEvent('info','server.shutdown.complete',{signal});}catch{process.exitCode=1}if(error)process.exitCode=1;});
});
