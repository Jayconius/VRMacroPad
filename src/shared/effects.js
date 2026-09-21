// Button effects (animations) shared by the server (validation) and the UI (menus). A UMD so it loads via <script> and require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Effects = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // id, name, what it is good for. The looks themselves live in styles.css (.fx-<id>).
  const EFFECTS = [
    { id: 'none', label: 'None', help: '' },
    { id: 'pulse', label: 'Pulse (fade in and out)', help: 'Calm and obvious. Good for "this is on".' },
    { id: 'breathe', label: 'Breathe (gently grows and shrinks)', help: 'Soft, hard to miss, never annoying.' },
    { id: 'flash', label: 'Flash (blink on and off)', help: 'Loud. Use it for warnings: mic live, recording, low battery.' },
    { id: 'glow', label: 'Glow (a halo that swells)', help: 'Looks like a lit switch.' },
    { id: 'ripple', label: 'Ripple (rings spreading out)', help: 'Like a radar ping. Nice for "live" or "listening".' },
    { id: 'heartbeat', label: 'Heartbeat (double thump)', help: 'For things that are alive: streaming, recording.' },
    { id: 'shake', label: 'Shake (a jolt now and then)', help: 'Gets attention without staying busy.' },
    { id: 'bounce', label: 'Bounce (a hop now and then)', help: 'Friendly attention grabber.' },
    { id: 'hazard', label: 'Hazard stripes (moving warning stripes)', help: 'Unmissable. For "danger": a live mic, a stream that is on air.' },
    { id: 'rainbow', label: 'Color cycle (rainbow)', help: 'Just for fun, or "party mode".' },
  ];
  const SPEEDS = [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']];
  const ids = EFFECTS.map((e) => e.id);

  return { EFFECTS, SPEEDS, isEffect: (v) => ids.includes(v), isSpeed: (v) => SPEEDS.some(([s]) => s === v) };
});
