import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogGoalContext, requestSemanticSkillOrder } from './recommendation.service.mjs';

const skills=[{skillId:'skill-react',name:'React',category:'Programming'},{skillId:'skill-ts',name:'TypeScript',category:'Programming'}];
const env={AI_PROVIDER:'openai-compatible',AI_API_KEY:'test-only-secret',AI_MODEL:'test-model',AI_BASE_URL:'https://provider.test/v1/chat/completions'};

test('AI provider sends only bounded skill and goal context and validates known skill IDs',async()=>{
  let request;
  const result=await requestSemanticSkillOrder({skills,goals:'I want to learn React',env,fetchImpl:async(url,init)=>{request={url,init,body:JSON.parse(init.body)};return{ok:true,json:async()=>({choices:[{message:{content:'{"skillIds":["skill-ts","skill-react"]}'}}]})}}});
  assert.deepEqual(result,['skill-ts','skill-react']);assert.equal(request.url,env.AI_BASE_URL);assert.equal(request.init.headers.Authorization,'Bearer test-only-secret');
  const context=request.body.messages[1].content;assert.match(context,/React/);assert.doesNotMatch(context,/email|password|token|private message|location|biography/i);assert.equal(request.body.max_tokens,180);assert.equal(request.body.temperature,0);
});

test('learning-goal context sent to AI contains only matched catalog labels',()=>{
  const context=catalogGoalContext('I want to learn React and my email is person@example.test, call me at 555-555-5555.',skills);
  assert.equal(context,'React');assert.doesNotMatch(context,/person|email|555/);
  assert.equal(catalogGoalContext('I want to change careers. An unrelated private detail.',skills),'');
});

test('AI provider rejects unknown, duplicate, malformed, and oversized output',async()=>{
  for(const content of ['not json','{"skillIds":["forged"]}','{"skillIds":["skill-react","skill-react"]}']){
    await assert.rejects(()=>requestSemanticSkillOrder({skills,goals:'React',env,fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content}}]})})}));
  }
  const tooMany=Array.from({length:9},(_,i)=>`skill-${i}`);
  await assert.rejects(()=>requestSemanticSkillOrder({skills,goals:'React',env,fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({skillIds:tooMany})}}]})})}));
});

test('AI provider failures and missing configuration safely signal deterministic fallback',async()=>{
  assert.equal(await requestSemanticSkillOrder({skills,goals:'React',env:{AI_PROVIDER:'',AI_API_KEY:''}}),null);
  await assert.rejects(()=>requestSemanticSkillOrder({skills,goals:'React',env,fetchImpl:async()=>({ok:false,status:503})}));
  await assert.rejects(()=>requestSemanticSkillOrder({skills,goals:'React',env,fetchImpl:async()=>{throw new Error('offline')}}));
});
