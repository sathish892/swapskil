import { createHash, randomUUID } from 'node:crypto';
import { findMatches, findDiscovery } from '../../matching.mjs';

const LIMIT = 8;
const MINUTE = 60_000;
const hash = value => createHash('sha256').update(value).digest('hex');
export function catalogGoalContext(value,catalog){const text=String(value||'').toLowerCase();return [...new Set(catalog.flatMap(skill=>[skill.name,skill.category]).filter(label=>label&&label.length>=3&&text.includes(label.toLowerCase())))].slice(0,12).join(', ').slice(0,240);}
const dayIds={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
function localDateParts(date,timeZone){const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);return Object.fromEntries(parts.map(part=>[part.type,part.value]));}
function localTimeToUtc(date,time,timeZone){
  const [year,month,day]=date.split('-').map(Number),[hour,minute]=time.split(':').map(Number),target=Date.UTC(year,month-1,day,hour,minute);let guess=target;
  try{for(let i=0;i<4;i++){const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess));const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));guess+=target-Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute));}const check=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess)).map(x=>[x.type,x.value]));return `${check.year}-${check.month}-${check.day}`===date&&`${check.hour}:${check.minute}`===time?guess:null;}catch{return null;}
}
function weeklyIntervals(slots,now){
  if(!slots.length)return[];const zone=slots[0].timezone||'UTC',base=localDateParts(new Date(now),zone),start=Date.UTC(Number(base.year),Number(base.month)-1,Number(base.day)),intervals=[];
  for(let offset=0;offset<21;offset++){const date=new Date(start+offset*86400_000),iso=date.toISOString().slice(0,10),weekday=date.getUTCDay();for(const slot of slots.filter(item=>item.dayOfWeek===weekday)){const from=localTimeToUtc(iso,slot.startTime,zone),to=localTimeToUtc(iso,slot.endTime,zone);if(from!==null&&to!==null&&to>from)intervals.push([from,to]);}}
  return intervals;
}
function availabilityMatch(db,userId,peerId,now){
  const rows=db.prepare(`SELECT u.id,u.show_availability AS showAvailability,coalesce(a.visibility,'MATCHES') AS visibility,coalesce(a.timezone,'UTC') AS timezone
    FROM users u LEFT JOIN availability_settings a ON a.user_id=u.id WHERE u.id IN (?,?)`).all(userId,peerId);
  if(rows.length!==2||rows.some(row=>!row.showAvailability||row.visibility==='PARTNERS'&&!db.prepare("SELECT id FROM swap_requests WHERE ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?)) AND COALESCE(workflow_status,status) IN ('ACCEPTED','IN_PROGRESS','COMPLETED') LIMIT 1").get(userId,peerId,peerId,userId)||!['MATCHES','PUBLIC','PARTNERS'].includes(row.visibility)))return null;
  const slotsFor=id=>db.prepare('SELECT day_of_week AS dayOfWeek,start_time AS startTime,end_time AS endTime,timezone FROM availability_slots WHERE user_id=? AND is_active=1').all(id).map(slot=>({...slot,timezone:slot.timezone||rows.find(row=>row.id===id)?.timezone||'UTC'}));
  const a=weeklyIntervals(slotsFor(userId),now),b=weeklyIntervals(slotsFor(peerId),now);
  return a.some(left=>b.some(right=>Math.min(left[1],right[1])-Math.max(left[0],right[0],now)>=15*60_000));
}

/** Optional OpenAI-compatible provider. Only sanitized goals and public skill names/categories are sent. */
export async function requestSemanticSkillOrder({ skills, goals, fetchImpl = fetch, env = process.env }) {
  const apiKey = env.AI_API_KEY;
  const provider = String(env.AI_PROVIDER || '').toLowerCase();
  if (!apiKey || !['openai', 'openai-compatible'].includes(provider)) return null;
  const model = String(env.AI_MODEL || 'gpt-4o-mini').slice(0, 80);
  const endpointUrl = new URL(String(env.AI_BASE_URL || 'https://api.openai.com/v1/chat/completions'));
  if (endpointUrl.protocol !== 'https:' || endpointUrl.username || endpointUrl.password) throw new Error('AI endpoint must use HTTPS and must not embed credentials.');
  const endpoint = endpointUrl.toString().replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 180,
        messages: [
          { role: 'system', content: 'Rank the provided skill IDs by relevance to the learning goal. Return only JSON: {"skillIds":[...]} using only provided IDs. Do not infer personal attributes.' },
          { role: 'user', content: JSON.stringify({ goals: String(goals || '').slice(0, 240), skills: skills.slice(0, 30).map(({ skillId, name, category }) => ({ skillId, name: String(name).slice(0, 80), category: String(category || '').slice(0, 60) })) }) },
        ] }),
    });
    if (!response.ok) throw new Error(`provider status ${response.status}`);
    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content;
    const parsed = JSON.parse(String(content || ''));
    if (!Array.isArray(parsed.skillIds) || parsed.skillIds.length > LIMIT) throw new Error('invalid provider shape');
    const allowed = new Set(skills.map(skill => skill.skillId));
    const ids = parsed.skillIds.filter(id => typeof id === 'string' && allowed.has(id));
    if (ids.length !== parsed.skillIds.length || new Set(ids).size !== ids.length) throw new Error('invalid provider identifiers');
    return ids;
  } finally { clearTimeout(timer); }
}

export function createRecommendationService({ db, aiProvider = requestSemanticSkillOrder, env = process.env, now = () => Date.now() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS recommendation_cache (
    cache_key TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payload TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_recommendation_cache_expiry ON recommendation_cache(expires_at);
  CREATE TABLE IF NOT EXISTS recommendation_feedback (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK(target_type IN ('USER','SKILL')),
    target_id TEXT NOT NULL, feedback TEXT NOT NULL CHECK(feedback IN ('INTERESTED','NOT_INTERESTED')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id,target_type,target_id)
  );
  CREATE TABLE IF NOT EXISTS recommendation_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL CHECK(event IN ('request','failure','fallback','cache')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_recommendation_health_created ON recommendation_health(created_at);`);
  const cacheMinutes = Math.max(1, Math.min(1440, Number(env.RECOMMENDATION_CACHE_MINUTES) || 30));
  const weight=(key,fallback,min=0,max=100)=>{const value=Number(env[key]);return Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;};
  const weights={match:weight('RECOMMENDATION_MATCH_WEIGHT',0.65,0,1),direct:weight('RECOMMENDATION_DIRECT_BONUS',20),mutual:weight('RECOMMENDATION_MUTUAL_BONUS',15),other:weight('RECOMMENDATION_OTHER_BONUS',10),rating:weight('RECOMMENDATION_RATING_BONUS',5),availability:weight('RECOMMENDATION_AVAILABILITY_BONUS',5),goal:weight('RECOMMENDATION_GOAL_WEIGHT',12),category:weight('RECOMMENDATION_CATEGORY_WEIGHT',5),history:weight('RECOMMENDATION_HISTORY_WEIGHT',4),teachers:weight('RECOMMENDATION_TEACHER_WEIGHT',1),peerSuccess:weight('RECOMMENDATION_SUCCESSFUL_PEER_BONUS',5),pendingPenalty:weight('RECOMMENDATION_PENDING_INTERACTION_PENALTY',10),aiMax:weight('RECOMMENDATION_AI_MAX_BONUS',12)};
  const rateLimit = new Map();
  const aiRateLimit = new Map();
  let healthWrites=0;
  const log = event => {db.prepare('INSERT INTO recommendation_health(event) VALUES(?)').run(event);if(++healthWrites%100===0)db.prepare("DELETE FROM recommendation_health WHERE created_at<datetime('now','-90 days')").run();};
  const metrics = () => Object.fromEntries(['request', 'failure', 'fallback', 'cache'].map(event => [
    event === 'request' ? 'aiRecommendationRequests' : event === 'failure' ? 'aiRecommendationFailures' : event === 'fallback' ? 'recommendationFallbacks' : 'recommendationCacheHits',
    Number(db.prepare("SELECT COUNT(*) n FROM recommendation_health WHERE event=? AND created_at>=datetime('now','-30 days')").get(event).n),
  ]));
  const feedbackMap = userId => new Map(db.prepare('SELECT target_type AS type,target_id AS targetId,feedback FROM recommendation_feedback WHERE user_id=?').all(userId).map(row => [`${row.type}:${row.targetId}`, row.feedback]));
  function checkRate(userId) {
    const times = (rateLimit.get(userId) || []).filter(time => now() - time < MINUTE);
    if (times.length >= 30) { rateLimit.set(userId, times); return false; }
    times.push(now()); rateLimit.set(userId, times); return true;
  }
  function checkAiRate(userId) {
    const times=(aiRateLimit.get(userId)||[]).filter(time=>now()-time<60*MINUTE);
    if(times.length>=5){aiRateLimit.set(userId,times);return false;}
    times.push(now());aiRateLimit.set(userId,times);return true;
  }
  function cached(userId, kind, inputHash, skipRate=false) {
    if (!skipRate&&!checkRate(userId)) return { limited: true };
    const cacheKey = hash(`${userId}:${kind}:${inputHash}`);
    const row = db.prepare('SELECT payload FROM recommendation_cache WHERE cache_key=? AND expires_at>?').get(cacheKey, now());
    if (row) { log('cache'); return { payload: JSON.parse(row.payload), cacheKey }; }
    return { cacheKey };
  }
  function save(userId, cacheKey, payload) {
    db.prepare('INSERT OR REPLACE INTO recommendation_cache(cache_key,user_id,payload,expires_at) VALUES(?,?,?,?)').run(cacheKey, userId, JSON.stringify(payload), now() + cacheMinutes * MINUTE);
    db.prepare("DELETE FROM recommendation_cache WHERE expires_at<=?").run(now());
  }
  function profileSnapshot(userId) {
    const user = db.prepare("SELECT learning_goals AS goals FROM users WHERE id=? AND status='active'").get(userId);
    if (!user) return null;
    const skills = db.prepare(`SELECT us.skill_id AS skillId,s.name,s.category,us.type,us.level FROM user_skills us JOIN skills s ON s.id=us.skill_id AND s.is_active=1 WHERE us.user_id=? ORDER BY us.type,s.name`).all(userId);
    const completed=db.prepare("SELECT off.category AS offeredCategory,want.category AS wantedCategory FROM swap_requests sr JOIN skills off ON off.id=sr.skill_offered_id JOIN skills want ON want.id=sr.skill_wanted_id WHERE COALESCE(sr.workflow_status,sr.status)='COMPLETED' AND (sr.sender_id=? OR sr.receiver_id=?)").all(userId,userId);
    const successfulSwaps=completed.length,successfulCategories=[...new Set(completed.flatMap(item=>[item.offeredCategory,item.wantedCategory]).filter(Boolean))];
    const availability=db.prepare(`SELECT u.show_availability AS visible,coalesce(a.visibility,'MATCHES') AS visibility,coalesce(a.timezone,'UTC') AS timezone,
      (SELECT COUNT(*) FROM availability_slots x WHERE x.user_id=u.id AND x.is_active=1) AS slots
      FROM users u LEFT JOIN availability_settings a ON a.user_id=u.id WHERE u.id=?`).get(userId);
    const signature = hash(JSON.stringify({ goals:user.goals, skills, successfulSwaps, successfulCategories, availability }));
    return { goals:user.goals || '', skills, successfulSwaps, successfulCategories, availability, signature };
  }
  function currentUserRecommendations(userId,payload){
    const ids=payload.items.map(item=>item.user.id);if(!ids.length)return payload;
    const allowed=new Set(db.prepare(`SELECT u.id FROM users u WHERE u.id IN (${ids.map(()=>'?').join(',')}) AND u.status='active' AND coalesce(u.profile_visibility,'PUBLIC')!='PRIVATE'
      AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=? AND b.blocked_user_id=u.id) OR (b.blocker_id=u.id AND b.blocked_user_id=?))`).all(...ids,userId,userId).map(row=>row.id));
    const feedback=feedbackMap(userId);
    const stillMatches=db.prepare(`SELECT 1 FROM skills s WHERE s.id=? AND s.is_active=1 AND (EXISTS(SELECT 1 FROM user_skills mine JOIN user_skills peer ON peer.skill_id=mine.skill_id AND peer.user_id=? AND peer.type='TEACH' WHERE mine.user_id=? AND mine.type='LEARN' AND mine.skill_id=s.id) OR EXISTS(SELECT 1 FROM user_skills mine JOIN user_skills peer ON peer.skill_id=mine.skill_id AND peer.user_id=? AND peer.type='LEARN' WHERE mine.user_id=? AND mine.type='TEACH' AND mine.skill_id=s.id))`);
    return {...payload,items:payload.items.filter(item=>allowed.has(item.user.id)&&feedback.get(`USER:${item.user.id}`)!=='NOT_INTERESTED'&&item.relevantSkill&&stillMatches.get(item.relevantSkill.skillId,item.user.id,userId,item.user.id,userId)).map(item=>{const compatible=availabilityMatch(db,userId,item.user.id,now()),reasons=item.reasons.filter(reason=>reason!=='Your listed weekly availability overlaps.');if(compatible)reasons.push('Your listed weekly availability overlaps.');return {...item,availabilityCompatibility:compatible,reasons};})};
  }
  function currentSkillRecommendations(userId,payload){
    const feedback=feedbackMap(userId),counts=new Map(eligibleSkills(userId).map(skill=>[skill.skillId,skill.teachers]));
    return {...payload,items:payload.items.filter(item=>counts.has(item.skillId)&&feedback.get(`SKILL:${item.skillId}`)!=='NOT_INTERESTED').map(item=>({...item,teachers:counts.get(item.skillId),reason:item.teachers!==counts.get(item.skillId)&&!item.reason.toLowerCase().includes('goal')&&!item.reason.toLowerCase().includes('category')?'This skill remains in the active SkillSwap catalog.':item.reason}))};
  }
  function eligibleSkills(userId) {
    return db.prepare(`SELECT s.id AS skillId,s.name,s.category,s.description,
      (SELECT COUNT(DISTINCT us.user_id) FROM user_skills us JOIN users u ON u.id=us.user_id WHERE us.skill_id=s.id AND us.type='TEACH' AND us.user_id!=? AND u.status='active' AND coalesce(u.profile_visibility,'PUBLIC')!='PRIVATE' AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=? AND b.blocked_user_id=u.id) OR (b.blocker_id=u.id AND b.blocked_user_id=?))) AS teachers,
      (SELECT COUNT(DISTINCT us.user_id) FROM user_skills us JOIN users u ON u.id=us.user_id WHERE us.skill_id=s.id AND us.type='LEARN' AND us.user_id!=? AND u.status='active' AND coalesce(u.profile_visibility,'PUBLIC')!='PRIVATE' AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=? AND b.blocked_user_id=u.id) OR (b.blocker_id=u.id AND b.blocked_user_id=?))) AS learners,
      (SELECT group_concat(DISTINCT us.level) FROM user_skills us JOIN users u ON u.id=us.user_id WHERE us.skill_id=s.id AND us.type='TEACH' AND us.user_id!=? AND u.status='active' AND coalesce(u.profile_visibility,'PUBLIC')!='PRIVATE' AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=? AND b.blocked_user_id=u.id) OR (b.blocker_id=u.id AND b.blocked_user_id=?))) AS levels
      FROM skills s WHERE s.is_active=1 ORDER BY s.name COLLATE NOCASE`).all(userId,userId,userId,userId,userId,userId,userId,userId,userId).map(skill=>({...skill,levels:skill.levels?skill.levels.split(','):[]}));
  }
  async function users(userId) {
    const snap = profileSnapshot(userId); if (!snap) return { items:[], source:'deterministic' };
    const state = cached(userId, 'users', snap.signature); if (state.limited) return { items:[], source:'deterministic', rateLimited:true };
    if (state.payload) return currentUserRecommendations(userId,state.payload);
    const feedback = feedbackMap(userId);
    const teachMatches=findMatches(db,userId,new URLSearchParams({page:'1',pageSize:'24'})).items;
    const learnMatches=findDiscovery(db,userId,new URLSearchParams({intent:'learn',limit:'20'})).people.results;
    const candidates=[...new Map([...teachMatches,...learnMatches].map(item=>[item.user.id,item])).values()];
    const interactions=new Map(db.prepare(`SELECT CASE WHEN sender_id=? THEN receiver_id ELSE sender_id END AS peerId,
      SUM(CASE WHEN COALESCE(workflow_status,status)='COMPLETED' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN COALESCE(workflow_status,status) IN ('PENDING','ACCEPTED','IN_PROGRESS') THEN 1 ELSE 0 END) AS active
      FROM swap_requests WHERE sender_id=? OR receiver_id=? GROUP BY peerId`).all(userId,userId,userId).map(row=>[row.peerId,row]));
    const items = candidates.filter(item => feedback.get(`USER:${item.user.id}`) !== 'NOT_INTERESTED').map((match) => {
      const direct = match.directSkills[0];
      const mutual = match.mutualSkills.length > 0;
      const relevantSkill = direct || match.mutualSkills[0] || match.teaches[0] || null;
      const reasons = [];
      if (direct) reasons.push(`You want to learn ${direct.name}, and this person teaches it.`);
      else if(mutual) reasons.push(`You teach ${match.mutualSkills[0].name}, and this person wants to learn it.`);
      if (direct&&mutual) reasons.push('You have skills each other wants to learn.');
      if (snap.goals && relevantSkill && snap.goals.toLowerCase().includes(relevantSkill.name.toLowerCase())) reasons.push(`Your learning goal mentions ${relevantSkill.name}.`);
      if (match.user.ratingSummary?.totalReviews) reasons.push(`Visible reviews average ${match.user.ratingSummary.averageRating.toFixed(1)} from ${match.user.ratingSummary.totalReviews} review${match.user.ratingSummary.totalReviews===1?'':'s'}.`);
      if (match.user.verificationStatus === 'VERIFIED') reasons.push('This profile is verified.');
      const prior=interactions.get(match.user.id);if(prior?.completed)reasons.push('You have completed a skill exchange together.');
      if (!reasons.length) reasons.push('This person offers a skill in your learning profile.');
      const baseScore=Number(match.matchScore)||0;
      const availabilityCompatibility=availabilityMatch(db,userId,match.user.id,now());
      if(availabilityCompatibility===true)reasons.push('Your listed weekly availability overlaps.');
      const recommendationScore=Math.max(0,Math.min(100,Math.round(baseScore*weights.match+(direct?weights.direct:mutual?weights.mutual:weights.other)+(match.user.ratingSummary?.totalReviews?weights.rating:0)+(availabilityCompatibility===true?weights.availability:0)+Math.min(3,prior?.completed||0)*weights.peerSuccess-Math.min(1,prior?.active||0)*weights.pendingPenalty)));
      return { user:match.user, relevantSkill, reason:reasons[0], reasons, matchScore:baseScore, recommendationScore, availabilityCompatibility, rating:match.user.ratingSummary, verificationStatus:match.user.verificationStatus, teaches:match.teaches, learns:match.learns };
    }).sort((a,b)=>b.recommendationScore-a.recommendationScore||a.user.name.localeCompare(b.user.name)).slice(0,LIMIT);
    const payload = { items, source:'deterministic' }; save(userId,state.cacheKey,payload); return payload;
  }
  async function skills(userId, internal=false) {
    const snap = profileSnapshot(userId); if (!snap) return { items:[], source:'deterministic' };
    const state = cached(userId,'skills',snap.signature,internal); if (state.limited) return { items:[],source:'deterministic',rateLimited:true }; if (state.payload) return currentSkillRecommendations(userId,state.payload);
    const feedback = feedbackMap(userId), mine = new Set(snap.skills.map(skill=>skill.skillId));
    const result=eligibleSkills(userId);
    const aiGoalContext=catalogGoalContext(snap.goals,result);
    const goalTokens = new Set(snap.goals.toLowerCase().split(/[^a-z0-9+#]+/).filter(token=>token.length>2));
    let eligible = result.filter(skill=>!mine.has(skill.skillId)&&feedback.get(`SKILL:${skill.skillId}`)!=='NOT_INTERESTED').map(skill=>{
      const categoryAffinity=snap.skills.some(own=>own.category===skill.category)?2:0;
      const goalHits=[skill.name,skill.category].join(' ').toLowerCase().split(/[^a-z0-9+#]+/).filter(token=>goalTokens.has(token));
      const historyAffinity=snap.successfulCategories.includes(skill.category)?weights.history:0;
      const score=goalHits.length*weights.goal+categoryAffinity*weights.category+historyAffinity+Math.min(10,skill.teachers)*weights.teachers;
      const reason=goalHits.length?`Your learning goals mention ${goalHits[0]}, which appears in ${skill.name} or its category.`:categoryAffinity?`You have skills in ${skill.category}, the same category as ${skill.name}.`:skill.teachers?`${skill.teachers} active ${skill.teachers===1?'member teaches':'members teach'} ${skill.name}.`:'This skill is in the active SkillSwap catalog.';
      return {...skill,score,reason};
    }).filter(skill=>skill.teachers>0||skill.score>0).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).slice(0,30);
    let source='deterministic';
    try {
      const aiConfigured=Boolean(aiGoalContext&&env.AI_API_KEY&&['openai','openai-compatible'].includes(String(env.AI_PROVIDER||'').toLowerCase()));
      if(!aiConfigured){log('fallback');const items=eligible.slice(0,LIMIT).map(({score,...skill})=>({...skill,recommendationScore:Math.max(1,Math.min(100,score)),suggestion:true}));const payload={items,source:'deterministic'};save(userId,state.cacheKey,payload);return payload;}
      if(!checkAiRate(userId)){log('fallback');const items=eligible.slice(0,LIMIT).map(({score,...skill})=>({...skill,recommendationScore:Math.max(1,Math.min(100,score)),suggestion:true}));const payload={items,source:'deterministic',providerLimited:true};save(userId,state.cacheKey,payload);return payload;}
      log('request'); const ids=await aiProvider({skills:eligible,goals:aiGoalContext});
      if (ids?.length) { const aiRank=new Map(ids.map((id,index)=>[id,index])); eligible=eligible.map(item=>{const rank=aiRank.get(item.skillId),boost=rank===undefined?0:weights.aiMax*(ids.length-rank)/ids.length;return {...item,score:item.score+boost};}).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)); source='hybrid'; }
      else log('fallback');
    } catch { log('failure'); log('fallback'); console.warn(JSON.stringify({timestamp:new Date().toISOString(),level:'warn',event:'recommendation.ai_fallback'})); }
    const items=eligible.slice(0,LIMIT).map(({score,...skill})=>({...skill,recommendationScore:Math.max(1,Math.min(100,score)),suggestion:true}));
    const payload={items,source}; save(userId,state.cacheKey,payload); return payload;
  }
  async function learningPath(userId) {
    const snap=profileSnapshot(userId);if(!snap)return {items:[],source:'deterministic'};
    const state=cached(userId,'learning-path',snap.signature);if(state.limited)return {items:[],source:'deterministic',rateLimited:true};if(state.payload){const ids=state.payload.items.map(item=>item.skillId);const active=new Set(ids.length?db.prepare(`SELECT id FROM skills WHERE is_active=1 AND id IN (${ids.map(()=>'?').join(',')})`).all(...ids).map(row=>row.id):[]);const feedback=feedbackMap(userId);return {...state.payload,items:state.payload.items.filter(item=>active.has(item.skillId)&&feedback.get(`SKILL:${item.skillId}`)!=='NOT_INTERESTED')};}
    const items=(await skills(userId,true)).items.slice(0,4).map((skill,index)=>({skillId:skill.skillId,name:skill.name,category:skill.category,reason:skill.reason,step:index+1}));
    const payload={currentSkills:snap.skills.filter(skill=>skill.type==='TEACH'||skill.type==='LEARN').map(({skillId,name,type})=>({skillId,name,type})),goal:snap.goals.slice(0,240),items,source:'deterministic',disclaimer:'Suggested skills are optional; this is not a required learning sequence.'};
    save(userId,state.cacheKey,payload);return payload;
  }
  function submitFeedback(userId,{targetType,targetId,feedback}) {
    if(!checkRate(userId))return {rateLimited:true};
    if(!['USER','SKILL'].includes(targetType)||!['INTERESTED','NOT_INTERESTED'].includes(feedback)||typeof targetId!=='string'||targetId.length>100) return {error:'Choose a valid recommendation and feedback.'};
    const exists=targetType==='USER'?db.prepare("SELECT id FROM users WHERE id=? AND status='active' AND coalesce(profile_visibility,'PUBLIC')!='PRIVATE' AND id!=? AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=? AND b.blocked_user_id=users.id) OR (b.blocker_id=users.id AND b.blocked_user_id=?))").get(targetId,userId,userId,userId):db.prepare('SELECT id FROM skills WHERE id=? AND is_active=1').get(targetId);
    if(!exists)return {error:'Recommendation not found.'};
    db.prepare(`INSERT INTO recommendation_feedback(id,user_id,target_type,target_id,feedback) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id,target_type,target_id) DO UPDATE SET feedback=excluded.feedback,updated_at=CURRENT_TIMESTAMP`).run(randomUUID(),userId,targetType,targetId,feedback);
    db.prepare('DELETE FROM recommendation_cache WHERE user_id=?').run(userId);
    return {ok:true};
  }
  return { users, skills, learningPath, submitFeedback, metrics };
}
