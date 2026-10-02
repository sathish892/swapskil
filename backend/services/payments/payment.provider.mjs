import { createHmac, timingSafeEqual } from 'node:crypto';

export class PaymentProviderError extends Error {
  constructor(message = 'The payment provider is unavailable.', status = 502) { super(message); this.status = status; }
}

function constantTimeHexEqual(a, b) {
  if (!/^[0-9a-f]+$/i.test(String(a)) || !/^[0-9a-f]+$/i.test(String(b))) return false;
  const left = Buffer.from(String(a), 'hex'), right = Buffer.from(String(b), 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createRazorpayProvider(env = process.env, fetchImpl = fetch) {
  const provider = 'razorpay';
  const isConfigured = () => !!(env.PAYMENT_KEY_ID && env.PAYMENT_KEY_SECRET && env.PAYMENT_WEBHOOK_SECRET);
  async function request(path, method = 'GET', body) {
    if (!env.PAYMENT_KEY_ID || !env.PAYMENT_KEY_SECRET) throw new PaymentProviderError('Online payments are not configured yet.', 503);
    let response;
    try {
      response = await fetchImpl(`https://api.razorpay.com/v1${path}`, {
        method,
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Basic ${Buffer.from(`${env.PAYMENT_KEY_ID}:${env.PAYMENT_KEY_SECRET}`).toString('base64')}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch (error) {
      throw new PaymentProviderError('The payment provider could not be reached.', 503);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new PaymentProviderError('The payment provider rejected this request.', response.status >= 500 ? 503 : 502);
      error.providerCode = data?.error?.code;
      error.providerStatus = response.status;
      throw error;
    }
    return data;
  }
  return {
    provider,
    isConfigured,
    async createPayment({ amount, currency, receipt, description }) {
      const order = await request('/orders', 'POST', { amount, currency, receipt, notes: { description: String(description).slice(0, 200) } });
      return { orderId: order.id, amount: order.amount, currency: order.currency };
    },
    async verifyPayment({ orderId, paymentId, signature, expectedAmount, expectedCurrency }) {
      if (!env.PAYMENT_KEY_SECRET) throw new PaymentProviderError('Online payments are not configured yet.', 503);
      const expected = createHmac('sha256', env.PAYMENT_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
      if (!constantTimeHexEqual(expected, signature)) return { verified: false, status: 'FAILED' };
      const payment = await request(`/payments/${encodeURIComponent(paymentId)}`);
      const verified = payment.order_id === orderId && payment.amount === expectedAmount && payment.currency === expectedCurrency && payment.status === 'captured';
      return { verified, status: payment.status, paymentId: payment.id, orderId: payment.order_id, amount: payment.amount, currency: payment.currency };
    },
    verifyWebhook(rawBody, signature) {
      if (!env.PAYMENT_WEBHOOK_SECRET || !signature) return false;
      const expected = createHmac('sha256', env.PAYMENT_WEBHOOK_SECRET).update(rawBody).digest('hex');
      return constantTimeHexEqual(expected, signature);
    },
    async refundPayment({ paymentId, amount }) {
      return request(`/payments/${encodeURIComponent(paymentId)}/refund`, 'POST', amount ? { amount } : {});
    }
  };
}

export function configuredPaymentProvider(env = process.env) {
  const name = String(env.PAYMENT_PROVIDER || '').toLowerCase();
  if (!name) return null;
  if (name === 'razorpay') return createRazorpayProvider(env);
  return null;
}
