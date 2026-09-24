// Turns the two text lines of a Discord notification into something a widget can show.
//
// Layouts seen from the real Discord app:
//   'Nova'                                  / 'what general?'         a direct message
//   'Nova (#general, Text channels)'        / '@everyone'             a channel message ("Text channels" is the category)
//   'Your event is starting in The Nova Hub' / '"asdasd". Join in!'    a server event
// Anything else is kept whole as kind 'other', so an unfamiliar layout still shows something readable.
//
// Result: { kind, type, sender, channel, where, title, text, everyone, mention }
//   kind     'dm' | 'channel' | 'event' | 'other'          how it was laid out
//   type     'event' | 'everyone' | 'mention' | 'channel' | 'dm' | 'other'   what it is to you (used by filters)
//   everyone the text pings @everyone or @here
//   mention  the text mentions you (only known when your Discord name is set: Discord does not say who "you" are)

// Discord wraps names in invisible direction marks (U+2066 to U+2069, U+200E, U+200F); strip them.
const clean = (s) => String(s || '').replace(/[⁦-⁩‎‏]/g, '').trim();

function parseNotification(app, rawTitle, rawBody, myName = '') {
  const title = clean(rawTitle);
  const body = clean(rawBody);
  const base = { app, kind: 'other', sender: title, channel: '', where: '', title, text: body };

  let out;
  let m = /^Your event is starting in (.+)$/i.exec(title);
  if (m) {
    const named = /^"(.*)"\.\s*Join in!?$/.exec(body);
    out = { ...base, kind: 'event', sender: m[1], text: named ? named[1] : body };
  } else if ((m = /^(.+?) \((#[^,()]+)(?:, ([^()]+))?\)$/.exec(title))) {
    out = { ...base, kind: 'channel', sender: m[1], channel: m[2], where: m[3] || '' };
  } else if (title && title.length <= 60) {
    out = { ...base, kind: 'dm' };
  } else {
    out = base;
  }

  const name = clean(myName).replace(/^@/, '').toLowerCase();
  out.everyone = out.kind !== 'event' && /(^|\s)@(everyone|here)\b/i.test(out.text);
  out.mention = out.kind !== 'event' && Boolean(name) && out.text.toLowerCase().includes(`@${name}`);
  out.type = out.kind === 'event' ? 'event' : out.everyone ? 'everyone' : out.mention ? 'mention' : out.kind === 'channel' ? 'channel' : out.kind === 'dm' ? 'dm' : 'other';
  return out;
}

module.exports = { parseNotification, clean };
