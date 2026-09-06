// ===========================================================================
// App wiring. Everything that used to live in one 1507-line file is now in
// db.js, config.js, helpers.js, deviceState.js and routes/.
//
// What stays here: middleware, the two routes that must not touch the database,
// the router mounts, one error handler, and startup.
// ===========================================================================
require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const { pool } = require('./db');
const {
  WATCHDOG_TICK_MS,
  STARTUP_GRACE_MS,
  SERVER_STARTED_AT,
  MIN_PERIOD_SECONDS,
  MAX_PERIOD_SECONDS,
  MIN_SEND_SECONDS,
  MAX_SEND_SECONDS,
  OFFLINE_AFTER_MS,
  MAX_MIST_SECONDS,
  MAX_FAN_SECONDS
} = require('./config');
const { logDeviceEvent, runOfflineWatchdog } = require('./deviceState');

const app = express();

// MIDDLEWARE
app.use(cors());
// Backlog batches are the reason for the raised limit: 500 sensor rows is well
// past the 100kb default, and body-parser would 413 them before any handler ran.
app.use(express.json({ limit: '5mb' }));


// ===========================================================================
// GET / MUST KEEP RETURNING 200.
//
// It looks like a leftover health check. It is not: it is how every Pi finds
// the backend. pi_common.discovery probes each address in networkList.txt with
// route "" and takes the first that answers 200 (sensorVPD/client.py,
// sync_clock.py). Serving the dashboard here instead - or redirecting, which is
// a 302 - would make every Pi fail to discover a backend that is running fine.
//
// So the dashboard is served from /html/ below, not from /.
// ===========================================================================
app.get("/", (req, res) => {
  res.send("API is running");
});

// ===========================================================================
// The frontend, served by the backend.
//
// This is what removes the hand-edited backend IP from frontend/js/config.js -
// the single most-missed install step, called out twice in the old README. The
// page now comes from the same origin as the API, so config.js derives the base
// URL at runtime and there is nothing to edit.
//
// It also removes a second npm install and a second running process: the
// dashboard is at
//
//     http://<backend-host>:<PORT>/html/
//
// which is the same shape as the old live-server URL, with the backend's port.
// ===========================================================================
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ===========================================================================
// TIME SOURCE  (timeSyncPlan.md §3)
//
// The Pis have no RTC and no internet; this route is their clock. It must not
// touch the database - the Pi measures round-trip delay against it, so any
// latency added here lands directly on the sensors as clock error. That is why
// it is here rather than in a router.
// ===========================================================================
app.get('/api/time', (req, res) => {
  const now = Date.now();
  res.json({
    epochMs: now,
    iso: new Date(now).toISOString()
  });
});

// ===========================================================================
// One place for the numbers the frontend used to hardcode.
//
// GET /api/devices and POST /api/heartbeat already returned offlineAfterSeconds
// and the frontend ignored it in favour of its own constant. This is the whole
// set, read once at page load, so the server stays the only thing that decides
// what "too fast" and "offline" mean.
// ===========================================================================
app.get('/api/config', (req, res) => {
  res.json({
    minPeriodSeconds: MIN_PERIOD_SECONDS,
    maxPeriodSeconds: MAX_PERIOD_SECONDS,
    minSendSeconds: MIN_SEND_SECONDS,
    maxSendSeconds: MAX_SEND_SECONDS,
    offlineAfterSeconds: Math.round(OFFLINE_AFTER_MS / 1000),
    maxMistSeconds: MAX_MIST_SECONDS,
    maxFanSeconds: MAX_FAN_SECONDS,
    serverEpochMs: Date.now()
  });
});

// ROUTES
app.use('/api', require('./routes/sensors'));
app.use('/api', require('./routes/schedule'));
app.use('/api', require('./routes/devices'));
app.use('/api', require('./routes/actuators'));


// ===========================================================================
// One error handler for every route.
//
// Replaces 21 try/catch blocks ending in 17 identical 500 replies. Routes now
// throw and asyncRoute() hands the rejection here, so the error SHAPE is
// uniform: a 4xx a route raised deliberately keeps its own message, anything
// else is a 500 carrying `error`. The frontend's api() reads `message` then
// `error`, and this is the other half of that contract.
//
// Four arguments, and all four must be declared - that signature is how Express
// recognises an error handler at all.
// ===========================================================================
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;

  if (status >= 500) {
    console.error(`${req.method} ${req.originalUrl} failed:`, err);
  }

  if (res.headersSent) return next(err);

  res.status(status).json({
    success: false,
    message: err.expose ? err.message : undefined,
    error: err.message
  });
});


// ===========================================================================
// Startup
// ===========================================================================
async function startServer() {
  try {
    await pool.query('SELECT 1') // test DB
    console.log('Database connected')
  } catch (err) {
    console.error('Database connection failed:', err)
    process.exit(1)
  }

  try {
    await logDeviceEvent({
      deviceID: null,
      eventType: 'SERVER_START',
      occurredAtMs: SERVER_STARTED_AT,
      source: 'WATCHDOG',
      detail: `offline detection suppressed for ${STARTUP_GRACE_MS / 1000}s`
    })
  } catch (err) {
    // Missing DeviceEvent table means the schema has not been created.
    console.warn('SERVER_START event not logged:', err.message)
  }

  // One watchdog, one table. Liveness is a property of the Pi now, reported by
  // its device-agent service; runLivenessWatchdog() stays parameterised on the
  // table so a second liveness domain does not mean a second copy of it.
  setInterval(runOfflineWatchdog, WATCHDOG_TICK_MS)
}
startServer()

app.listen(process.env.PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
