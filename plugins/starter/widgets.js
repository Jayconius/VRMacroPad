// Widget definitions moved unchanged from the old src/core/widgets.js.
const { fillTemplate: coinDiceTemplate, rollDice, flipCoin, timerDurationMs } = require('../../src/core/widgets');

// The result is still shown on the button even when it cannot be posted, so this only warns — reached the
// same way a third-party widget would reach any plugin, through ctx.plugin(id).
async function postChat(ctx, text) {
  const t = ctx.plugin('twitch');
  if (!t) { ctx.toast('Not posted to Twitch chat: Twitch is not connected.', 'warn'); return; }
  try { await t.call((c) => c.sendChat(text)); } catch (err) { ctx.toast(`Not posted to Twitch chat: ${err.message}`, 'warn'); }
}

module.exports = [
{
    id: 'clock',
    label: 'Clock',
    description: 'Shows the time and date, in your time zone or any other.',
    icon: '🕒',
    size: { w: 2, h: 1 },
    params: [
      { key: 'hour12', label: '12-hour clock', type: 'boolean', default: false },
      { key: 'seconds', label: 'Show seconds', type: 'boolean', default: true },
      { key: 'date', label: 'Show the date', type: 'boolean', default: true },
      { key: 'timezone', label: 'Time zone (optional)', type: 'text', placeholder: 'e.g. America/New_York', suggestions: ['UTC', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo', 'Australia/Sydney'], help: 'Leave empty for your own time zone.' },
    ],
    defaults: { color: '#1f3a5f' },
    initState: () => ({}),
    data: () => ({}),
    command: async () => {},
  },
{
    id: 'timer',
    label: 'Countdown timer',
    description: 'Tap to start / pause, hold to reset. Can run buttons when it finishes.',
    icon: '⏲️',
    size: { w: 2, h: 2 },
    params: [
      { key: 'minutes', label: 'Minutes', type: 'number', min: 0, max: 999, default: 5 },
      { key: 'seconds', label: 'Seconds', type: 'number', min: 0, max: 59, default: 0 },
      { key: 'beep', label: 'Beep when it finishes', type: 'boolean', default: true },
    ],
    defaults: { color: '#5a3a1f' },
    hasFinishSteps: true,
    initState: () => ({ mode: 'idle', endsAt: 0, remainingMs: 0 }),
    data(ctx, button, st) {
      return { mode: st.mode, durationMs: timerDurationMs(button.widget.params), endsAt: st.endsAt, remainingMs: st.remainingMs };
    },
    async command(ctx, button, st, cmd) {
      const duration = timerDurationMs(button.widget.params);
      if (cmd === 'hold') { ctx.runtime.setTimer(button, st, 'idle'); return; }
      if (st.mode === 'idle' || st.mode === 'done') {
        if (st.mode === 'done') { ctx.runtime.setTimer(button, st, 'idle'); return; }
        st.remainingMs = duration;
        ctx.runtime.setTimer(button, st, 'running');
      } else if (st.mode === 'running') {
        st.remainingMs = Math.max(0, st.endsAt - ctx.now());
        ctx.runtime.setTimer(button, st, 'paused');
      } else if (st.mode === 'paused') {
        ctx.runtime.setTimer(button, st, 'running');
      }
    },
  },
{
    id: 'stopwatch',
    label: 'Stopwatch',
    description: 'Tap to start / stop, hold to reset.',
    icon: '⏱️',
    size: { w: 2, h: 2 },
    params: [{ key: 'tenths', label: 'Show tenths of a second', type: 'boolean', default: true }],
    defaults: { color: '#1f5a3a' },
    initState: () => ({ running: false, startedAt: 0, elapsedMs: 0 }),
    data: (ctx, button, st) => ({ running: st.running, startedAt: st.startedAt, elapsedMs: st.elapsedMs }),
    async command(ctx, button, st, cmd) {
      if (cmd === 'hold') { Object.assign(st, { running: false, startedAt: 0, elapsedMs: 0 }); return; }
      if (st.running) { st.elapsedMs += ctx.now() - st.startedAt; st.running = false; st.startedAt = 0; } else { st.running = true; st.startedAt = ctx.now(); }
    },
  },
{
    id: 'coin',
    label: 'Coin flip',
    description: 'Tap to flip. Optionally posts the result to your Twitch chat.',
    icon: '🌕',
    size: { w: 2, h: 2 },
    params: [
      { key: 'postToChat', label: 'Post the result to Twitch chat', type: 'boolean', default: false },
      { key: 'template', label: 'Chat message', type: 'text', default: 'The coin landed on {result}!', help: 'Use {result}.', showIf: { key: 'postToChat', in: [true] } },
    ],
    defaults: { color: '#6b5a1f' },
    initState: () => ({ last: null, seq: 0 }),
    data: (ctx, button, st) => ({ last: st.last, seq: st.seq }),
    async command(ctx, button, st) {
      const result = flipCoin(ctx.random);
      st.seq += 1;
      st.last = { text: result, detail: '', at: ctx.now() };
      if (button.widget.params.postToChat) await postChat(ctx, coinDiceTemplate(button.widget.params.template || 'Coin flip: {result}', { result }));
    },
  },
{
    id: 'dice',
    label: 'Dice roller',
    description: 'Roll d4 to d100 (or any size), several at once, with a modifier. Optionally posts to Twitch chat.',
    icon: '🎲',
    size: { w: 2, h: 2 },
    params: [
      { key: 'sides', label: 'Dice type', type: 'select', default: '20', options: [['4', 'd4'], ['6', 'd6'], ['8', 'd8'], ['10', 'd10'], ['12', 'd12'], ['20', 'd20'], ['100', 'd100'], ['custom', 'Custom…']] },
      { key: 'customSides', label: 'Sides', type: 'number', min: 2, max: 1000, default: 30, showIf: { key: 'sides', in: ['custom'] } },
      { key: 'count', label: 'How many dice', type: 'number', min: 1, max: 20, default: 1 },
      { key: 'modifier', label: 'Modifier (+/−)', type: 'number', min: -100, max: 100, default: 0 },
      { key: 'mode', label: 'd20 mode (single die only)', type: 'select', default: 'normal', options: [['normal', 'Normal'], ['advantage', 'Advantage (roll twice, keep higher)'], ['disadvantage', 'Disadvantage (roll twice, keep lower)']], showIf: { key: 'sides', in: ['20'] } },
      { key: 'postToChat', label: 'Post the result to Twitch chat', type: 'boolean', default: false },
      { key: 'template', label: 'Chat message', type: 'text', default: '🎲 Rolled {dice}: {total}', help: 'Use {dice}, {total}, {rolls}, {detail}.', showIf: { key: 'postToChat', in: [true] } },
    ],
    defaults: { color: '#5a1f4a' },
    initState: () => ({ last: null, seq: 0 }),
    data: (ctx, button, st) => ({ last: st.last, seq: st.seq }),
    async command(ctx, button, st) {
      const p = button.widget.params;
      const sides = p.sides === 'custom' ? Number(p.customSides) || 6 : Number(p.sides) || 20;
      const r = rollDice({ count: Number(p.count) || 1, sides, modifier: Number(p.modifier) || 0, mode: p.mode }, ctx.random);
      st.seq += 1;
      st.last = { text: String(r.total), detail: r.detail, dice: r.notation, natural: r.natural, at: ctx.now() };
      if (p.postToChat) {
        await postChat(ctx, coinDiceTemplate(p.template || '🎲 {dice}: {total}', { dice: r.notation, total: r.total, rolls: r.rolls.join(', '), detail: r.detail }));
      }
    },
  },
{
    id: 'media',
    label: 'Now playing (Spotify & more)',
    description: 'Album cover, title, progress bar and play / pause / skip. Works with Spotify and most players.',
    icon: '🎵',
    size: { w: 4, h: 2 },
    params: [
      { key: 'app', label: 'Player', type: 'select', optionsFrom: 'media.players', unknownSuffix: 'not running right now', default: 'auto', help: 'Pick the app to show. The list is what Windows sees right now (start the music first if it is missing). Automatic prefers a playing music app over a browser tab. Pear API adds the album plus like, shuffle and repeat buttons (connect it in Settings first).' },
      { key: 'controls', label: 'Show play / pause / skip buttons', type: 'boolean', default: true },
      { key: 'progress', label: 'Show the progress bar', type: 'boolean', default: true },
    ],
    defaults: { color: '#14261c' },
    needs: (p) => (String(p.app) === 'pear' ? { pear: true } : { media: [String(p.app || 'auto')] }),
    initState: () => ({}),
    data: (ctx, button) => ctx.media(String(button.widget.params.app || 'auto')),
    async command(ctx, button, st, cmd, arg) {
      const map = { toggle: 'toggle', next: 'next', previous: 'previous', play: 'play', pause: 'pause', seek: 'seek', like: 'like', dislike: 'dislike', shuffle: 'shuffle', repeat: 'repeat' };
      if (!map[cmd]) throw new Error(`Unknown media command "${cmd}"`);
      await ctx.mediaControl(String(button.widget.params.app || 'auto'), map[cmd], arg);
    },
  },
];
