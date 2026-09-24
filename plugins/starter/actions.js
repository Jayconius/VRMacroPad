// Every non-integration action: audio, keyboard & system, media control, and webhooks. Split into the same
// files the old src/core/actions/ used, just under one plugin now.
module.exports = [...require('./audio'), ...require('./system'), ...require('./media')];
