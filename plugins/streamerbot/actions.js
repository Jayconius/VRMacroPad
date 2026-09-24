// "name=value" lines -> { name: 'value' }. Blank lines and lines starting with # are ignored.
function parseArgs(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) throw new Error(`Each argument needs the form name=value. This line does not: "${line.slice(0, 40)}"`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

module.exports = [
  {
    id: 'streamerbot.run',
    category: 'Streamer.bot',
    label: 'Run a Streamer.bot action',
    description: 'Runs one of your Streamer.bot actions, for example "Emote-only on", "Slow mode" or "Clear chat" built with its Kick or Twitch tools. Streamer.bot must be running with its WebSocket Server started.',
    icon: '🤖',
    params: [
      { key: 'action', label: 'Action', type: 'select', optionsFrom: 'streamerbot.actions', allowCustom: true, required: true, help: 'Pick from the list (it fills in when Streamer.bot is running), or type the action\'s exact name.' },
      { key: 'args', label: 'Arguments (optional)', type: 'textarea', placeholder: 'user=Nova\nseconds=30', help: 'One per line as name=value. The action reads them as %name% (or args["name"] in code). Lines starting with # are ignored.' },
    ],
    defaults: { label: 'Streamer.bot', icon: '🤖', color: '#3b5b8f' },
    async run(p, ctx) {
      const rt = ctx.plugin('streamerbot');
      const args = parseArgs(p.args);
      await rt.run(p.action, args);
      ctx.toast(`Ran Streamer.bot action: ${String(p.action).trim()}`, 'info');
    },
  },
];

module.exports.parseArgs = parseArgs;
