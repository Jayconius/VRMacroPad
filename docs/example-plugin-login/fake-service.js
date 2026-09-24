// Stands in for a real remote OAuth server, so this example runs end to end with no real account,
// network access, or registered app. DELETE THIS FILE in a real plugin — client.js would instead make
// real fetch() calls to your service's actual endpoints (see plugins/twitch/client.js, plugins/spotify/
// client.js and plugins/pear/client.js for the three real services this app signs into).
//
// The shape mirrors a real device-code endpoint (RFC 8628, the pattern dev.twitch.tv/console uses too):
// 1. requestCode() -> { code, userCode, verificationUri, intervalMs }
// 2. the app polls poll(code) every intervalMs
// 3. once a human "approves" it, poll() starts returning an access token instead of "still waiting"
//
// Here, "a human approves it" is simulated with a timer instead of a real person clicking Allow.
const APPROVE_AFTER_MS = 4000;

const pending = new Map(); // code -> { approvesAt, revoked }

function requestCode() {
  const code = Math.random().toString(36).slice(2, 10);
  pending.set(code, { approvesAt: Date.now() + APPROVE_AFTER_MS });
  return {
    code,
    userCode: code.toUpperCase().match(/.{1,4}/g).join('-'), // "AB12-CD34", the thing a human would type in
    verificationUri: 'https://example.com/activate', // a real plugin points this at its own service
    intervalMs: 1000,
  };
}

function poll(code) {
  const p = pending.get(code);
  if (!p) return { status: 'denied' };
  if (Date.now() < p.approvesAt) return { status: 'pending' };
  pending.delete(code);
  return { status: 'approved', accessToken: `demo-token-${code}`, user: { id: '1', login: 'demo-user', name: 'Demo User' } };
}

function revoke(accessToken) { /* a real service would invalidate it server-side */ }

module.exports = { requestCode, poll, revoke };
