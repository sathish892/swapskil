import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env=loadEnv(mode,process.cwd(),'');
  const securityHeaders={
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' https://api.razorpay.com; frame-src https://api.razorpay.com https://checkout.razorpay.com; form-action 'self' https://api.razorpay.com",
  };
  return {
    plugins: [react()],
    server: { host: '127.0.0.1', port: 5173, open: false, proxy: { '/api': env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3001' } },
    preview: { headers: securityHeaders },
  };
});
