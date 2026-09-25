const MODE = { key: 'mode', label: 'Do this', type: 'select', default: 'toggle' };

module.exports = [
  {
    id: 'ts3.mic',
    category: 'TeamSpeak 3',
    label: 'Mute / unmute your microphone',
    description: 'Switches your own TeamSpeak 3 microphone mute. The button lights up while you are muted, following the real state, even if you change it in TeamSpeak itself.',
    icon: '🎙️',
    needs: 'ts3',
    params: [{ ...MODE, options: [['toggle', 'Switch each press'], ['on', 'Mute'], ['off', 'Unmute']] }],
    state: () => 'ts3.micMuted',
    defaults: { label: 'TS mic', icon: '🎙️', color: '#2f855a', colorOn: '#c53030', labelOn: 'TS muted' },
    async run(p, ctx) {
      const muted = await ctx.plugin('ts3').set('mic', p.mode || 'toggle');
      ctx.toast(muted ? 'TeamSpeak microphone muted' : 'TeamSpeak microphone on', 'info');
    },
  },
  {
    id: 'ts3.speakers',
    category: 'TeamSpeak 3',
    label: 'Mute / unmute your speakers (deafen)',
    description: 'Switches your own TeamSpeak 3 speaker mute (deafen), so you hear nobody. The button lights up while it is on.',
    icon: '🎧',
    needs: 'ts3',
    params: [{ ...MODE, options: [['toggle', 'Switch each press'], ['on', 'Deafen'], ['off', 'Undeafen']] }],
    state: () => 'ts3.speakersMuted',
    defaults: { label: 'TS deafen', icon: '🎧', color: '#4a5568', colorOn: '#c53030', labelOn: 'TS deaf' },
    async run(p, ctx) {
      const deaf = await ctx.plugin('ts3').set('speakers', p.mode || 'toggle');
      ctx.toast(deaf ? 'TeamSpeak speakers muted' : 'TeamSpeak speakers on', 'info');
    },
  },
  {
    id: 'ts3.away',
    category: 'TeamSpeak 3',
    label: 'Set yourself away / back',
    description: 'Marks you as away on TeamSpeak 3 (with an optional message) or back again. The button lights up while you are away.',
    icon: '💤',
    needs: 'ts3',
    params: [
      { ...MODE, options: [['toggle', 'Switch each press'], ['on', 'Away'], ['off', 'Back']] },
      { key: 'message', label: 'Away message (optional)', type: 'text', placeholder: 'Back in 5' },
    ],
    state: () => 'ts3.away',
    defaults: { label: 'TS away', icon: '💤', color: '#4a5568', colorOn: '#b7791f', labelOn: 'Away' },
    async run(p, ctx) {
      const away = await ctx.plugin('ts3').set('away', p.mode || 'toggle', p.message);
      ctx.toast(away ? 'You are away on TeamSpeak' : 'You are back on TeamSpeak', 'info');
    },
  },
];
