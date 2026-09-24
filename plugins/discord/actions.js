const { spawn } = require('child_process');
const { parseCombo } = require('../../src/core/keys');
const { fill, usesScene } = require('./text');

const fs = require('fs');
const path = require('path');
const { fillVrchat, publicOnly } = require('./vrchat');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Where Steam (and SteamVR) keep screenshots: one folder per game. {steam} is looked up on this PC.
const STEAM_SHOTS = path.join('{steam}', 'userdata', '*', '760', 'remote', '*', 'screenshots');

// Warnings shown at the top of the editor for the actions that can post pictures of other people.
const PRIVACY_NOTICE = {
  key: 'privacyNotice', type: 'notice', title: 'Careful with private pictures',
  text: 'This posts a picture to a Discord channel that other people can see. In private or adult (18+) instances a picture can show other people or explicit content. Check who is in it, and who can see the channel, before you send. Never post someone\'s picture without their OK.',
};
const VRCHAT_NOTICE = {
  key: 'privacyNotice', type: 'notice', title: 'Careful: private and adult instances',
  text: 'This posts your newest VRChat photo. Photos taken in private or adult (18+) instances can show other people, and posting them to a public channel can break that instance\'s rules or expose people who did not agree to it. Check the picture and the channel every time.',
};
const AUTOSHARE_NOTICE = {
  key: 'privacyNotice', type: 'notice', title: 'This posts pictures automatically, with no chance to check them',
  text: 'Every new screenshot (and VRChat photo, if you switch that on) is posted the moment it is saved. Do not leave it on in private or adult (18+) instances, or anywhere people have not agreed to be photographed, and do not point it at a public channel unless you mean it. Tip: make a second button set to "Turn off" so you can stop it instantly.',
};

// VRChat details for captions and a safety net (read from VRChat's own files, no login).
const VRC_WORDS = '{world}, {players}, {instance} and {region} come from VRChat while it is running.';
const ONLY_PUBLIC = { key: 'onlyPublic', label: 'Only send from public instances', type: 'boolean', default: false, help: 'A safety net: nothing is sent while you are in a Friends, Invite or Group instance, or when VRChat cannot tell where you are. Off by default.' };
const procsOf = (ctx) => () => ctx.helper.call('proc.list');

// ---- shared pieces ----
const CHANNEL = { key: 'channel', label: 'Channel', type: 'select', optionsFrom: 'discord.channels', emptyLabel: 'Main channel', help: 'Which webhook to post through. Set up to four in Settings → Plugins → Discord.' };
const MENTIONS = { key: 'mentions', label: 'Who can be pinged', type: 'select', default: 'none', options: [['none', 'Nobody (safest)'], ['people', 'People and roles'], ['everyone', '@everyone and @here too']], help: 'Typing @everyone in the message only pings when this allows it.' };
const OPEN = { key: 'openDiscord', label: 'Start Discord first if it is not running', type: 'boolean', default: false };

// Starts the Discord app (and waits for it to appear) when the button asks for that.
async function ensureDiscord(p, ctx) {
  if (!p.openDiscord) return;
  const running = async () => (await ctx.helper.call('proc.list')).includes('discord.exe');
  if (await running()) return;
  spawn('cmd.exe', ['/c', 'start', '', 'discord://'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (await running()) { await sleep(1500); return; }
  }
  throw new Error('Discord did not start. Is it installed?');
}

const hexColor = (text) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(text || '').trim());
  return m ? parseInt(m[1], 16) : 0x5865f2;
};
const webLink = (label, v) => {
  const t = String(v || '').trim();
  if (!t) return '';
  if (!/^https?:\/\//i.test(t)) throw new Error(`${label} must start with http:// or https://`);
  return t;
};

// Posts for the "post something" actions: the toast, the state key and the Open-Discord step are the same.
async function post(p, ctx, opts) {
  await ensureDiscord(p, ctx);
  await ctx.plugin('discord').send({ channel: p.channel, mentions: p.mentions, username: p.username, ...opts });
  ctx.toast('Sent to Discord', 'info');
}

// A shortcut action: presses the key set in Settings (Discord must have the same one set as a global keybind).
function keyAction({ id, label, description, icon, setting, defaultKey, color }) {
  return {
    id,
    category: 'Discord app',
    label,
    description,
    icon,
    params: [
      { key: 'keys', label: 'Shortcut', type: 'keys', help: `Leave empty to use the one from Settings → Plugins → Discord${defaultKey ? ` (${defaultKey})` : ''}. Record a different one here for just this button.` },
      OPEN,
    ],
    defaults: { label, icon, color },
    async run(p, ctx) {
      const combo = String(p.keys || '').trim() || String(ctx.plugin('discord').setting(setting) || '').trim();
      if (!combo) throw new Error(`No shortcut set. Record one in Settings → Plugins → Discord, or on this button.`);
      await ensureDiscord(p, ctx);
      const { vks } = parseCombo(combo);
      await ctx.helper.call('keys.combo', { vks, holdMs: 50, scan: false });
    },
  };
}

module.exports = [
  {
    id: 'discord.send',
    category: 'Discord',
    label: 'Send a message',
    needs: (p) => (usesScene(p.message) ? { obs: true } : {}), // {scene} is read from OBS, so OBS is connected when it is used
    description: 'Posts a premade message to a Discord channel, e.g. "I\'m live!". {time}, {date}, {song}, {artist} and {scene} are filled in when you press.',
    icon: '💬',
    params: [
      { key: 'message', label: 'Message', type: 'textarea', required: true, placeholder: "I'm live now! 🔴", help: 'Up to 2000 characters. Discord formatting works (**bold**, links). You can use {time}, {date}, {song}, {artist}, {track} and {scene}.' },
      CHANNEL,
      MENTIONS,
      { key: 'username', label: 'Post as (optional)', type: 'text', placeholder: 'Uses the name from Settings', help: 'The name shown next to this message.' },
      OPEN,
    ],
    state: () => 'discord.lastOk',
    defaults: { label: 'Announce', icon: '💬', color: '#4a5568', colorOn: '#5865f2' },
    async run(p, ctx) {
      if (!String(p.message || '').trim()) throw new Error('Type a message first.');
      await post(p, ctx, { content: fill(p.message, ctx) });
    },
  },
  {
    id: 'discord.embed',
    category: 'Discord',
    label: 'Send a card (embed)',
    needs: (p) => (usesScene(p.title, p.description, p.footer, p.message) ? { obs: true } : {}),
    description: 'Posts a rich card with a title, text, link and picture: a good "I\'m live" announcement with your Twitch link.',
    icon: '🪧',
    params: [
      { key: 'title', label: 'Title', type: 'text', required: true, placeholder: "I'm live on Twitch!" },
      { key: 'description', label: 'Text', type: 'textarea', placeholder: 'Playing VRChat, come hang out!', help: 'You can use {time}, {date}, {song}, {artist}, {track} and {scene}.' },
      { key: 'url', label: 'Link on the title', type: 'text', placeholder: 'https://twitch.tv/yourname', help: 'People click the title to open it.' },
      { key: 'imageUrl', label: 'Big picture (link)', type: 'text', placeholder: 'https://…/image.png', help: 'A link to an image on the web (not a file on your PC; use "Send a picture" for that).' },
      { key: 'thumbnailUrl', label: 'Small picture (link)', type: 'text', placeholder: 'https://…/logo.png' },
      { key: 'color', label: 'Side color', type: 'text', default: '#9146ff', help: 'A hex color, like #9146ff (Twitch purple).' },
      { key: 'footer', label: 'Small footer text', type: 'text', placeholder: 'Sent from VR Macro Pad' },
      { key: 'message', label: 'Message above the card (optional)', type: 'text', placeholder: '@everyone I\'m live!', help: 'Plain text shown above the card. Pings only work if you allow them below.' },
      CHANNEL,
      MENTIONS,
      OPEN,
    ],
    state: () => 'discord.lastOk',
    defaults: { label: 'Go live post', icon: '🪧', color: '#4a5568', colorOn: '#9146ff' },
    async run(p, ctx) {
      if (!String(p.title || '').trim()) throw new Error('Give the card a title.');
      const embed = { title: fill(p.title, ctx).slice(0, 256), color: hexColor(p.color) };
      if (p.description) embed.description = fill(p.description, ctx).slice(0, 4096);
      const link = webLink('The title link', p.url); if (link) embed.url = link;
      const img = webLink('The big picture link', p.imageUrl); if (img) embed.image = { url: img };
      const thumb = webLink('The small picture link', p.thumbnailUrl); if (thumb) embed.thumbnail = { url: thumb };
      if (p.footer) embed.footer = { text: fill(p.footer, ctx).slice(0, 2048) };
      await post(p, ctx, { content: fill(p.message || '', ctx), embeds: [embed] });
    },
  },
  {
    id: 'discord.file',
    category: 'Discord',
    label: 'Send last Steam screenshot to Discord (or any picture)',
    description: 'Posts your newest Steam screenshot to a Discord channel. Or the last OBS screenshot, the newest picture in any folder, or one specific file. Take the screenshot first, then press this.',
    icon: '🖼️',
    params: [
      PRIVACY_NOTICE,
      { key: 'source', label: 'Send', type: 'select', default: 'steam', options: [['steam', 'My last Steam screenshot (any game, SteamVR too)'], ['obs', 'The last OBS screenshot (take one with "Take a screenshot (OBS)" first)'], ['newest', 'The newest picture in a folder'], ['file', 'One specific file']] },
      { key: 'path', label: 'Folder or file', type: 'text', placeholder: '{vrchat}', showIf: { key: 'source', in: ['newest', 'file'] }, help: '{vrchat}, {steam} and {pictures} are looked up on this PC. A * stands for any folder name and sub-folders are searched.' },
      { key: 'message', label: 'Caption (optional)', type: 'text', help: 'You can use {time} and {date}.' },
      CHANNEL,
      MENTIONS,
      OPEN,
    ],
    state: () => 'discord.lastOk',
    defaults: { label: 'Share Steam shot', icon: '🖼️', color: '#4a5568', colorOn: '#5865f2', confirm: 'hold' },
    async run(p, ctx) {
      const rt = ctx.plugin('discord');
      let file;
      if (!p.source || p.source === 'steam') {
        try { file = rt.newestPicture('newest', STEAM_SHOTS); } catch {
          throw new Error('No Steam screenshots found. Take one first (Steam\'s screenshot key), or set the Steam folder in Settings → Plugins → Discord.');
        }
      } else if (p.source === 'obs') {
        let last = '';
        try { last = ctx.plugin('obs').lastScreenshot || ''; } catch { /* the OBS plugin is switched off */ }
        if (!last || !fs.existsSync(last)) throw new Error('No OBS screenshot yet. Press a "Take a screenshot (OBS)" button first (put it before this step on the same button to do both at once).');
        file = last;
      } else {
        if (!String(p.path || '').trim()) throw new Error('Choose a folder or file first.');
        file = rt.newestPicture(p.source === 'file' ? 'file' : 'newest', p.path);
      }
      await post(p, ctx, { content: await fillVrchat(p.message || '', ctx, { procs: procsOf(ctx), file }), file });
    },
  },
  {
    id: 'discord.vrchat',
    category: 'Discord',
    label: 'Send the last VRChat photo',
    description: 'Posts the newest photo VRChat saved, with the world, players and instance in the caption if you like. Take the photo in VRChat, then press this. Careful in private or adult instances: check who is in the photo and who can see the channel.',
    icon: '📷',
    params: [
      VRCHAT_NOTICE,
      { key: 'message', label: 'Caption (optional)', type: 'text', placeholder: 'Look at this world! {world} ({players} players)', help: `${VRC_WORDS} Also {time} and {date}.` },
      ONLY_PUBLIC,
      CHANNEL,
      MENTIONS,
      OPEN,
    ],
    state: () => 'discord.lastOk',
    defaults: { label: 'VRChat photo', icon: '📷', color: '#4a5568', colorOn: '#5865f2', confirm: 'hold' },
    async run(p, ctx) {
      const rt = ctx.plugin('discord');
      let file;
      try { file = rt.newestPicture('newest', '{vrchat}'); } catch {
        throw new Error('No VRChat photos found. Take one in VRChat first, or set the VRChat photo folder in Settings → Plugins → Discord.');
      }
      if (p.onlyPublic) { const g = await publicOnly({ procs: procsOf(ctx) }); if (!g.ok) throw new Error(g.reason); }
      await post(p, ctx, { content: await fillVrchat(p.message || '', ctx, { procs: procsOf(ctx), file }), file });
    },
  },
  {
    id: 'discord.autoshare',
    category: 'Discord',
    label: 'Share new screenshots automatically',
    description: 'Turns automatic sharing on or off. While on, every new Steam screenshot (and, if you choose, every new VRChat photo) is posted to Discord the moment it is saved. It always starts off when the app starts. Do not leave it on in private or adult instances.',
    icon: '📸',
    params: [
      AUTOSHARE_NOTICE,
      { key: 'mode', label: 'Do this', type: 'select', default: 'toggle', options: [['toggle', 'Switch on/off each press'], ['on', 'Turn on'], ['off', 'Turn off']] },
      { key: 'steamShots', label: 'Share new Steam screenshots', type: 'boolean', default: true, help: 'Screenshots from any Steam game, SteamVR included.' },
      { key: 'channel', label: 'Post Steam screenshots to', type: 'select', optionsFrom: 'discord.channels', emptyLabel: 'The channel chosen in Settings (or the main channel)', help: 'Which of your channels gets the pictures. Pick a private one unless you mean it to be public.', showIf: { key: 'steamShots', in: [true] } },
      { key: 'vrchat', label: 'Share new VRChat photos', type: 'boolean', default: false, help: 'For an event: every photo taken in VRChat is posted as it is saved. Off by default. Never leave this on in private or adult (18+) instances.' },
      { ...ONLY_PUBLIC, showIf: { key: 'vrchat', in: [true] } },
      { key: 'vrchatChannel', label: 'Post VRChat photos to', type: 'select', optionsFrom: 'discord.channels', emptyLabel: 'The channel chosen in Settings (or the main channel)', help: 'Send VRChat photos somewhere else, such as an event channel.', showIf: { key: 'vrchat', in: [true] } },
      { key: 'message', label: 'Caption (optional)', type: 'text', placeholder: 'e.g. New screenshot at {time}', help: `{time} and {date} work here; ${VRC_WORDS}` },
      OPEN,
    ],
    state: () => 'discord.autoShare',
    defaults: { label: 'Auto-share', labelOn: 'Sharing', icon: '📸', color: '#4a5568', colorOn: '#c53030' },
    async run(p, ctx) {
      const rt = ctx.plugin('discord');
      const on = p.mode === 'on' ? true : p.mode === 'off' ? false : !rt.share.on;
      const opts = { steam: p.steamShots !== false, vrchat: Boolean(p.vrchat), onlyPublic: Boolean(p.onlyPublic), channel: p.channel || '', vrchatChannel: p.vrchatChannel || '', caption: p.message || '' };
      if (on) {
        if (!opts.steam && !opts.vrchat) throw new Error('Switch on at least one: Steam screenshots or VRChat photos.');
        if (!(opts.steam && rt.folders().length) && !(opts.vrchat && rt.vrchatFolders().length)) throw new Error(opts.steam ? 'No screenshot folders found. Check the Steam folder, or add a folder, in Settings → Plugins → Discord.' : 'No VRChat photo folder found. Take a photo in VRChat first, or set the folder in Settings → Plugins → Discord.');
        if (!rt.channels().length) throw new Error('Paste your Webhook URL first (Settings → Plugins → Discord).');
        await ensureDiscord(p, ctx);
      }
      rt.setAutoShare(on, opts);
      if (on) {
        const label = (id) => (rt.channels().find((c) => c.value === (id || rt.setting('autoChannel') || 'main')) || {}).label || 'Discord';
        const what = opts.steam && opts.vrchat ? `new screenshots and VRChat photos go to ${label(opts.channel)}${opts.vrchatChannel ? ` (VRChat photos: ${label(opts.vrchatChannel)})` : ''}`
          : opts.vrchat ? `new VRChat photos go to ${label(opts.vrchatChannel || opts.channel)}` : `new screenshots go to ${label(opts.channel)}`;
        ctx.toast(`Sharing ON: ${what}. Turn it off before private or adult instances.`, 'warn');
      } else ctx.toast('Stopped sharing screenshots', 'info');
    },
  },
  keyAction({ id: 'discord.mute', label: 'Toggle mute', description: 'Presses your Discord mute shortcut. In Discord: Settings → Keybinds → add "Toggle Mute" and choose the same shortcut (turn on "Global" so it works in games).', icon: '🎙️', setting: 'muteKey', defaultKey: 'ctrl+shift+m', color: '#2f855a' }),
  keyAction({ id: 'discord.deafen', label: 'Toggle deafen', description: 'Presses your Discord deafen shortcut. In Discord: Settings → Keybinds → add "Toggle Deafen" and choose the same shortcut (turn on "Global").', icon: '🎧', setting: 'deafenKey', defaultKey: 'ctrl+shift+d', color: '#9b2c2c' }),
  keyAction({ id: 'discord.talk', label: 'Push to talk / mic key', description: 'Presses the shortcut you set for push-to-talk (or any other Discord keybind). It taps the key; it cannot hold it while you hold the button.', icon: '🗣️', setting: 'talkKey', defaultKey: '', color: '#3b5b8f' }),
];
