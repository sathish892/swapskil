/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './frontend/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#eef4ff',
          100: '#d9e5ff',
          200: '#bcd1ff',
          300: '#8eb2ff',
          400: '#5a8bff',
          500: '#3563ff',
          600: '#1f43f5',
          700: '#1a34d8',
          800: '#1c2eae',
          900: '#1d2e89',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 10px 30px -12px rgba(20, 30, 80, 0.15)',
      },
    },
  },
  plugins: [],
};
