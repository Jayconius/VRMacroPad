const MODES = [['toggle', 'Switch each press'], ['on', 'Turn on'], ['off', 'Turn off']];
// One List dropdown for voices; it starts on the complete list. Your own voice soundboards are made in Settings → Plugins → Voicemod.
const VOICE_LIST = { key: 'list', label: 'List', type: 'select', optionsFrom: 'voicemod.voiceLists', default: 'all', help: 'All voices, only the ones that come with Voicemod, or only the ones you added from its Community tab.' };

function switchAction({ id, which, label, description, icon, key, on, off, colorOn, labelOn }) {
  return {
    id,
    category: 'Voicemod',
    label,
    description,
    icon,
    needs: 'voicemod',
    params: [{ key: 'mode', label: 'Do this', type: 'select', default: 'toggle', options: MODES }],
    state: () => key,
    defaults: { label: label.split(' (')[0], icon, color: '#4a5568', colorOn, labelOn },
    async run(p, ctx) {
      const value = await ctx.plugin('voicemod').setSwitch(which, p.mode || 'toggle');
      ctx.toast(value ? on : off, 'info');
    },
  };
}

module.exports = [
  {
    id: 'voicemod.voice',
    category: 'Voicemod',
    label: 'Change voice',
    description: 'Switches Voicemod to one of your voices. The button lights up while that voice is the one in use.',
    icon: '🎭',
    needs: 'voicemod',
    params: [
      VOICE_LIST,
      { key: 'voice', label: 'Voice', type: 'select', optionsFrom: 'voicemod.voices', optionsFilter: ['list'], allowCustom: true, required: true, help: 'Click and pick, or start typing to find a voice.' },
    ],
    state: (p) => (p.voice ? `voicemod.voice=${p.voice}` : null),
    defaults: { label: 'Voice', icon: '🎭', color: '#4a5568', colorOn: '#6b46c1' },
    async run(p, ctx) {
      await ctx.plugin('voicemod').loadVoice(p.voice);
      ctx.toast(`Voicemod voice: ${String(p.voice).trim()}`, 'info');
    },
  },
  switchAction({ id: 'voicemod.changer', which: 'changer', label: 'Voice changer on / off', description: 'Turns the Voicemod voice changer on or off. The button lights up while it is on.', icon: '🎚️', key: 'voicemod.voiceChanger', on: 'Voicemod voice changer on', off: 'Voicemod voice changer off', colorOn: '#6b46c1', labelOn: 'Voice on' }),
  switchAction({ id: 'voicemod.mute', which: 'mic', label: 'Mute microphone (in Voicemod)', description: 'Mutes or unmutes your microphone inside Voicemod. The button lights up while you are muted.', icon: '🎙️', key: 'voicemod.micMuted', on: 'Voicemod microphone muted', off: 'Voicemod microphone on', colorOn: '#c53030', labelOn: 'VM muted' }),
  switchAction({ id: 'voicemod.hear', which: 'hear', label: 'Hear myself on / off', description: 'Turns Voicemod\'s "hear my voice" monitoring on or off. The button lights up while it is on.', icon: '👂', key: 'voicemod.hearMyself', on: 'You can hear yourself', off: 'You cannot hear yourself', colorOn: '#2b6cb0', labelOn: 'Hearing' }),
  switchAction({ id: 'voicemod.background', which: 'background', label: 'Background effects on / off', description: 'Turns Voicemod\'s background effects on or off. The button lights up while they are on.', icon: '🌧️', key: 'voicemod.background', on: 'Voicemod background effects on', off: 'Voicemod background effects off', colorOn: '#2f855a', labelOn: 'BG on' }),
  {
    id: 'voicemod.random',
    category: 'Voicemod',
    label: 'Random voice',
    description: 'Picks a random Voicemod voice, from all of them or from one list.',
    icon: '🎲',
    needs: 'voicemod',
    params: [{ ...VOICE_LIST, label: 'Pick from', help: 'All voices lets Voicemod choose. Any other list is picked from here.' }],
    defaults: { label: 'Random voice', icon: '🎲', color: '#4a5568' },
    async run(p, ctx) {
      const name = await ctx.plugin('voicemod').randomVoice(p.list || 'all');
      ctx.toast(name ? `Random Voicemod voice: ${name}` : 'Picked a random Voicemod voice', 'info');
    },
  },
  {
    id: 'voicemod.sound',
    category: 'Voicemod',
    label: 'Play a Voicemod sound',
    description: 'Plays one of your Voicemod sounds. A sound that only plays while held plays briefly.',
    icon: '🔊',
    needs: 'voicemod',
    params: [
      { key: 'list', label: 'List', type: 'select', optionsFrom: 'voicemod.soundLists', default: 'all', help: 'All sounds, or one soundboard (yours first, then Voicemod\'s). New soundboard missing? Play one of its sounds in Voicemod, then press ⟳: Voicemod only tells other apps about a new soundboard once a sound on it has been played.' },
      { key: 'sound', label: 'Sound', type: 'select', optionsFrom: 'voicemod.sounds', optionsFilter: ['list'], allowCustom: true, required: true, help: 'Click and pick, or start typing to find a sound. New sound missing? Play it once in Voicemod, then press ⟳: Voicemod only tells other apps about a sound after it has been played.' },
    ],
    defaults: { label: 'Sound', icon: '🔊', color: '#4a5568' },
    async run(p, ctx) {
      await ctx.plugin('voicemod').playSound(p.sound);
      ctx.toast('Played a Voicemod sound', 'info');
    },
  },
  {
    id: 'voicemod.stopSounds',
    category: 'Voicemod',
    label: 'Stop all Voicemod sounds',
    description: 'Stops every soundboard sound that is playing.',
    icon: '⏹️',
    needs: 'voicemod',
    params: [],
    defaults: { label: 'Stop sounds', icon: '⏹️', color: '#4a5568' },
    async run(p, ctx) {
      await ctx.plugin('voicemod').stopSounds();
      ctx.toast('Stopped the Voicemod sounds', 'info');
    },
  },
];
