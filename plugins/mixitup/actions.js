// "name=value" lines -> { name: 'value' }. Blank lines and lines starting with # are ignored.
function parseLines(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) throw new Error(`Each line needs the form name=value. This one does not: "${line.slice(0, 40)}"`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const PLATFORM = { key: 'platform', label: 'Platform (optional)', type: 'text', placeholder: 'Twitch, YouTube...', help: 'Which chat it is for. Leave empty to let Mix It Up decide.' };
const COMMAND = { key: 'command', label: 'Command', type: 'select', optionsFrom: 'mixitup.commands', allowCustom: true, required: true, help: 'Pick from the list (it fills in when Mix It Up is running), or type the command\'s exact name.' };

module.exports = [
  {
    id: 'mixitup.run',
    category: 'Mix It Up',
    label: 'Run a Mix It Up command',
    description: 'Runs one of your Mix It Up commands (chat, event, timer, action group...). Mix It Up must be running with its Developer API connected (Services → Developer API).',
    icon: '🎛️',
    params: [
      COMMAND,
      { key: 'arguments', label: 'Arguments (optional)', type: 'text', placeholder: 'for example: Nova 30', help: 'What a viewer would type after the command. The command reads them as $arg1text, $arg2text...' },
      PLATFORM,
      { key: 'special', label: 'Special identifiers (optional)', type: 'textarea', placeholder: 'user=Nova\namount=30', help: 'One per line as name=value. The command reads them as $name. Lines starting with # are ignored.' },
      { key: 'ignoreRequirements', label: 'Skip the command\'s requirements (cooldowns, permissions, cost)', type: 'boolean', default: true },
    ],
    defaults: { label: 'Mix It Up', icon: '🎛️', color: '#4b3f9e' },
    async run(p, ctx) {
      const rt = ctx.plugin('mixitup');
      const special = parseLines(p.special);
      await rt.run(p.command, { platform: p.platform, arguments: p.arguments, specialIdentifiers: special, ignoreRequirements: p.ignoreRequirements !== false });
      ctx.toast(`Ran Mix It Up command: ${String(p.command).trim()}`, 'info');
    },
  },
  {
    id: 'mixitup.state',
    category: 'Mix It Up',
    label: 'Turn a Mix It Up command on or off',
    description: 'Enables, disables or toggles one of your Mix It Up commands, for example to switch a channel-point reward or a chat command off while you are busy.',
    icon: '🔀',
    params: [
      COMMAND,
      { key: 'mode', label: 'Do this', type: 'select', default: 'toggle', options: [['toggle', 'Switch on/off each press'], ['enable', 'Turn on'], ['disable', 'Turn off']] },
    ],
    defaults: { label: 'Command on/off', icon: '🔀', color: '#4b3f9e' },
    async run(p, ctx) {
      const rt = ctx.plugin('mixitup');
      await rt.setState(p.command, p.mode || 'toggle');
      ctx.toast(`Mix It Up command "${String(p.command).trim()}": ${p.mode === 'enable' ? 'turned on' : p.mode === 'disable' ? 'turned off' : 'switched'}`, 'info');
    },
  },
  {
    id: 'mixitup.chat',
    category: 'Mix It Up',
    label: 'Send a chat message (through Mix It Up)',
    description: 'Makes Mix It Up post a message in your chat (as the bot, or as you).',
    icon: '💬',
    params: [
      { key: 'message', label: 'Message', type: 'text', required: true, placeholder: 'Thanks for watching!' },
      PLATFORM,
      { key: 'asStreamer', label: 'Send it as me, not as the bot', type: 'boolean', default: false },
    ],
    defaults: { label: 'Say it', icon: '💬', color: '#4b3f9e' },
    async run(p, ctx) {
      const rt = ctx.plugin('mixitup');
      await rt.chat(p.message, { platform: p.platform, sendAsStreamer: Boolean(p.asStreamer) });
      ctx.toast('Message sent through Mix It Up', 'info');
    },
  },
  {
    id: 'mixitup.clearChat',
    category: 'Mix It Up',
    label: 'Clear chat (through Mix It Up)',
    description: 'Asks Mix It Up to clear the chat.',
    icon: '🧹',
    params: [],
    defaults: { label: 'Clear chat', icon: '🧹', color: '#4b3f9e' },
    async run(p, ctx) {
      await ctx.plugin('mixitup').clearChat();
      ctx.toast('Asked Mix It Up to clear chat', 'info');
    },
  },
];

module.exports.parseLines = parseLines;
