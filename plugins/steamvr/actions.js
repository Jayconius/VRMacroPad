// Battery + start/quit/restart + live picture settings (supersampling, motion smoothing, brightness, bounds,
// performance graph, recenter, dim the view). Split across two files that were src/core/actions/{system,steamvr}.js.
module.exports = [...require('./actions-launch'), ...require('./actions-settings')];
