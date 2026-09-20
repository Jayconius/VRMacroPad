// Twitch: chat macros, chat modes, shield mode, ads, clips, raids and more.
// Connect your account in Settings → Connections first.
const MODES = {
  emote: { state: 'twitch.emoteOnly', field: 'emote_mode', label: 'Emote-only' },
  followers: { state: 'twitch.followersOnly', field: 'follower_mode', label: 'Followers-only' },
  subscribers: { state: 'twitch.subsOnly', field: 'subscriber_mode', label: 'Subscribers-only' },
  slow: { state: 'twitch.slowMode', field: 'slow_mode', label: 'Slow mode' },
  unique: { state: 'twitch.uniqueChat', field: 'unique_chat_mode', label: 'Unique chat' },
};

const TOGGLE = [['toggle', 'Toggle'], ['on', 'Turn on'], ['off', 'Turn off']];

const actions = [
  {
    id: 'twitch.chat',
    category: 'Twitch',
    label: 'Send chat message',
    description: 'Says something in your chat (hi, welcome raiders, socials...).',
    icon: '💬',
    needs: 'twitch',
    params: [{ key: 'message', label: 'Message', type: 'textarea', required: true, help: 'Up to 500 characters. Chain several steps with a delay for a sequence of messages.' }],
    defaults: { label: 'Say hi', icon: '👋', color: '#6b46c1' },
    async run(p, ctx) {
      if (!String(p.message || '').trim()) throw new Error('Type a message first');
      await ctx.twitchApi((t) => t.sendChat(p.message));
    },
  },
  {
    id: 'twitch.announce',
    category: 'Twitch',
    label: 'Send announcement',
    description: 'A highlighted announcement in chat.',
    icon: '📢',
    needs: 'twitch',
    params: [
      { key: 'message', label: 'Message', type: 'textarea', required: true },
      { key: 'color', label: 'Color', type: 'select', default: 'primary', options: [['primary', 'Channel color'], ['blue', 'Blue'], ['green', 'Green'], ['orange', 'Orange'], ['purple', 'Purple']] },
    ],
    defaults: { label: 'Announce', icon: '📢', color: '#6b46c1' },
    async run(p, ctx) {
      if (!String(p.message || '').trim()) throw new Error('Type a message first');
      await ctx.twitchApi((t) => t.announce(p.message, p.color));
    },
  },
  {
    id: 'twitch.chatMode',
    category: 'Twitch',
    label: 'Chat mode (emote-only, followers, subs, slow...)',
    description: 'Turn a chat restriction on or off. The button lights up while it is on.',
    icon: '🔒',
    needs: 'twitch',
    params: [
      { key: 'mode', label: 'Mode', type: 'select', default: 'emote', options: Object.entries(MODES).map(([k, m]) => [k, m.label]) },
      { key: 'action', label: 'Action', type: 'select', default: 'toggle', options: TOGGLE },
      { key: 'followerMinutes', label: 'Must have followed for (minutes)', type: 'number', min: 0, max: 129600, default: 0, help: '0 = any follower.', showIf: { key: 'mode', in: ['followers'] } },
      { key: 'slowSeconds', label: 'Seconds between messages', type: 'number', min: 3, max: 120, default: 30, showIf: { key: 'mode', in: ['slow'] } },
    ],
    state: (p) => (MODES[p.mode] ? MODES[p.mode].state : null),
    defaults: { label: 'Emote-only', icon: '😀', color: '#4a5568', colorOn: '#6b46c1', labelOn: 'Emote-only ON' },
    async run(p, ctx) {
      const m = MODES[p.mode];
      if (!m) throw new Error('Pick a chat mode');
      let on;
      if (p.action === 'on') on = true;
      else if (p.action === 'off') on = false;
      else {
        let known = ctx.hub.eval(m.state);
        if (known === undefined) {
          const s = await ctx.twitchApi((t) => t.getChatSettings());
          known = Boolean(s && s[m.field]);
        }
        on = !known;
      }
      const patch = { [m.field]: on };
      if (on && p.mode === 'followers') patch.follower_mode_duration = Math.max(0, Math.round(Number(p.followerMinutes) || 0));
      if (on && p.mode === 'slow') patch.slow_mode_wait_time = Math.max(3, Math.min(120, Math.round(Number(p.slowSeconds) || 30)));
      await ctx.twitchApi((t) => t.setChatSettings(patch));
      ctx.refreshTwitch();
    },
  },
  {
    id: 'twitch.shield',
    category: 'Twitch',
    label: 'Shield mode (protection)',
    description: "Turns Twitch's Shield Mode on or off. It applies your pre-set moderation rules instantly (raid protection).",
    icon: '🛡️',
    needs: 'twitch',
    params: [{ key: 'action', label: 'Action', type: 'select', default: 'toggle', options: TOGGLE }],
    state: () => 'twitch.shield',
    defaults: { label: 'Shield', icon: '🛡️', color: '#4a5568', colorOn: '#c53030', labelOn: 'SHIELD ON', confirm: 'hold' },
    async run(p, ctx) {
      let on;
      if (p.action === 'on') on = true;
      else if (p.action === 'off') on = false;
      else {
        const known = ctx.hub.eval('twitch.shield');
        on = known === undefined ? !(await ctx.twitchApi((t) => t.getShield())) : !known;
      }
      await ctx.twitchApi((t) => t.setShield(on));
      ctx.refreshTwitch();
    },
  },
  {
    id: 'twitch.adSnooze',
    category: 'Twitch',
    label: 'Snooze next ad',
    description: 'Pushes your next ad break back (Twitch limits how many snoozes you get).',
    icon: '⏰',
    needs: 'twitch',
    params: [],
    defaults: { label: 'Snooze ad', icon: '⏰', color: '#6b46c1' },
    async run(p, ctx) {
      const r = await ctx.twitchApi((t) => t.snoozeAd());
      ctx.refreshTwitch();
      if (r) ctx.toast(`Ad snoozed. ${r.snooze_count} snooze${r.snooze_count === 1 ? '' : 's'} left.`, 'info');
    },
  },
  {
    id: 'twitch.adRun',
    category: 'Twitch',
    label: 'Run an ad break',
    description: 'Starts a commercial break now.',
    icon: '📺',
    needs: 'twitch',
    params: [{ key: 'length', label: 'Length', type: 'select', default: '30', options: [['30', '30 seconds'], ['60', '1 minute'], ['90', '1.5 minutes'], ['120', '2 minutes'], ['150', '2.5 minutes'], ['180', '3 minutes']] }],
    defaults: { label: 'Run ad', icon: '📺', color: '#9b2c2c', confirm: 'hold' },
    async run(p, ctx) {
      const r = await ctx.twitchApi((t) => t.startCommercial(Number(p.length)));
      ctx.refreshTwitch();
      if (r && r.message) ctx.toast(r.message, 'info');
    },
  },
  {
    id: 'twitch.clearChat',
    category: 'Twitch',
    label: 'Clear chat',
    description: 'Removes all messages from chat.',
    icon: '🧹',
    needs: 'twitch',
    params: [],
    defaults: { label: 'Clear chat', icon: '🧹', color: '#9b2c2c', confirm: 'hold' },
    async run(p, ctx) {
      await ctx.twitchApi((t) => t.clearChat());
    },
  },
  {
    id: 'twitch.marker',
    category: 'Twitch',
    label: 'Stream marker',
    description: 'Drops a marker at this moment of your live stream so you can find it later.',
    icon: '📍',
    needs: 'twitch',
    params: [{ key: 'description', label: 'Note (optional)', type: 'text', placeholder: 'Funny moment' }],
    defaults: { label: 'Marker', icon: '📍', color: '#6b46c1' },
    async run(p, ctx) {
      await ctx.twitchApi((t) => t.createMarker(p.description));
      ctx.toast('Marker added.', 'info');
    },
  },
  {
    id: 'twitch.clip',
    category: 'Twitch',
    label: 'Create a clip',
    description: 'Clips the last moments of your live stream.',
    icon: '🎞️',
    needs: 'twitch',
    params: [],
    defaults: { label: 'Clip it', icon: '🎞️', color: '#6b46c1' },
    async run(p, ctx) {
      const r = await ctx.twitchApi((t) => t.createClip());
      ctx.toast(r && r.edit_url ? `Clip created: ${r.edit_url}` : 'Clip created.', 'info');
    },
  },
  {
    id: 'twitch.raid',
    category: 'Twitch',
    label: 'Start a raid',
    description: 'Sends your viewers to another channel.',
    icon: '🚀',
    needs: 'twitch',
    params: [{ key: 'channel', label: 'Channel name', type: 'text', required: true, placeholder: 'somestreamer' }],
    defaults: { label: 'Raid', icon: '🚀', color: '#9b2c2c', confirm: 'hold' },
    async run(p, ctx) {
      const u = await ctx.twitchApi((t) => t.raid(p.channel));
      ctx.toast(`Raid to ${u.display_name} started.`, 'info');
    },
  },
  {
    id: 'twitch.shoutout',
    category: 'Twitch',
    label: 'Shout out a channel',
    description: 'Gives another streamer a shoutout in your chat.',
    icon: '🙌',
    needs: 'twitch',
    params: [{ key: 'channel', label: 'Channel name', type: 'text', required: true, placeholder: 'somestreamer' }],
    defaults: { label: 'Shoutout', icon: '🙌', color: '#6b46c1' },
    async run(p, ctx) {
      const u = await ctx.twitchApi((t) => t.shoutout(p.channel));
      ctx.toast(`Shouted out ${u.display_name}.`, 'info');
    },
  },
  {
    id: 'twitch.channel',
    category: 'Twitch',
    label: 'Change title / category',
    description: 'Updates your stream title and/or game category.',
    icon: '✏️',
    needs: 'twitch',
    params: [
      { key: 'title', label: 'Title (optional)', type: 'text' },
      { key: 'category', label: 'Category (optional)', type: 'text', placeholder: 'VRChat' },
    ],
    defaults: { label: 'Set title', icon: '✏️', color: '#6b46c1' },
    async run(p, ctx) {
      await ctx.twitchApi((t) => t.setChannel({ title: p.title, game: p.category }));
      ctx.toast('Channel updated.', 'info');
    },
  },
];

module.exports = actions;
module.exports.MODES = MODES;
