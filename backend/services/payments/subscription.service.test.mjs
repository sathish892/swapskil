import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSubscriptionService } from './subscription.service.mjs';

function fixture({key='rzp_test_public',verified={verified:true,status:'captured'},at='2026-10-01T00:00:00.000Z'}={}){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT);
    INSERT INTO users VALUES('member-a','Member A','a@example.test');
    CREATE TABLE payments(id TEXT PRIMARY KEY,user_id TEXT,amount INTEGER,currency TEXT,status TEXT,provider TEXT,provider_payment_id TEXT,provider_order_id TEXT,provider_refund_id TEXT,description TEXT,metadata TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE subscriptions(id TEXT PRIMARY KEY,user_id TEXT,plan TEXT,amount INTEGER,currency TEXT,status TEXT,start_at TEXT,end_at TEXT,payment_id TEXT,provider TEXT,expiring_notified_at TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE payment_webhook_events(event_id TEXT PRIMARY KEY,event_type TEXT,processed_at TEXT);`);
  const notices=[];let clock=new Date(at);
  const provider={provider:'razorpay',isConfigured:()=>true,async createPayment({amount,currency}){return {orderId:'order_test_12345',amount,currency};},async verifyPayment(){return verified;},verifyWebhook:()=>true};
  const service=createSubscriptionService({db,provider,env:{PAYMENT_KEY_ID:key},notify:item=>notices.push(item),now:()=>new Date(clock)});
  return {db,service,notices,setNow:value=>{clock=new Date(value)}};
}

test('weekly subscription uses server price and only activates after verification',async()=>{
  const {db,service}=fixture();
  const result=await service.checkout({userId:'member-a',plan:'WEEKLY',amount:1});
  assert.equal(result.checkout.amount,2000);assert.equal(result.checkout.currency,'INR');assert.equal(result.subscription.status,'PENDING');
  const duplicate=await service.checkout({userId:'member-a',plan:'WEEKLY'});assert.equal(duplicate.checkout.paymentId,result.checkout.paymentId);assert.equal(duplicate.checkout.amount,2000);
  const active=await service.verify({userId:'member-a',paymentId:result.checkout.paymentId,providerPaymentId:'pay_test_12345',providerOrderId:result.checkout.orderId,signature:'a'.repeat(64)});
  assert.equal(active.status,'ACTIVE');assert.equal(active.endAt,'2026-10-08T00:00:00.000Z');assert.equal(db.prepare('SELECT status FROM payments').get().status,'SUCCESS');
});

test('old-priced pending checkouts are cancelled before offering updated pricing',async()=>{
  const {db,service}=fixture();
  db.prepare("INSERT INTO payments(id,user_id,amount,currency,status,provider,provider_order_id,description) VALUES('old-payment','member-a',3000,'INR','PENDING','razorpay','old-order','Old weekly subscription')").run();
  db.prepare("INSERT INTO subscriptions(id,user_id,plan,amount,currency,status,payment_id,provider) VALUES('old-subscription','member-a','WEEKLY',3000,'INR','PENDING','old-payment','razorpay')").run();
  const fresh=await service.checkout({userId:'member-a',plan:'WEEKLY'});
  assert.equal(fresh.checkout.amount,2000);assert.notEqual(fresh.subscription.id,'old-subscription');
  assert.equal(db.prepare("SELECT status FROM subscriptions WHERE id='old-subscription'").get().status,'CANCELLED');
  assert.equal(db.prepare("SELECT status FROM payments WHERE id='old-payment'").get().status,'CANCELLED');
});

test('monthly subscription honors fixed plan length and rejects live credentials',async()=>{
  const live=fixture({key:'rzp_live_secret'});assert.equal(live.service.paymentsEnabled,false);await assert.rejects(live.service.checkout({userId:'member-a',plan:'MONTHLY'}),error=>error.status===503);
  const {service}=fixture({at:'2026-10-01T00:00:00.000Z'});const result=await service.checkout({userId:'member-a',plan:'MONTHLY'});const active=await service.verify({userId:'member-a',paymentId:result.checkout.paymentId,providerPaymentId:'pay_test_12345',providerOrderId:result.checkout.orderId,signature:'b'.repeat(64)});assert.equal(active.amount,8000);assert.equal(active.endAt,'2026-10-31T00:00:00.000Z');
});

test('failed verification stays inactive and cancellation is owner scoped',async()=>{
  const failed=fixture({verified:{verified:false,status:'failed'}});const order=await failed.service.checkout({userId:'member-a',plan:'WEEKLY'});await failed.service.verify({userId:'member-a',paymentId:order.checkout.paymentId,providerPaymentId:'pay_test_12345',providerOrderId:order.checkout.orderId,signature:'c'.repeat(64)});assert.equal(failed.service.current('member-a').status,'CANCELLED');
  const pending=fixture(),checkout=await pending.service.checkout({userId:'member-a',plan:'WEEKLY'});assert.throws(()=>pending.service.cancel('someone-else',checkout.subscription.id),error=>error.status===404);assert.equal(pending.service.cancel('member-a',checkout.subscription.id).status,'CANCELLED');
});

test('verified subscription webhook activates once and deduplicates provider events',async()=>{
  const {service,notices}=fixture();const checkout=await service.checkout({userId:'member-a',plan:'WEEKLY'});
  const event={payload:{payment:{entity:{order_id:checkout.checkout.orderId,id:'pay_test_webhook',status:'captured',amount:2000,currency:'INR'}}}};
  assert.equal(service.applyWebhookEvent('evt-one','payment.captured',event).processed,true);
  assert.equal(service.applyWebhookEvent('evt-one','payment.captured',event).duplicate,true);
  assert.equal(service.applyWebhookEvent('evt-two','payment.captured',event).processed,false);
  assert.equal(service.current('member-a').status,'ACTIVE');assert.equal(notices.filter(x=>x.title==='Subscription active').length,1);
});

test('subscription expires and sends expiring and expired notices once',async()=>{
  const {service,notices,setNow}=fixture();const order=await service.checkout({userId:'member-a',plan:'WEEKLY'});await service.verify({userId:'member-a',paymentId:order.checkout.paymentId,providerPaymentId:'pay_test_12345',providerOrderId:order.checkout.orderId,signature:'d'.repeat(64)});
  setNow('2026-10-07T12:00:00.000Z');service.notifyExpiringSoon();service.notifyExpiringSoon();assert.equal(notices.filter(x=>x.title==='Subscription expiring soon').length,1);
  setNow('2026-10-08T00:00:00.000Z');assert.equal(service.hasActiveSubscription('member-a'),false);service.expireDue();assert.equal(service.current('member-a').status,'EXPIRED');assert.equal(notices.filter(x=>x.title==='Subscription expired').length,1);
});
