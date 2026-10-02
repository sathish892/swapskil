import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { createPaymentService } from './payment.service.mjs';
import { createRazorpayProvider } from './payment.provider.mjs';

function fixture({ paymentStatus = 'CONFIRMED', exchangeStatus = 'ACCEPTED', verify = { verified: true, status: 'captured' }, refund = { id: 'rfnd_mock_12345', status: 'processed', amount: 12500 } } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE swap_requests(id TEXT PRIMARY KEY,sender_id TEXT,receiver_id TEXT,workflow_status TEXT,status TEXT);
    CREATE TABLE skill_sessions(id TEXT PRIMARY KEY,swap_request_id TEXT,status TEXT);
    CREATE TABLE payments(id TEXT PRIMARY KEY,user_id TEXT,swap_request_id TEXT,session_id TEXT,amount INTEGER,currency TEXT,status TEXT,provider TEXT,provider_payment_id TEXT,provider_order_id TEXT,provider_refund_id TEXT,description TEXT,metadata TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE payment_webhook_events(event_id TEXT PRIMARY KEY,event_type TEXT,processed_at TEXT);
    INSERT INTO swap_requests VALUES('swap-a','user-a','user-b','${exchangeStatus}','${exchangeStatus}');
    INSERT INTO skill_sessions VALUES('session-a','swap-a','${paymentStatus}');`);
  const notifications = [];
  const counters = { create: 0, verify: 0, refund: 0 };
  const provider = {
    provider: 'razorpay', isConfigured: () => true,
    async createPayment({ amount, currency }) { counters.create++; return { orderId: 'order_mock_12345', amount, currency }; },
    async verifyPayment(input) { counters.verify++; return typeof verify === 'function' ? verify(input) : verify; },
    verifyWebhook: () => true,
    async refundPayment() { counters.refund++; return refund; }
  };
  const service = createPaymentService({ db, provider, env: { SESSION_PAYMENTS_ENABLED: 'true', SESSION_PAYMENT_AMOUNT_MINOR: '12500', PAYMENT_CURRENCY: 'INR', PAYMENT_KEY_ID: 'key_public' }, notify: item => notifications.push(item) });
  return { db, service, provider, notifications, counters };
}

test('payment amount comes from the server and provider order is idempotent', async () => {
  const { service, counters, db } = fixture();
  const first = await service.create({ userId: 'user-a', sessionId: 'session-a', amount: 1, currency: 'USD' });
  const second = await service.create({ userId: 'user-a', sessionId: 'session-a' });
  assert.equal(first.payment.amount, 12500);
  assert.equal(first.payment.currency, 'INR');
  assert.equal(first.payment.status, 'PENDING');
  assert.equal(second.payment.id, first.payment.id);
  assert.equal(counters.create, 1);
  assert.equal(db.prepare('SELECT amount FROM payments').get().amount, 12500);
  await service.verify({ userId: 'user-a', paymentId: first.payment.id, providerPaymentId: 'pay_mock_12345', providerOrderId: 'order_mock_12345', signature: 'e'.repeat(64) });
  await assert.rejects(service.create({ userId: 'user-a', sessionId: 'session-a' }), error => error.status === 409);
  assert.equal(counters.create, 1);
});

test('payments stay disabled without explicit pricing/provider configuration', async () => {
  const { db, provider } = fixture();
  const service = createPaymentService({ db, provider, env: { SESSION_PAYMENTS_ENABLED: 'false', SESSION_PAYMENT_AMOUNT_MINOR: '12500', PAYMENT_CURRENCY: 'INR' } });
  assert.equal(service.paymentsEnabled, false);
  await assert.rejects(service.create({ userId: 'user-a', sessionId: 'session-a' }), error => error.status === 503);
});

test('payment creation rejects a nonparticipant, cancelled session, and completed exchange', async () => {
  const unauthorized = fixture();
  await assert.rejects(unauthorized.service.create({ userId: 'user-c', sessionId: 'session-a' }), error => error.status === 404);
  const cancelled = fixture({ paymentStatus: 'CANCELLED' });
  await assert.rejects(cancelled.service.create({ userId: 'user-a', sessionId: 'session-a' }), error => error.status === 409);
  const completed = fixture({ exchangeStatus: 'COMPLETED' });
  await assert.rejects(completed.service.create({ userId: 'user-a', sessionId: 'session-a' }), error => error.status === 409);
});

test('payment verification requires the owner and marks success only after provider verification', async () => {
  const { service, notifications } = fixture();
  const { payment } = await service.create({ userId: 'user-a', sessionId: 'session-a' });
  await assert.rejects(service.verify({ userId: 'user-b', paymentId: payment.id }), error => error.status === 404);
  const verified = await service.verify({ userId: 'user-a', paymentId: payment.id, providerPaymentId: 'pay_mock_12345', providerOrderId: 'order_mock_12345', signature: 'a'.repeat(64) });
  assert.equal(verified.status, 'SUCCESS');
  assert.equal(notifications.filter(item => item.type === 'PAYMENT_SUCCESS').length, 1);
});

test('unverified and failed payments are never reported successful', async () => {
  const pendingFixture = fixture({ verify: { verified: false, status: 'authorized' } });
  const pending = await pendingFixture.service.create({ userId: 'user-a', sessionId: 'session-a' });
  await assert.rejects(pendingFixture.service.verify({ userId: 'user-a', paymentId: pending.payment.id, providerPaymentId: 'pay_mock_12345', providerOrderId: 'order_mock_12345', signature: 'b'.repeat(64) }), error => error.status === 409);
  assert.equal(pendingFixture.service.paymentById(pending.payment.id).status, 'PENDING');
  const failedFixture = fixture({ verify: { verified: false, status: 'failed' } });
  const failed = await failedFixture.service.create({ userId: 'user-a', sessionId: 'session-a' });
  assert.equal((await failedFixture.service.verify({ userId: 'user-a', paymentId: failed.payment.id, providerPaymentId: 'pay_mock_12345', providerOrderId: 'order_mock_12345', signature: 'c'.repeat(64) })).status, 'FAILED');
});

test('signed webhook events are applied once and create one notification', async () => {
  const { service, notifications } = fixture();
  const { payment } = await service.create({ userId: 'user-a', sessionId: 'session-a' });
  const event = { payload: { payment: { entity: { order_id: 'order_mock_12345', id: 'pay_mock_12345', amount: 12500, currency: 'INR', status: 'captured' } } } };
  assert.deepEqual(service.applyWebhookEvent('evt-a','payment.captured',event), { processed: true });
  assert.deepEqual(service.applyWebhookEvent('evt-a','payment.captured',event), { duplicate: true });
  assert.equal(service.paymentById(payment.id).status, 'SUCCESS');
  assert.equal(notifications.filter(item => item.type === 'PAYMENT_SUCCESS').length, 1);
});

test('refunds require a successful transaction and notify after provider completion', async () => {
  const { service, notifications, counters } = fixture();
  const { payment } = await service.create({ userId: 'user-a', sessionId: 'session-a' });
  await assert.rejects(service.refund(payment.id), error => error.status === 409);
  await service.verify({ userId: 'user-a', paymentId: payment.id, providerPaymentId: 'pay_mock_12345', providerOrderId: 'order_mock_12345', signature: 'd'.repeat(64) });
  const refunded = await service.refund(payment.id);
  assert.equal(refunded.status, 'REFUNDED');
  assert.equal(counters.refund, 1);
  assert.equal(notifications.filter(item => item.type === 'PAYMENT_REFUNDED').length, 1);
});

test('Razorpay adapter signs webhooks and uses only server-side order/payment APIs', async () => {
  const requests = [], secret = 'server-secret', webhookSecret = 'webhook-secret';
  const provider = createRazorpayProvider({ PAYMENT_PROVIDER: 'razorpay', PAYMENT_KEY_ID: 'key_id', PAYMENT_KEY_SECRET: secret, PAYMENT_WEBHOOK_SECRET: webhookSecret }, async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/orders')) return new Response(JSON.stringify({ id: 'order_12345', amount: 500, currency: 'INR' }), { status: 200 });
    if (url.endsWith('/payments/pay_12345')) return new Response(JSON.stringify({ id: 'pay_12345', order_id: 'order_12345', amount: 500, currency: 'INR', status: 'captured' }), { status: 200 });
    if (url.endsWith('/refund')) return new Response(JSON.stringify({ id: 'rfnd_12345', amount: 500, status: 'processed' }), { status: 200 });
    return new Response('{}', { status: 404 });
  });
  const order = await provider.createPayment({ amount: 500, currency: 'INR', receipt: 'r123', description: 'session' });
  const signature = createHmac('sha256', secret).update('order_12345|pay_12345').digest('hex');
  assert.equal((await provider.verifyPayment({ orderId: order.orderId, paymentId: 'pay_12345', signature, expectedAmount: 500, expectedCurrency: 'INR' })).verified, true);
  const raw = Buffer.from('{"event":"payment.captured"}'), hook = createHmac('sha256', webhookSecret).update(raw).digest('hex');
  assert.equal(provider.verifyWebhook(raw, hook), true);
  assert.equal(provider.verifyWebhook(raw, '0'.repeat(64)), false);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[1].options.method, 'GET');
  assert.equal(requests[0].options.headers.Authorization.startsWith('Basic '), true);
});
