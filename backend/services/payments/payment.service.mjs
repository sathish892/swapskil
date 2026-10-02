import { randomUUID } from 'node:crypto';

export const paymentStatuses = ['CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED'];

export function createPaymentService({ db, provider, env = process.env, notify = () => {}, now = () => new Date().toISOString() }) {
  const amount = Number(env.SESSION_PAYMENT_AMOUNT_MINOR || 0);
  const currency = String(env.PAYMENT_CURRENCY || 'INR').toUpperCase();
  const paymentsEnabled = env.SESSION_PAYMENTS_ENABLED === 'true' && Number.isSafeInteger(amount) && amount > 0 && /^[A-Z]{3}$/.test(currency) && !!provider?.isConfigured?.();
  const selectSql = `SELECT id,user_id AS userId,swap_request_id AS swapRequestId,session_id AS sessionId,amount,currency,status,provider,provider_payment_id AS providerPaymentId,provider_order_id AS providerOrderId,provider_refund_id AS providerRefundId,description,metadata,created_at AS createdAt,updated_at AS updatedAt FROM payments`;
  const find = db.prepare(`${selectSql} WHERE id=?`);
  function safePayment(row) { return row ? { ...row, metadata: JSON.parse(row.metadata || '{}') } : null; }
  function paymentById(id) { return safePayment(find.get(id)); }
  function transition(payment, status, providerPaymentId = payment.providerPaymentId, providerRefundId = payment.providerRefundId) {
    if (payment.status === status) return paymentById(payment.id);
    const allowed = { CREATED: ['PENDING','FAILED','CANCELLED'], PENDING: ['SUCCESS','FAILED','CANCELLED','REFUNDED'], SUCCESS: ['REFUNDED'], FAILED: [], CANCELLED: [], REFUNDED: [] };
    if (!allowed[payment.status]?.includes(status)) return paymentById(payment.id);
    const timestamp = now();
    db.prepare('UPDATE payments SET status=?,provider_payment_id=COALESCE(?,provider_payment_id),provider_refund_id=COALESCE(?,provider_refund_id),updated_at=? WHERE id=? AND status=?').run(status, providerPaymentId, providerRefundId, timestamp, payment.id, payment.status);
    const updated = paymentById(payment.id);
    if (updated.status === status && payment.status !== status) {
      const type = status === 'SUCCESS' ? 'PAYMENT_SUCCESS' : status === 'FAILED' ? 'PAYMENT_FAILED' : status === 'REFUNDED' ? 'PAYMENT_REFUNDED' : null;
      if (type) notify({ userId: updated.userId, type, title: type === 'PAYMENT_SUCCESS' ? 'Payment successful' : type === 'PAYMENT_FAILED' ? 'Payment failed' : 'Payment refunded', message: type === 'PAYMENT_SUCCESS' ? 'Your payment was successful.' : type === 'PAYMENT_FAILED' ? 'Your payment could not be completed.' : 'Your payment has been refunded.', relatedSwapRequestId: updated.swapRequestId, relatedSessionId: updated.sessionId, dedupeKey: `${type}:${updated.id}` });
    }
    return updated;
  }
  async function create({ userId, sessionId }) {
    if (!paymentsEnabled) throw Object.assign(new Error('Session payments are not enabled.'), { status: 503 });
    if (!provider?.isConfigured?.()) throw Object.assign(new Error('Online payments are not configured yet.'), { status: 503 });
    const session = db.prepare(`SELECT ss.id,ss.swap_request_id AS swapRequestId,ss.status,sr.sender_id AS senderId,sr.receiver_id AS receiverId,COALESCE(sr.workflow_status,sr.status) AS exchangeStatus FROM skill_sessions ss JOIN swap_requests sr ON sr.id=ss.swap_request_id WHERE ss.id=?`).get(sessionId);
    if (!session || ![session.senderId, session.receiverId].includes(userId)) throw Object.assign(new Error('Session not found.'), { status: 404 });
    if (session.status !== 'CONFIRMED' || !['ACCEPTED','IN_PROGRESS'].includes(session.exchangeStatus)) throw Object.assign(new Error('Only confirmed sessions in an active exchange can be paid.'), { status: 409 });
    const existing = db.prepare("SELECT id FROM payments WHERE user_id=? AND session_id=? AND status IN ('CREATED','PENDING','SUCCESS')").get(userId, sessionId);
    if (existing) {
      const prior = paymentById(existing.id);
      if (prior.status === 'SUCCESS') throw Object.assign(new Error('This session has already been paid.'), { status: 409 });
      if (prior.providerOrderId) return { payment: prior, checkout: { paymentId:prior.id, provider: provider.provider, keyId: env.PAYMENT_KEY_ID, orderId: prior.providerOrderId, amount: prior.amount, currency: prior.currency, description: prior.description } };
    }
    const id = randomUUID(), description = `SkillSwap session ${sessionId}`, timestamp = now();
    db.prepare("INSERT INTO payments(id,user_id,swap_request_id,session_id,amount,currency,status,provider,description,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,'CREATED',?,?,?,?,?)").run(id,userId,session.swapRequestId,sessionId,amount,currency,provider.provider,description,JSON.stringify({ product: 'session_fee' }),timestamp,timestamp);
    try {
      const order = await provider.createPayment({ amount, currency, receipt: id.replaceAll('-', '').slice(0, 40), description });
      if (order.amount !== amount || order.currency !== currency || !order.orderId) throw new Error('Provider returned an unexpected order amount or currency.');
      db.prepare("UPDATE payments SET provider_order_id=?,status='PENDING',updated_at=? WHERE id=? AND status='CREATED'").run(order.orderId,now(),id);
      const payment = paymentById(id);
      return { payment, checkout: { paymentId:id, provider: provider.provider, keyId: env.PAYMENT_KEY_ID, orderId: order.orderId, amount, currency, description } };
    } catch (error) {
      transition(paymentById(id), 'FAILED');
      throw Object.assign(new Error('Payment setup failed. Please try again later.'), { status: error.status || 502 });
    }
  }
  async function verify({ userId, paymentId, providerPaymentId, providerOrderId, signature }) {
    const payment = paymentById(paymentId);
    if (!payment || payment.userId !== userId) throw Object.assign(new Error('Payment not found.'), { status: 404 });
    if (payment.status === 'SUCCESS') return payment;
    if (payment.status !== 'PENDING' || !payment.providerOrderId) throw Object.assign(new Error('This payment cannot be verified.'), { status: 409 });
    if (String(providerOrderId || '') !== payment.providerOrderId || !/^[A-Za-z0-9_]{5,100}$/.test(String(providerPaymentId || '')) || !/^[a-f0-9]{64}$/i.test(String(signature || ''))) throw Object.assign(new Error('Payment verification failed.'), { status: 400 });
    const result = await provider.verifyPayment({ orderId: payment.providerOrderId, paymentId: providerPaymentId, signature, expectedAmount: payment.amount, expectedCurrency: payment.currency });
    if (!result.verified) {
      if (result.status === 'failed') return transition(payment, 'FAILED', providerPaymentId);
      throw Object.assign(new Error('Payment has not been captured. Please check the payment status and try again.'), { status: 409 });
    }
    return transition(payment, 'SUCCESS', providerPaymentId);
  }
  function applyWebhookEvent(eventId, eventType, payload) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = db.prepare('INSERT OR IGNORE INTO payment_webhook_events(event_id,event_type,processed_at) VALUES(?,?,?)').run(eventId,eventType,now());
      if (!inserted.changes) { db.exec('COMMIT'); return { duplicate: true }; }
      const entity = payload?.payload?.payment?.entity;
      let payment = entity?.order_id ? safePayment(db.prepare(`${selectSql} WHERE provider_order_id=?`).get(entity.order_id)) : null;
      if (eventType === 'refund.processed') {
        const refund = payload?.payload?.refund?.entity;
        payment = refund?.payment_id ? safePayment(db.prepare(`${selectSql} WHERE provider_payment_id=?`).get(refund.payment_id)) : null;
        if (payment && refund.amount === payment.amount) transition(payment, 'REFUNDED', payment.providerPaymentId, refund.id);
        db.exec('COMMIT');
        return { processed: !!payment };
      }
      if (!payment || entity.amount !== payment.amount || entity.currency !== payment.currency) { db.exec('COMMIT'); return { processed: false }; }
      if (eventType === 'payment.captured' && entity.status === 'captured') transition(payment,'SUCCESS',entity.id);
      else if (eventType === 'payment.failed' && entity.status === 'failed') transition(payment,'FAILED',entity.id);
      db.exec('COMMIT');
      return { processed: true };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  async function refund(paymentId) {
    if (!provider?.isConfigured?.()) throw Object.assign(new Error('Online payments are not configured yet.'), { status: 503 });
    const payment = paymentById(paymentId);
    if (!payment) throw Object.assign(new Error('Payment not found.'), { status: 404 });
    if (payment.status !== 'SUCCESS' || !payment.providerPaymentId) throw Object.assign(new Error('Only successful payments can be refunded.'), { status: 409 });
    if (payment.providerRefundId) throw Object.assign(new Error('A refund has already been requested for this payment.'), { status: 409 });
    try {
      const result = await provider.refundPayment({ paymentId: payment.providerPaymentId });
      if (result.status === 'processed' && result.amount === payment.amount) return transition(payment,'REFUNDED',payment.providerPaymentId,result.id);
      db.prepare('UPDATE payments SET provider_refund_id=?,updated_at=? WHERE id=? AND status=\'SUCCESS\'').run(result.id,now(),payment.id);
      return paymentById(payment.id);
    } catch (error) {
      throw Object.assign(new Error('Refund could not be initiated. Please try again or contact support.'), { status: error.status || 502 });
    }
  }
  return { amount, currency, paymentsEnabled, statusValues: paymentStatuses, provider, paymentById, create, verify, applyWebhookEvent, refund };
}
