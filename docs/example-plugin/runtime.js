// The live part: polls the (fake) weather API while something needs it, publishes state, answers the
// action and widget. Structurally the same shape as plugins/obs/runtime.js or plugins/spotify/runtime.js —
// just with a made-up API instead of a real one, so this example runs with no real account.
const POLL_MS = 60000;

// Stands in for a real HTTP call to something like api.openweathermap.org. A real plugin would do:
//   const res = await fetch(`https://api.example.com/weather?city=${encodeURIComponent(city)}&key=${apiKey}`);
//   if (!res.ok) throw new Error(`Weather API said ${res.status}`);
//   const data = await res.json();
//   return { tempC: data.main.temp, condition: data.weather[0].main };
async function fetchWeather(apiKey, city) {
  if (!apiKey) throw new Error('No API key set (Settings → Connections → Weather (example))');
  // A believable, deterministic "reading" so the example is useful without a network call.
  const seed = [...city].reduce((n, c) => n + c.charCodeAt(0), 0);
  return { tempC: 10 + (seed % 25), condition: ['Clear', 'Cloudy', 'Rain'][seed % 3] };
}

class WeatherRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.timer = null;
    this.data = { available: false, error: '', tempC: null, condition: '' };
  }

  // settings() changed (the user edited the API key, city, or threshold). Nothing to reconnect here since
  // every poll reads settings() fresh anyway — but a plugin with a persistent connection (a socket, like
  // OBS) would close and reopen it here if the host/port actually changed.
  configure() {}

  // needs.weather is true while a button/trigger/widget actually uses this plugin (see matchState in
  // plugin.js and the widget's needs() in widgets.js) — so it never polls for nothing.
  sync(needs) {
    if (needs.weather) this.start(); else this.stop();
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.data = { available: false, error: '', tempC: null, condition: '' };
    this.hub.remove('weather.hot');
  }

  status() {
    return { state: this.data.available ? 'connected' : this.data.error ? 'error' : 'connecting', error: this.data.error };
  }

  async poll() {
    const { apiKey, city, hotAboveC } = this.ctx.settings();
    try {
      const { tempC, condition } = await fetchWeather(apiKey, city || 'London');
      this.data = { available: true, error: '', tempC, condition };
      this.hub.set('weather.hot', tempC >= (hotAboveC ?? 25));
    } catch (err) {
      this.data = { available: false, error: err.message, tempC: null, condition: '' };
      this.hub.remove('weather.hot');
    }
    this.ctx.emitStatus();
  }

  // Called by the action (weather.announce) and the widget (weather.js) below.
  snapshot() {
    return this.data;
  }
}

module.exports = { WeatherRuntime };
