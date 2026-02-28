/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,ts,jsx,tsx}','./components/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: { fontFamily: { mono: ['JetBrains Mono','Fira Code','monospace'], sans: ['Inter','system-ui','sans-serif'] } } },
  plugins: [],
}
