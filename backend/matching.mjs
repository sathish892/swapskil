const levels = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'];

function skillsFor(db, userId) {
  return db.prepare(`
    SELECT us.id AS userSkillId, us.skill_id AS skillId, us.type, us.level,
      s.name, s.category, s.description
    FROM user_skills us JOIN skills s ON s.id = us.skill_id
    WHERE us.user_id = ? AND s.is_active=1 ORDER BY s.name COLLATE NOCASE
  `).all(userId);
}

function mapSkills(skills) {
  return skills.map(({ skillId, name, category, description, level }) => ({ skillId, name, category, description, level }));
}

function getMatchLabel(score) {
  if (score >= 75) return 'Strong Match';
  if (score >= 55) return 'Good Match';
  return 'Potential Match';
}

function buildMatch(db, currentSkills, candidate, rating = { teachingReviewCount:0, teachingAverageRating:0, learningReviewCount:0, learningAverageRating:0 }) {
  const theirSkills = skillsFor(db, candidate.id);
  const mineLearn = currentSkills.filter(skill => skill.type === 'LEARN');
  const mineTeach = currentSkills.filter(skill => skill.type === 'TEACH');
  const theirTeach = theirSkills.filter(skill => skill.type === 'TEACH');
  const theirLearn = theirSkills.filter(skill => skill.type === 'LEARN');
  const teachById = new Map(theirTeach.map(skill => [skill.skillId, skill]));
  const learnById = new Map(theirLearn.map(skill => [skill.skillId, skill]));
  const directSkills = mineLearn.flatMap(wanted => {
    const theirSkill = teachById.get(wanted.skillId);
    return theirSkill ? [{
      skillId: wanted.skillId, name: wanted.name, category: wanted.category,
      yourLevel: wanted.level, theirLevel: theirSkill.level,
    }] : [];
  });
  const mutualSkills = mineTeach.flatMap(offered => {
    const theirWanted = learnById.get(offered.skillId);
    return theirWanted ? [{
      skillId: offered.skillId, name: offered.name, category: offered.category,
      yourLevel: offered.level, theirLevel: theirWanted.level,
    }] : [];
  });
  const isMutual = directSkills.length > 0 && mutualSkills.length > 0;
  const compatibleLevel = directSkills.some(skill => levels.indexOf(skill.theirLevel) >= levels.indexOf(skill.yourLevel));
  const hasCategoryMatch = directSkills.some(skill => Boolean(skill.category));
  const profileComplete = Boolean(candidate.bio?.trim().length >= 50 && theirTeach.length && theirLearn.length);
  const score = Math.min(100, 50 + (isMutual ? 30 : 0) + (hasCategoryMatch ? 10 : 0) + (compatibleLevel ? 10 : 0) + (profileComplete ? 10 : 0));

  return {
    user: { id: candidate.id, name: candidate.name, bio: candidate.bio || '', avatar: candidate.avatar || null, location:candidate.location||'', verificationStatus:candidate.verification_status||'UNVERIFIED', teachingRating:{averageRating:Number(rating.teachingAverageRating.toFixed(2)),totalReviews:rating.teachingReviewCount}, learningRating:{averageRating:Number(rating.learningAverageRating.toFixed(2)),totalReviews:rating.learningReviewCount} },
    teaches: mapSkills(theirTeach),
    learns: mapSkills(theirLearn),
    directSkills,
    mutualSkills,
    matchType: isMutual ? 'MUTUAL' : 'DIRECT',
    matchScore: score,
    label: getMatchLabel(score),
    offeredSkills: mapSkills(mineTeach),
  };
}

export function findMatches(db, userId, searchParams) {
  const mine = skillsFor(db, userId);
  const wanted = mine.filter(skill => skill.type === 'LEARN');
  if (!wanted.length) return { items: [], page: 1, pageSize: 12, hasMore: false };

  const page = Math.max(1, Math.min(100_000, Number.parseInt(searchParams.get('page') || '1', 10) || 1));
  const pageSize = Math.max(1, Math.min(24, Number.parseInt(searchParams.get('pageSize') || '12', 10) || 12));
  const skillId = searchParams.get('skill')?.trim();
  const category = searchParams.get('category')?.trim();
  const level = searchParams.get('level')?.trim().toUpperCase();
  const matchType = searchParams.get('type')?.trim().toUpperCase();
  const q = searchParams.get('q')?.trim().toLowerCase();

  const matchFilters = [];
  const matchParams = [];
  if (skillId) { matchFilters.push('AND matched_skill.id = ?'); matchParams.push(skillId); }
  if (category && category !== 'ALL') { matchFilters.push('AND lower(matched_skill.category) = lower(?)'); matchParams.push(category); }
  if (levels.includes(level)) { matchFilters.push('AND peer_teach.level = ?'); matchParams.push(level); }
  const directMatch = `EXISTS (
    SELECT 1 FROM user_skills mine_learn
    JOIN user_skills peer_teach ON peer_teach.skill_id = mine_learn.skill_id AND peer_teach.user_id = u.id AND peer_teach.type = 'TEACH'
    JOIN skills matched_skill ON matched_skill.id = mine_learn.skill_id AND matched_skill.is_active=1
    WHERE mine_learn.user_id = ? AND mine_learn.type = 'LEARN' ${matchFilters.join(' ')}
  )`;
  const mutualMatch = `EXISTS (
    SELECT 1 FROM user_skills peer_learn
    JOIN user_skills mine_teach ON mine_teach.skill_id = peer_learn.skill_id AND mine_teach.user_id = ? AND mine_teach.type = 'TEACH'
    WHERE peer_learn.user_id = u.id AND peer_learn.type = 'LEARN'
  )`;
  const clauses = ['u.id != ?', "u.status = 'active'", "coalesce(u.profile_visibility, 'PUBLIC') != 'PRIVATE'", directMatch];
  const params = [userId, userId, ...matchParams];
  if (matchType === 'MUTUAL') { clauses.push(mutualMatch); params.push(userId); }
  else if (matchType === 'DIRECT') { clauses.push(`NOT ${mutualMatch}`); params.push(userId); }
  if (q) {
    clauses.push(`(lower(u.name) LIKE ? OR lower(coalesce(u.bio, '')) LIKE ? OR EXISTS (
      SELECT 1 FROM user_skills query_skills JOIN skills query_skill ON query_skill.id = query_skills.skill_id AND query_skill.is_active=1
      WHERE query_skills.user_id = u.id AND lower(query_skill.name) LIKE ?
    ))`);
    const pattern = `%${q.slice(0, 80)}%`;
    params.push(pattern, pattern, pattern);
  }
  clauses.push('NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id=? AND b.blocked_user_id=u.id) OR (b.blocker_id=u.id AND b.blocked_user_id=?))');params.push(userId,userId);
  params.push(pageSize + 1, (page - 1) * pageSize);
  const candidates = db.prepare(`
    SELECT u.id, u.name, u.bio, u.avatar,u.verification_status
    FROM users u WHERE ${clauses.join(' AND ')}
    ORDER BY u.name COLLATE NOCASE, u.id LIMIT ? OFFSET ?
  `).all(...params);
  const hasMore = candidates.length > pageSize;
  const selected=candidates.slice(0,pageSize);
  const ratings=selected.length?db.prepare(`SELECT r.reviewee_id AS userId,SUM(CASE WHEN r.review_type='TEACHING' THEN 1 ELSE 0 END) AS teachingReviewCount,AVG(CASE WHEN r.review_type='TEACHING' THEN r.rating END) AS teachingAverageRating,SUM(CASE WHEN r.review_type='LEARNING' THEN 1 ELSE 0 END) AS learningReviewCount,AVG(CASE WHEN r.review_type='LEARNING' THEN r.rating END) AS learningAverageRating FROM reviews r JOIN users ru ON ru.id=r.reviewee_id AND ru.show_reviews=1 WHERE r.reviewee_id IN (${selected.map(()=>'?').join(',')}) GROUP BY r.reviewee_id`).all(...selected.map(candidate=>candidate.id)):[];
  const ratingById=new Map(ratings.map(row=>[row.userId,{teachingReviewCount:Number(row.teachingReviewCount||0),teachingAverageRating:Number(row.teachingAverageRating||0),learningReviewCount:Number(row.learningReviewCount||0),learningAverageRating:Number(row.learningAverageRating||0)}]));
  const items = selected
    .map(candidate => buildMatch(db, mine, candidate,ratingById.get(candidate.id)))
    .filter(match => match.directSkills.length > 0);
  return { items, page, pageSize, hasMore };
}

export function findDiscovery(db,userId,searchParams){
  const page=Math.max(1,Number.parseInt(searchParams.get('page')||'1',10)||1),limit=Math.max(1,Math.min(20,Number.parseInt(searchParams.get('limit')||'20',10)||20));
  const q=String(searchParams.get('q')||'').trim().slice(0,80),tokens=q.toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0,6);
  const category=String(searchParams.get('category')||'').trim().slice(0,60),level=String(searchParams.get('level')||'').trim().toUpperCase(),intent=String(searchParams.get('intent')||'all').trim().toLowerCase(),rating=Number(searchParams.get('rating')||0),location=String(searchParams.get('location')||'').trim().slice(0,80),sort=String(searchParams.get('sort')||'relevance').trim().toLowerCase();
  const mine=skillsFor(db,userId),where=["u.status='active'","coalesce(u.profile_visibility,'PUBLIC')!='PRIVATE'",'u.id!=?'],params=[userId];
  for(const token of tokens){const like=`%${token}%`;where.push(`(lower(u.name) LIKE ? OR lower(coalesce(u.bio,'')) LIKE ? OR lower(coalesce(u.location,'')) LIKE ? OR EXISTS(SELECT 1 FROM user_skills qu JOIN skills qs ON qs.id=qu.skill_id AND qs.is_active=1 WHERE qu.user_id=u.id AND (lower(qs.name) LIKE ? OR lower(qs.category) LIKE ? OR lower(qu.level) LIKE ?)) )`);params.push(like,like,like,like,like,like);}
  if(category) {where.push(`EXISTS(SELECT 1 FROM user_skills fc JOIN skills fs ON fs.id=fc.skill_id WHERE fc.user_id=u.id AND lower(fs.category)=lower(?))`);params.push(category);}
  if(levels.includes(level)){where.push('EXISTS(SELECT 1 FROM user_skills fl WHERE fl.user_id=u.id AND fl.level=?)');params.push(level);}
  if(location){where.push("lower(coalesce(u.location,'')) LIKE ?");params.push(`%${location.toLocaleLowerCase()}%`);}
  if(['teach','learn','mutual'].includes(intent)){
    const querySkills=(alias,kind)=>{if(!tokens.length)return;const terms=tokens.map(()=>`(lower(${alias}.name) LIKE ? OR lower(${alias}.category) LIKE ? OR lower(coalesce(${alias}.description,'')) LIKE ? OR lower(iq.level) LIKE ?)`).join(' AND ');where.push(`EXISTS(SELECT 1 FROM user_skills iq JOIN skills ${alias} ON ${alias}.id=iq.skill_id AND ${alias}.is_active=1 WHERE iq.user_id=u.id AND iq.type='${kind}' AND ${terms})`);for(const token of tokens)params.push(`%${token}%`,`%${token}%`,`%${token}%`,`%${token}%`);};
    if(intent==='teach'){where.push("EXISTS(SELECT 1 FROM user_skills it WHERE it.user_id=u.id AND it.type='TEACH')");querySkills('ts','TEACH');}
    if(intent==='learn'){if(mine.some(s=>s.type==='TEACH')){where.push("EXISTS(SELECT 1 FROM user_skills il JOIN user_skills mt ON mt.skill_id=il.skill_id AND mt.user_id=? AND mt.type='TEACH' WHERE il.user_id=u.id AND il.type='LEARN')");params.push(userId);querySkills('ls','LEARN');}else where.push('0');}
    if(intent==='mutual')where.push(`EXISTS(SELECT 1 FROM user_skills pl JOIN user_skills ml ON ml.skill_id=pl.skill_id AND ml.user_id=? AND ml.type='LEARN' WHERE pl.user_id=u.id AND pl.type='TEACH') AND EXISTS(SELECT 1 FROM user_skills pw JOIN user_skills mt ON mt.skill_id=pw.skill_id AND mt.user_id=? AND mt.type='TEACH' WHERE pw.user_id=u.id AND pw.type='LEARN')`),params.push(userId,userId);
  }
  if(rating>0&&[3,3.5,4,4.5].includes(rating))where.push('COALESCE(rv.teaching_average_rating,0)>=? AND COALESCE(rv.teaching_review_count,0)>0'),params.push(rating);
  where.push('NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id=? AND b.blocked_user_id=u.id) OR (b.blocker_id=u.id AND b.blocked_user_id=?))');params.push(userId,userId);const baseWhere=where.join(' AND '),ratingJoin="LEFT JOIN (SELECT r.reviewee_id,AVG(CASE WHEN r.review_type='TEACHING' THEN r.rating END) AS teaching_average_rating,SUM(CASE WHEN r.review_type='TEACHING' THEN 1 ELSE 0 END) AS teaching_review_count,AVG(CASE WHEN r.review_type='LEARNING' THEN r.rating END) AS learning_average_rating,SUM(CASE WHEN r.review_type='LEARNING' THEN 1 ELSE 0 END) AS learning_review_count FROM reviews r JOIN users ru ON ru.id=r.reviewee_id AND ru.show_reviews=1 GROUP BY r.reviewee_id) rv ON rv.reviewee_id=u.id";
  const total=db.prepare(`SELECT COUNT(*) AS n FROM users u ${ratingJoin} WHERE ${baseWhere}`).get(...params).n;
  const exact=q.toLocaleLowerCase(),partial=`%${exact}%`;
  const directSignal="EXISTS(SELECT 1 FROM user_skills rd JOIN user_skills ml ON ml.skill_id=rd.skill_id AND ml.user_id=? AND ml.type='LEARN' WHERE rd.user_id=u.id AND rd.type='TEACH')";
  const reverseSignal="EXISTS(SELECT 1 FROM user_skills rl JOIN user_skills mt ON mt.skill_id=rl.skill_id AND mt.user_id=? AND mt.type='TEACH' WHERE rl.user_id=u.id AND rl.type='LEARN')";
  const mutualSignal=`(${directSignal} AND ${reverseSignal})`;
  const categorySignal="EXISTS(SELECT 1 FROM user_skills cm JOIN user_skills ct ON ct.skill_id=cm.skill_id AND ct.user_id=u.id AND ct.type='TEACH' JOIN skills cs ON cs.id=cm.skill_id WHERE cm.user_id=? AND cm.type='LEARN' AND coalesce(cs.category,'')!='')";
  const levelSignal="EXISTS(SELECT 1 FROM user_skills lm JOIN user_skills lt ON lt.skill_id=lm.skill_id AND lt.user_id=u.id AND lt.type='TEACH' WHERE lm.user_id=? AND lm.type='LEARN' AND (CASE lt.level WHEN 'BEGINNER' THEN 1 WHEN 'INTERMEDIATE' THEN 2 WHEN 'ADVANCED' THEN 3 ELSE 4 END)>=(CASE lm.level WHEN 'BEGINNER' THEN 1 WHEN 'INTERMEDIATE' THEN 2 WHEN 'ADVANCED' THEN 3 ELSE 4 END))";
  const relevantSignals=`CASE WHEN ${mutualSignal} THEN 30 ELSE 0 END + CASE WHEN ${categorySignal} THEN 10 ELSE 0 END + CASE WHEN ${levelSignal} THEN 10 ELSE 0 END + CASE WHEN length(trim(coalesce(u.bio,'')))>=50 AND coalesce(u.avatar,'')!='' AND EXISTS(SELECT 1 FROM user_skills pt WHERE pt.user_id=u.id AND pt.type='TEACH') AND EXISTS(SELECT 1 FROM user_skills pl WHERE pl.user_id=u.id AND pl.type='LEARN') THEN 10 ELSE 0 END + CASE WHEN COALESCE(rv.teaching_review_count,0)+COALESCE(rv.learning_review_count,0)>0 THEN 1 ELSE 0 END`;
  const relevance=q?`(CASE WHEN EXISTS(SELECT 1 FROM user_skills rq JOIN skills rs ON rs.id=rq.skill_id WHERE rq.user_id=u.id AND lower(rs.name)=?) THEN 50 WHEN EXISTS(SELECT 1 FROM user_skills rq JOIN skills rs ON rs.id=rq.skill_id WHERE rq.user_id=u.id AND lower(rs.name) LIKE ?) THEN 25 ELSE 0 END + ${relevantSignals})`:`(${relevantSignals})`;
  let order='relevance_score DESC,u.name COLLATE NOCASE,u.id';if(sort==='newest')order='u.created_at DESC,u.id';if(sort==='rating')order='rv.teaching_average_rating DESC,rv.teaching_review_count DESC,u.name COLLATE NOCASE';if(sort==='reviews')order='rv.teaching_review_count DESC,rv.teaching_average_rating DESC,u.name COLLATE NOCASE';
  const relevanceParams=q?[exact,partial,userId,userId,userId,userId]:[userId,userId,userId,userId];
  const rows=db.prepare(`SELECT u.id,u.name,u.bio,u.avatar,u.verification_status,u.location,u.created_at AS createdAt,COALESCE(rv.teaching_average_rating,0) AS teachingAverageRating,COALESCE(rv.teaching_review_count,0) AS teachingReviewCount,COALESCE(rv.learning_average_rating,0) AS learningAverageRating,COALESCE(rv.learning_review_count,0) AS learningReviewCount,${relevance} AS relevance_score FROM users u ${ratingJoin} WHERE ${baseWhere} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...relevanceParams,...params,limit+1,(page-1)*limit);
  const hasNext=rows.length>limit,selected=rows.slice(0,limit),ratings=new Map(selected.map(r=>[r.id,{teachingAverageRating:Number(r.teachingAverageRating),teachingReviewCount:Number(r.teachingReviewCount),learningAverageRating:Number(r.learningAverageRating),learningReviewCount:Number(r.learningReviewCount)}]));
  const people=selected.map(row=>{const match=buildMatch(db,mine,row,ratings.get(row.id));return {...match,user:{...match.user,location:row.location||'',createdAt:row.createdAt}};});
  return {people:{results:people,pagination:{page,limit,total,hasNext}},filters:{query:q,category,level,intent,rating:rating||'',location,sort},categories:db.prepare('SELECT DISTINCT category FROM skills ORDER BY category COLLATE NOCASE').all().map(row=>row.category)};
}

export function findDiscoverySkills(db,userId,searchParams){
  const page=Math.max(1,Number.parseInt(searchParams.get('page')||'1',10)||1),limit=Math.max(1,Math.min(20,Number.parseInt(searchParams.get('limit')||'20',10)||20));
  const q=String(searchParams.get('q')||'').trim().slice(0,80),tokens=q.toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0,6),category=String(searchParams.get('category')||'').trim().slice(0,60),level=String(searchParams.get('level')||'').trim().toUpperCase(),intent=String(searchParams.get('intent')||'all').trim().toLowerCase();
  const mine=skillsFor(db,userId),hasMineTeach=mine.some(skill=>skill.type==='TEACH'),hasMineLearn=mine.some(skill=>skill.type==='LEARN');
  const where=['s.is_active=1'],params=[];for(const token of tokens){const like=`%${token}%`;where.push("(lower(s.name) LIKE ? OR lower(coalesce(s.description,'')) LIKE ? OR lower(s.category) LIKE ? OR EXISTS(SELECT 1 FROM user_skills uq WHERE uq.skill_id=s.id AND lower(uq.level) LIKE ?))");params.push(like,like,like,like);}if(category){where.push('lower(s.category)=lower(?)');params.push(category);}if(levels.includes(level))where.push(`EXISTS(SELECT 1 FROM user_skills ul WHERE ul.skill_id=s.id AND ul.level=?)`),params.push(level);
  if(intent==='teach')where.push("EXISTS(SELECT 1 FROM user_skills ti JOIN users tu ON tu.id=ti.user_id WHERE ti.skill_id=s.id AND ti.type='TEACH' AND ti.user_id!=? AND tu.status='active' AND coalesce(tu.profile_visibility,'PUBLIC')!='PRIVATE')"),params.push(userId);
  if(intent==='learn'){if(hasMineTeach){where.push("EXISTS(SELECT 1 FROM user_skills li JOIN users lu ON lu.id=li.user_id WHERE li.skill_id=s.id AND li.type='LEARN' AND li.user_id!=? AND lu.status='active' AND coalesce(lu.profile_visibility,'PUBLIC')!='PRIVATE')");params.push(userId)}else where.push('0')}
  if(intent==='mutual'){if(hasMineTeach&&hasMineLearn){where.push(`EXISTS(SELECT 1 FROM users mu WHERE mu.id!=? AND mu.status='active' AND coalesce(mu.profile_visibility,'PUBLIC')!='PRIVATE' AND EXISTS(SELECT 1 FROM user_skills mt JOIN user_skills pl ON pl.skill_id=mt.skill_id AND pl.user_id=mu.id AND pl.type='LEARN' WHERE mt.user_id=? AND mt.type='TEACH') AND EXISTS(SELECT 1 FROM user_skills ml JOIN user_skills pt ON pt.skill_id=ml.skill_id AND pt.user_id=mu.id AND pt.type='TEACH' WHERE ml.user_id=? AND ml.type='LEARN'))`);params.push(userId,userId,userId)}else where.push('0')}
  const minimumRating=Number(searchParams.get('rating')||0);if([3,3.5,4,4.5].includes(minimumRating)){where.push(`EXISTS(SELECT 1 FROM user_skills ri JOIN users ru ON ru.id=ri.user_id AND ru.show_reviews=1 JOIN reviews rr ON rr.reviewee_id=ri.user_id AND rr.review_type='TEACHING' WHERE ri.skill_id=s.id AND ri.type='TEACH' AND ru.status='active' AND coalesce(ru.profile_visibility,'PUBLIC')!='PRIVATE' GROUP BY ri.user_id HAVING COUNT(rr.id)>0 AND AVG(rr.rating)>=?)`);params.push(minimumRating)}
  const base=where.join(' AND '),total=db.prepare(`SELECT COUNT(*) AS n FROM skills s WHERE ${base}`).get(...params).n;
  const teacherRating=`(SELECT AVG(r.rating) FROM user_skills tu JOIN users uu ON uu.id=tu.user_id AND uu.show_reviews=1 JOIN reviews r ON r.reviewee_id=tu.user_id AND r.review_type='TEACHING' WHERE tu.skill_id=s.id AND tu.type='TEACH' AND uu.status='active' AND coalesce(uu.profile_visibility,'PUBLIC')!='PRIVATE')`,teacherReviewCount=`(SELECT COUNT(r.id) FROM user_skills tu JOIN users uu ON uu.id=tu.user_id AND uu.show_reviews=1 JOIN reviews r ON r.reviewee_id=tu.user_id AND r.review_type='TEACHING' WHERE tu.skill_id=s.id AND tu.type='TEACH' AND uu.status='active' AND coalesce(uu.profile_visibility,'PUBLIC')!='PRIVATE')`;
  let order=`CASE WHEN lower(s.name)=? THEN 0 WHEN lower(s.name) LIKE ? THEN 1 ELSE 2 END,s.name COLLATE NOCASE,s.id`,orderParams=q?[q,`${q}%`]:['','%'];if(!q&&searchParams.get('sort')!=='newest'&&searchParams.get('sort')!=='rating'&&searchParams.get('sort')!=='reviews'){order='teachers DESC,s.name COLLATE NOCASE,s.id';orderParams=[]}if(searchParams.get('sort')==='newest'){order='s.created_at DESC,s.id';orderParams=[]}if(searchParams.get('sort')==='rating'){order=`COALESCE(${teacherRating},0) DESC,${teacherReviewCount} DESC,s.name COLLATE NOCASE`;orderParams=[]}if(searchParams.get('sort')==='reviews'){order=`${teacherReviewCount} DESC,COALESCE(${teacherRating},0) DESC,s.name COLLATE NOCASE`;orderParams=[]}
  const rows=db.prepare(`SELECT s.id AS skillId,s.name,s.category,s.description,s.created_at AS createdAt,COALESCE(${teacherRating},0) AS averageRating,${teacherReviewCount} AS reviewCount,
    (SELECT COUNT(DISTINCT us.user_id) FROM user_skills us JOIN users u ON u.id=us.user_id WHERE us.skill_id=s.id AND us.type='TEACH' AND us.user_id!=? AND u.status='active' AND coalesce(u.profile_visibility,'PUBLIC')!='PRIVATE') AS teachers,
    (SELECT COUNT(DISTINCT us.user_id) FROM user_skills us JOIN users u ON u.id=us.user_id WHERE us.skill_id=s.id AND us.type='LEARN' AND us.user_id!=? AND u.status='active' AND coalesce(u.profile_visibility,'PUBLIC')!='PRIVATE') AS learners,
    (SELECT group_concat(DISTINCT us.level) FROM user_skills us JOIN users u ON u.id=us.user_id WHERE us.skill_id=s.id AND us.type='TEACH' AND u.status='active' AND coalesce(u.profile_visibility,'PUBLIC')!='PRIVATE') AS levels
    FROM skills s WHERE ${base} ORDER BY ${order} LIMIT ? OFFSET ?`).all(userId,userId,...params,...orderParams,limit+1,(page-1)*limit);
  return {results:rows.slice(0,limit).map(row=>({...row,levels:row.levels?row.levels.split(','):[ ]})),pagination:{page,limit,total,hasNext:rows.length>limit},categories:db.prepare('SELECT DISTINCT category FROM skills ORDER BY category COLLATE NOCASE').all().map(row=>row.category)};
}

export function getPublicProfile(db, userId, viewerId = null) {
  const user = db.prepare(`SELECT id, name, bio, avatar, verification_status AS verificationStatus,created_at AS createdAt, profile_visibility AS profileVisibility FROM users WHERE id = ? AND status = 'active'`).get(userId);
  if (!user || (user.profileVisibility === 'PRIVATE' && user.id !== viewerId)) return null;
  const skills = skillsFor(db, userId);
  return {
    user: { id: user.id, name: user.name, bio: user.bio || '', avatar: user.avatar || null, verificationStatus:user.verificationStatus||'UNVERIFIED',createdAt: user.createdAt },
    teaches: mapSkills(skills.filter(skill => skill.type === 'TEACH')),
    learns: mapSkills(skills.filter(skill => skill.type === 'LEARN')),
  };
}
