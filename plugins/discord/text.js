// {placeholders} that can be used in any message: filled in when the button is pressed.
//   {time} 21:05   {date} 2026-09-23   {song} title   {artist}   {track} "Artist - Title"   {scene} OBS scene
// Unknown placeholders are left as typed, so a message like "{hello}" is never damaged.
const pad = (n) => String(n).padStart(2, '0');

function values(ctx, now = new Date()) {
  const np = ctx.nowPlaying ? ctx.nowPlaying() : null;
  const scene = ctx.hub && ctx.hub.get ? ctx.hub.get('obs.scene') : '';
  return {
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    song: np ? np.title : '',
    artist: np ? np.artist : '',
    track: np ? [np.artist, np.title].filter(Boolean).join(' - ') : '',
    scene: typeof scene === 'string' ? scene : '',
  };
}

// only (optional): the placeholders this text may use, e.g. ['time', 'date']. Any other {word} is left exactly as typed.
function fill(text, ctx, now, only) {
  const v = values(ctx, now);
  return String(text ?? '').replace(/\{(time|date|song|artist|track|scene)\}/g, (whole, k) => (only && !only.includes(k) ? whole : v[k]));
}

// Does this text use {scene}? (Then the button needs OBS connected to know it.)
const usesScene = (...texts) => texts.some((t) => /\{scene\}/.test(String(t || '')));

module.exports = { fill, usesScene };
