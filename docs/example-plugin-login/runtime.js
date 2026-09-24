// Thin glue between the client (client.js, the reusable login logic) and the plugin contract
// (createRuntime(ctx) — see ../PLUGIN-GUIDE.md). Compare plugins/spotify/runtime.js: same shape.
const { ExampleLoginClient } = require('./client');

class ExampleLoginRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.hub = ctx.hub;
    this.client = new ExampleLoginClient({ secrets: ctx.secrets });
    this.client.on('status', () => { this.hub.set('example-login.connected', this.client.isConnected()); this.ctx.emitStatus(); });
    this.hub.set('example-login.connected', this.client.isConnected());
  }

  status() {
    return this.client.info();
  }

  // ---- the browser calls these by name (see plugin.js's clientMethods) ----
  async connect() {
    return this.client.connect();
  }

  async disconnect() {
    return this.client.disconnect();
  }

  stop() {
    this.client.stop();
  }
}

module.exports = { ExampleLoginRuntime };
