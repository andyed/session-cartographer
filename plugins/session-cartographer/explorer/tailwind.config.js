import { NEUTRAL, LINK } from './src/lib/palette.js';

/**
 * `muted` and `link` clear 8:1 on every ground the classic views paint
 * (page, session card, open-session list, active search result, hovered
 * group header); the measured table lives in src/lib/palette.js. `muted`
 * was #abb1bb, 8.13:1 on the active search result; it now matches
 * AgentBadge's neutral, 9.57:1 there.
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: { colors: { muted: NEUTRAL, link: LINK } } },
  plugins: [],
};
