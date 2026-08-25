require("dotenv").config();
const express = require("express");
const mysql = require('mysql2/promise');
const cors = require("cors");
const app = express();

// MIDDLEWARE
app.use(cors());
// Backlog batches are the reason for the raised limit: 500 sensor rows is well
// past the 100kb default, and body-parser would 413 them before any handler ran.
app.use(express.json({ limit: '5mb' }));

// MYSQL CONNECTION
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
})

// ===========================================================================
// TIME SYNC / DEVICE TRACKING CONFIG   (timeSyncPlan.md §3, §6b)
// ===========================================================================

const HEARTBEAT_INTERVAL_MS = 60 * 1000        // Pi maintenance cycle
const OFFLINE_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS
const WATCHDOG_TICK_MS = 30 * 1000
// A Pi cannot report its own death, so "offline" is always inferred. If the
// SERVER was the thing that was off, every Pi looks dead at startup - suppress
// detection for one full threshold so gaps stay attributable to the right box.
const STARTUP_GRACE_MS = OFFLINE_AFTER_MS

const MIN_PERIOD_SECONDS = 2      // DHT22 datasheet limit
const MAX_PERIOD_SECONDS = 3600
const DEFAULT_PERIOD_SECONDS = 5
const DEFAULT_LEAD_SECONDS = 30   // all Pis must have polled before the switch
const MAX_BATCH_ROWS = 500

const SERVER_STARTED_AT = Date.now()

const TIME_CONFIDENCE = ['SYNCED', 'CORRECTED', 'ESTIMATED', 'UNKNOWN']

// mysql2 hands Date objects straight to the driver, but being explicit keeps
// the fractional seconds we actually care about for the latency work.
function toSqlDateTime(epochMs) {
  const d = new Date(epochMs)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.` +
         `${p(d.getMilliseconds(), 3)}000`
}

function toEpochMs(value) {
  if (value == null) return null
  if (value instanceof Date) return value.getTime()
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

function toInt(value) {
  if (value == null || value === '') return null
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? n : null
}

// =========================
// === start of v2.2.1af ===
// =========================
function toFloat(value, decimals = 2) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : null
}

// ===========================================================================
// ACTUATOR CONTROL (fan PWM + tach)
//
// Same pull model as /api/schedule: the Pi cannot be pushed to, so a "command"
// is just the latest MANUAL/AUTOMATION row in ActuatorLog. The Pi polls for it.
// Periodic telemetry (rpm/pulseCount/dutyPercent) is written as its own
// ActuatorLog row with triggerSource='SYSTEM' so it never gets picked up as
// a command, plus a matching ActuatorStatus row for health/heartbeat.
// ===========================================================================

const ACTUATOR_ACTIONS = ['ON', 'OFF', 'SET_SPEED'];
const TRIGGER_SOURCES = ['MANUAL', 'AUTOMATION', 'SYSTEM'];
const ACTUATOR_STATES = ['ON', 'OFF', 'IDLE'];

// Outer bound on a mist run. The Pi enforces its own cap from config.txt and
// that is the one that actually protects the dome - this is only a twin, so a
// bad number cannot reach the hardware through the API either.
const MAX_MIST_SECONDS = 600;

// Find-or-create, mirrors registerSensor
app.post('/api/registerActuator', async (req, res) => {
  try {
    const { deviceUUID, actuatorType, locationName, actuatorName, description } = req.body;

    if (!deviceUUID || !actuatorType) {
      return res.status(400).json({
        success: false,
        message: 'deviceUUID and actuatorType are required'
      });
    }

    // Find or create ActuatorType
    let [typeRows] = await pool.execute(
      'SELECT typeID FROM ActuatorType WHERE typeName = ?',
      [actuatorType]
    );
    let typeID;
    if (typeRows.length === 0) {
      const [result] = await pool.execute(
        'INSERT INTO ActuatorType (typeName) VALUES (?)',
        [actuatorType]
      );
      typeID = result.insertId;
    } else {
      typeID = typeRows[0].typeID;
    }

    // Find or create Location (optional)
    let locationID = null;
    if (locationName) {
      let [locRows] = await pool.execute(
        'SELECT locationID FROM Location WHERE locationName = ?',
        [locationName]
      );
      if (locRows.length === 0) {
        const [result] = await pool.execute(
          'INSERT INTO Location (locationName) VALUES (?)',
          [locationName]
        );
        locationID = result.insertId;
      } else {
        locationID = locRows[0].locationID;
      }
    }

    // Find or create Actuator by deviceUUID (UNIQUE, same upsert pattern as Device)
    await pool.execute(
      `INSERT INTO Actuator (typeID, locationID, deviceUUID, actuatorName, description)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE actuatorID = actuatorID`,
      [typeID, locationID, deviceUUID, actuatorName || null, description || null]
    );

    const [actuatorRows] = await pool.execute(
      'SELECT actuatorID FROM Actuator WHERE deviceUUID = ?',
      [deviceUUID]
    );

    res.status(200).json({
      success: true,
      actuatorID: actuatorRows[0].actuatorID,
      typeID,
      locationID
    });

  } catch (err) {
    console.error('registerActuator error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dashboard/rule -> issue a command (ON / OFF / SET_SPEED)
app.post('/api/actuatorCommand', async (req, res) => {
  try {
    const actuatorID = toInt(req.body.actuatorID);
    const action = req.body.action;
    const pwmDutyPercent = toFloat(req.body.pwmDutyPercent);
    const triggerSource = TRIGGER_SOURCES.includes(req.body.triggerSource)
      ? req.body.triggerSource
      : 'MANUAL';

    if (actuatorID == null || !ACTUATOR_ACTIONS.includes(action)) {
      return res.status(400).json({
        success: false,
        message: `actuatorID required, action must be one of ${ACTUATOR_ACTIONS.join(', ')}`
      });
    }

    if (action === 'SET_SPEED' && (pwmDutyPercent == null || pwmDutyPercent < 0 || pwmDutyPercent > 100)) {
      return res.status(400).json({
        success: false,
        message: 'pwmDutyPercent (0-100) required for SET_SPEED'
      });
    }

    // How long an ON should last. Only meaningful for a run that has to end,
    // so OFF and SET_SPEED drop it. Clamped rather than rejected: a caller
    // asking for an hour gets ten minutes, which is the safe reading.
    const requestedDuration = toInt(req.body.durationSeconds);
    const durationSeconds = (action !== 'ON' || requestedDuration == null || requestedDuration <= 0)
      ? null
      : Math.min(requestedDuration, MAX_MIST_SECONDS);

    // status column only holds ON/OFF/IDLE; SET_SPEED implies the fan is running
    const newStatus = action === 'SET_SPEED' ? 'ON' : action;

    // Optimistic: this is intent, not fact. A device that reports back via
    // /api/actuatorState overwrites it with what the hardware is really doing
    // on its next poll, and until then intent is the best answer available.
    await pool.execute(
      'UPDATE Actuator SET status = ?, statusUpdatedAt = NOW(6) WHERE actuatorID = ?',
      [newStatus, actuatorID]
    );

    const [result] = await pool.execute(
      `INSERT INTO ActuatorLog (actuatorID, action, pwmDutyPercent, durationSeconds, triggerSource)
       VALUES (?, ?, ?, ?, ?)`,
      [actuatorID, action, pwmDutyPercent, durationSeconds, triggerSource]
    );

    res.status(201).json({ success: true, actionID: result.insertId, durationSeconds });

  } catch (err) {
    console.error('actuatorCommand error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Pi polls this to find out what it should be doing
app.get('/api/actuatorCommand', async (req, res) => {
  try {
    const actuatorID = toInt(req.query.actuatorID);
    if (actuatorID == null) {
      return res.status(400).json({ success: false, message: 'actuatorID is required' });
    }

    // Latest real command, excluding SYSTEM telemetry rows.
    //
    // Ordered by actionID, NOT recordedAt: that column is a plain TIMESTAMP,
    // so it only resolves to the second. Two commands inside one second - an
    // operator mis-clicking ON and correcting it straight away - would come
    // back in undefined order. For a fan that is one bad duty cycle. For a
    // latching mist relay it leaves the mister running while the dashboard
    // shows OFF.
    const [rows] = await pool.execute(
      `SELECT actionID, action, pwmDutyPercent, durationSeconds, recordedAt
       FROM ActuatorLog
       WHERE actuatorID = ? AND triggerSource IN ('MANUAL','AUTOMATION')
       ORDER BY actionID DESC
       LIMIT 1`,
      [actuatorID]
    );

    // A device that has never been commanded is off, and stays off.
    if (rows.length === 0) {
      return res.json({
        success: true,
        actionID: null,
        action: 'OFF',
        pwmDutyPercent: 0,
        durationSeconds: null,
        serverEpochMs: Date.now()
      });
    }

    res.json({
      success: true,
      // The client applies a command once and remembers this id. Without it a
      // poll that keeps re-serving the same ON would undo the device's own
      // auto-off on the very next cycle.
      actionID: rows[0].actionID,
      action: rows[0].action,
      pwmDutyPercent: rows[0].pwmDutyPercent,
      durationSeconds: rows[0].durationSeconds,
      commandedAtMs: toEpochMs(rows[0].recordedAt),
      serverEpochMs: Date.now()
    });

  } catch (err) {
    console.error('actuatorCommand read error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Pi pushes back telemetry (duty applied, pulses counted, derived rpm)
app.post('/api/actuatorStatus', async (req, res) => {
  try {
    const actuatorID = toInt(req.body.actuatorID);
    const pwmDutyPercent = toFloat(req.body.pwmDutyPercent);
    const pulseCount = toInt(req.body.pulseCount);
    const rpm = toInt(req.body.rpm);
    const powerDraw = toFloat(req.body.powerDraw);
    const signalStrength = toInt(req.body.signalStrength);

    if (actuatorID == null) {
      return res.status(400).json({ success: false, message: 'actuatorID is required' });
    }

    await pool.execute(
      `INSERT INTO ActuatorStatus (actuatorID, powerDraw, signalStrength, pwmDutyPercent, lastHeartbeat)
       VALUES (?, ?, ?, ?, NOW(6))`,
      [actuatorID, powerDraw, signalStrength, pwmDutyPercent]
    );

    // Feedback reading, kept separate from real commands via triggerSource='SYSTEM'
    await pool.execute(
      `INSERT INTO ActuatorLog (actuatorID, action, pwmDutyPercent, pulseCount, rpm, triggerSource)
       VALUES (?, 'SET_SPEED', ?, ?, ?, 'SYSTEM')`,
      [actuatorID, pwmDutyPercent, pulseCount, rpm]
    );

    res.status(200).json({ success: true });

  } catch (err) {
    console.error('actuatorStatus error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Simple actuators (mist maker relay) report state + heartbeat here.
//
// Separate from /api/actuatorStatus because that one hardcodes a SET_SPEED
// ActuatorLog row on every call. That is right for a fan, where duty/rpm/pulse
// feedback IS the telemetry, and wrong for a relay that has none: within a day
// the real ON/OFF history would be buried under heartbeat noise. So this
// writes no log row at all, and ActuatorLog stays a record of commands.
app.post('/api/actuatorState', async (req, res) => {
  try {
    const actuatorID = toInt(req.body.actuatorID);
    const state = req.body.state;

    if (actuatorID == null || !ACTUATOR_STATES.includes(state)) {
      return res.status(400).json({
        success: false,
        message: `actuatorID required, state must be one of ${ACTUATOR_STATES.join(', ')}`
      });
    }

    // Unlike the optimistic write in POST /api/actuatorCommand, this is the
    // device telling us what the hardware is actually doing.
    await pool.execute(
      'UPDATE Actuator SET status = ?, statusUpdatedAt = NOW() WHERE actuatorID = ?',
      [state, actuatorID]
    );

    await pool.execute(
      'INSERT INTO ActuatorStatus (actuatorID, lastHeartbeat) VALUES (?, NOW())',
      [actuatorID]
    );

    res.status(200).json({ success: true, serverEpochMs: Date.now() });

  } catch (err) {
    console.error('actuatorState error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// List actuators + latest known status, like /api/devices
app.get('/api/actuators', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.actuatorID, a.deviceUUID, a.actuatorName, a.description,
              a.status, a.statusUpdatedAt, a.isActive,
              at.typeName, loc.locationName,
              ls.pwmDutyPercent AS lastDutyPercent,
              ls.lastHeartbeat AS lastTelemetryAt,
              ll.rpm AS lastRpm, ll.pulseCount AS lastPulseCount
       FROM Actuator a
       LEFT JOIN ActuatorType at ON at.typeID = a.typeID
       LEFT JOIN Location loc ON loc.locationID = a.locationID
       LEFT JOIN ActuatorStatus ls ON ls.statusID = (
         SELECT MAX(statusID) FROM ActuatorStatus WHERE actuatorID = a.actuatorID
       )
       LEFT JOIN ActuatorLog ll ON ll.actionID = (
         SELECT MAX(actionID) FROM ActuatorLog
         WHERE actuatorID = a.actuatorID AND rpm IS NOT NULL
       )
       ORDER BY a.actuatorID`
    );

    res.json({
      serverEpochMs: Date.now(),
      actuators: rows.map(r => ({ ...r, statusUpdatedAtMs: toEpochMs(r.statusUpdatedAt) }))
    });

  } catch (err) {
    console.error('actuators error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// =======================
// === end of v2.2.1af ===
// =======================

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

  setInterval(runOfflineWatchdog, WATCHDOG_TICK_MS)
}
startServer()


// ===========================================================================
// DEVICE STATE HELPERS
// ===========================================================================

/**
 * Sensor -> Device. A power cut takes out the whole Pi, so status, events and
 * sessions are keyed on the device; the Pis only ever report a sensorID.
 *
 * Cached for the process lifetime: uq_sensor_identity includes deviceID, so a
 * Sensor row's device never changes - a different device is a different row.
 */
const deviceIDBySensor = new Map()

async function resolveDeviceID(sensorID) {
  if (sensorID == null) return null

  const cached = deviceIDBySensor.get(sensorID)
  if (cached !== undefined) return cached

  const [rows] = await pool.execute(
    'SELECT deviceID FROM Sensor WHERE sensorID = ?',
    [sensorID]
  )

  const deviceID = rows.length ? rows[0].deviceID : null
  if (deviceID != null) deviceIDBySensor.set(sensorID, deviceID)
  return deviceID
}

async function logDeviceEvent({ deviceID, eventType, occurredAtMs, bootID, source, detail }) {
  const [result] = await pool.execute(
    `INSERT INTO DeviceEvent (deviceID, eventType, occurredAt, bootID, source, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      deviceID ?? null,
      eventType,
      toSqlDateTime(occurredAtMs ?? Date.now()),
      bootID ?? null,
      source,
      detail ?? null
    ]
  )
  return result.insertId
}

/**
 * Opens a powered-on period. UNIQUE (deviceID, bootID) makes this idempotent:
 * a repeated boot report - first heartbeat lands but its response is lost -
 * produces one session, not several.
 */
async function openSession(deviceID, bootID, startedAtMs, previousEndMs) {
  // A session still open on a NEW bootID means the device came back before the
  // watchdog noticed it had gone. Close it at its last proof of life; accuracy
  // is UNKNOWN because nothing observed the actual power-off.
  await pool.execute(
    `UPDATE DeviceSession
     SET endedAt = ?, endReason = 'POWER_LOSS', endAccuracy = 'UNKNOWN'
     WHERE deviceID = ? AND endedAt IS NULL AND (bootID IS NULL OR bootID <> ?)`,
    [toSqlDateTime(previousEndMs ?? startedAtMs), deviceID, bootID]
  )

  await pool.execute(
    `INSERT INTO DeviceSession (deviceID, bootID, startedAt)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE sessionID = sessionID`,
    [deviceID, bootID, toSqlDateTime(startedAtMs)]
  )
}

/** endAccuracy exists so a rough watchdog estimate is never mistaken for a
 *  precise one - see databaseChanges.md. */
async function closeSession(deviceID, endedAtMs, endReason, endAccuracy) {
  await pool.execute(
    `UPDATE DeviceSession
     SET endedAt = ?, endReason = ?, endAccuracy = ?
     WHERE deviceID = ? AND endedAt IS NULL`,
    [toSqlDateTime(endedAtMs), endReason, endAccuracy, deviceID]
  )
}

/**
 * Undo a close that turned out to be wrong.
 *
 * The watchdog infers POWER_LOSS from silence, but silence is equally a
 * network outage or a stalled upload. A device that comes back carrying the
 * bootID it already had never rebooted, so it never lost power and the session
 * should not have ended. Without this it stays closed until the next real
 * boot, leaving a running device with no open session and understated uptime.
 *
 * Keyed on bootID, so a genuine power cycle - which always brings a new one -
 * cannot be reopened by mistake.
 */
async function reopenSession(deviceID, bootID) {
  if (!bootID) return false

  const [result] = await pool.execute(
    `UPDATE DeviceSession
     SET endedAt = NULL, endReason = NULL, endAccuracy = NULL
     WHERE deviceID = ? AND bootID = ? AND endedAt IS NOT NULL`,
    [deviceID, bootID]
  )

  return result.affectedRows > 0
}

/**
 * Records proof of life for a device and emits BOOT / ONLINE events on
 * transitions. Any upload counts as a heartbeat, not just /api/heartbeat.
 */
async function markSeen(sensorID, { nowMs, bootID, uptimeSeconds, source, detail,
                                    offsetMs, rttMs } = {}) {
  const deviceID = await resolveDeviceID(sensorID)

  // An unknown sensorID means the Pi is holding an ID from another database -
  // the v2 -> v3 cutover being the obvious way that happens. Silently doing
  // nothing would leave that Pi untracked forever, so say so.
  if (deviceID == null) return false

  const seenAt = nowMs ?? Date.now()

  // Snapshot taken BEFORE the upsert below - the transition checks and the
  // session close both need the previous state, not the one we are writing.
  const [rows] = await pool.execute(
    'SELECT bootID, connectionStatus, lastHeartbeat FROM DeviceStatus WHERE deviceID = ?',
    [deviceID]
  )
  const previous = rows[0] || null

  let bootAtMs = null
  if (uptimeSeconds != null && Number.isFinite(Number(uptimeSeconds))) {
    bootAtMs = seenAt - Number(uptimeSeconds) * 1000
  }

  // Clock health is per device: it lets the dashboard show a Pi drifting
  // before its data is affected. Only stamped when the Pi actually reported a
  // sync, so an upload-driven touch does not blank it.
  const syncedNow = rttMs != null || offsetMs != null

  await pool.execute(
    `INSERT INTO DeviceStatus
       (deviceID, lastHeartbeat, bootID, bootAt, connectionStatus,
        lastSyncAt, lastSyncOffsetMs, lastSyncRttMs)
     VALUES (?, ?, ?, ?, 'ONLINE', ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       lastHeartbeat = VALUES(lastHeartbeat),
       bootID = COALESCE(VALUES(bootID), bootID),
       bootAt = COALESCE(VALUES(bootAt), bootAt),
       connectionStatus = 'ONLINE',
       lastSyncAt = COALESCE(VALUES(lastSyncAt), lastSyncAt),
       lastSyncOffsetMs = COALESCE(VALUES(lastSyncOffsetMs), lastSyncOffsetMs),
       lastSyncRttMs = COALESCE(VALUES(lastSyncRttMs), lastSyncRttMs)`,
    [
      deviceID,
      toSqlDateTime(seenAt),
      bootID ?? null,
      bootAtMs == null ? null : toSqlDateTime(bootAtMs),
      syncedNow ? toSqlDateTime(seenAt) : null,
      toInt(offsetMs),
      toInt(rttMs)
    ]
  )

  // A new bootID for a known device IS the power-on event.
  if (bootID && (!previous || previous.bootID !== bootID)) {
    await logDeviceEvent({
      deviceID,
      eventType: 'BOOT',
      occurredAtMs: bootAtMs ?? seenAt,
      bootID,
      source: 'BOOT_REPORT',
      detail: uptimeSeconds == null ? 'uptime unavailable' : `uptime ${Math.round(uptimeSeconds)}s`
    })

    await openSession(
      deviceID,
      bootID,
      bootAtMs ?? seenAt,
      previous ? toEpochMs(previous.lastHeartbeat) : null
    )
  }

  if (!previous || previous.connectionStatus !== 'ONLINE') {
    // Same bootID means no power cycle, so any recorded end to that session was
    // inferred from silence and is wrong. A new bootID cannot match here - that
    // case already opened a fresh session above.
    const reopened = await reopenSession(deviceID, bootID)

    await logDeviceEvent({
      deviceID,
      eventType: 'ONLINE',
      occurredAtMs: seenAt,
      bootID: bootID ?? null,
      source: source || 'HEARTBEAT',
      detail: reopened
        ? 'session reopened - same boot, so the outage was contact only'
        : detail ?? null
    })
  }

  return true
}

// markSeen costs a SELECT plus an upsert. Uploads are proof of life too, but
// on the single-row fallback path that would be two extra round trips per
// reading on a disk-bound server - for information the watchdog only consults
// every 180 s. Throttled per sensor; /api/heartbeat is never throttled.
const SEEN_THROTTLE_MS = 15 * 1000
const lastSeenTouch = new Map()

function touchSeen(sensorID, detail) {
  if (sensorID == null) return

  const now = Date.now()
  const last = lastSeenTouch.get(sensorID)

  if (last != null && now - last < SEEN_THROTTLE_MS) return

  lastSeenTouch.set(sensorID, now)

  markSeen(sensorID, { nowMs: now, source: 'HEARTBEAT', detail })
    .catch(err => {
      lastSeenTouch.delete(sensorID)   // let the next upload retry
      console.error('markSeen failed:', err.message)
    })
}

async function runOfflineWatchdog() {
  const now = Date.now()

  // §6b pitfall: right after a backend restart every Pi looks dead.
  if (now - SERVER_STARTED_AT < STARTUP_GRACE_MS) return

  try {
    const [rows] = await pool.query(
      `SELECT deviceID, lastHeartbeat, bootID
       FROM DeviceStatus
       WHERE connectionStatus = 'ONLINE'
         AND lastHeartbeat IS NOT NULL
         AND lastHeartbeat < NOW(6) - INTERVAL ? SECOND`,
      [Math.round(OFFLINE_AFTER_MS / 1000)]
    )

    for (const row of rows) {
      const lastSeenMs = toEpochMs(row.lastHeartbeat) ?? now

      await pool.execute(
        `UPDATE DeviceStatus SET connectionStatus = 'OFFLINE' WHERE deviceID = ?`,
        [row.deviceID]
      )
      // occurredAt is the last proof of life; detectedAt (default) is now.
      // The gap between them is the watchdog timeout, and gets refined later
      // from the backlog once the Pi reconnects.
      await logDeviceEvent({
        deviceID: row.deviceID,
        eventType: 'OFFLINE',
        occurredAtMs: lastSeenMs,
        bootID: row.bootID,
        source: 'WATCHDOG',
        detail: `no contact for ${Math.round(OFFLINE_AFTER_MS / 1000)}s`
      })

      await closeSession(row.deviceID, lastSeenMs, 'POWER_LOSS', 'WATCHDOG')

      console.log(`Watchdog: device ${row.deviceID} marked OFFLINE`)
    }
  } catch (err) {
    console.error('Offline watchdog error:', err.message)
  }
}


// test
app.get("/", (req, res) => {
  res.send("API is running");
});

// ===========================================================================
// TIME SOURCE  (timeSyncPlan.md §3)
//
// The Pis have no RTC and no internet; this route is their clock. It must not
// touch the database - the Pi measures round-trip delay against it, so any
// latency added here lands directly on the sensors as clock error.
// ===========================================================================
app.get('/api/time', (req, res) => {
  const now = Date.now();
  res.json({
    epochMs: now,
    iso: new Date(now).toISOString()
  });
});

// GET all sensors
app.get('/api/sensors', async (req, res) => {
  // Explicit columns, not SELECT *: deviceUUID moved to Device in v3, so a star
  // select would quietly drop it from the response instead of failing loudly.
  const [rows] = await pool.query(
    `SELECT s.sensorID,
            s.deviceID,
            d.deviceUUID,
            s.typeID,
            s.locationID,
            s.sensorDescription,
            s.createdAt
     FROM Sensor s
     JOIN Device d ON d.deviceID = s.deviceID
     ORDER BY s.sensorID`
  )
  res.json(rows)
})

app.post('/api/registerSensor', async (req, res) => {
  try {
    const {
      deviceUUID,
      sensorType,
      locationName
    } = req.body;

    // Validate input
    if (!deviceUUID || !sensorType || !locationName) {
      return res.status(400).json({
        success: false,
        message: 'deviceUUID, sensorType and locationName are required'
      });
    }

    // ======================
    // Find or Create Device
    // ======================

    // A Pi is not a sensor: one device owns several Sensor rows, so the on/off
    // tables key on deviceID. deviceUUID is UNIQUE, which lets the find-or-create
    // be a single upsert - two sensors on the same Pi registering at once cannot
    // race between a SELECT and an INSERT.
    await pool.execute(
      `
      INSERT INTO Device (deviceUUID)
      VALUES (?)
      ON DUPLICATE KEY UPDATE deviceID = deviceID
      `,
      [deviceUUID]
    );

    // insertId is unreliable after a no-op ON DUPLICATE KEY UPDATE, so read the
    // row back rather than trusting it.
    const [deviceRows] = await pool.execute(
      `
      SELECT deviceID
      FROM Device
      WHERE deviceUUID = ?
      `,
      [deviceUUID]
    );

    const deviceID = deviceRows[0].deviceID;

    // =========================
    // Find or Create SensorType
    // =========================

    let [typeRows] = await pool.execute(
      `
      SELECT typeID
      FROM SensorType
      WHERE sensorType = ?
      `,
      [sensorType]
    );

    let typeID;

    if (typeRows.length === 0) {

      const [result] = await pool.execute(
        `
        INSERT INTO SensorType (sensorType)
        VALUES (?)
        `,
        [sensorType]
      );

      typeID = result.insertId;

    } else {

      typeID = typeRows[0].typeID;

    }

    // ======================
    // Find or Create Location
    // ======================

    let [locationRows] = await pool.execute(
      `
      SELECT locationID
      FROM Location
      WHERE locationName = ?
      `,
      [locationName]
    );

    let locationID;

    if (locationRows.length === 0) {

      const [result] = await pool.execute(
        `
        INSERT INTO Location (locationName)
        VALUES (?)
        `,
        [locationName]
      );

      locationID = result.insertId;

    } else {

      locationID = locationRows[0].locationID;

    }

    // ======================================
    // Check Existing Sensor
    // Device + Type + Location
    // ======================================

    const [existingSensor] = await pool.execute(
      `
      SELECT sensorID
      FROM Sensor
      WHERE deviceID = ?
      AND typeID = ?
      AND locationID = ?
      `,
      [
        deviceID,
        typeID,
        locationID
      ]
    );

    if (existingSensor.length > 0) {

      return res.status(200).json({
        success: true,
        sensorID: existingSensor[0].sensorID,
        deviceID,
        existing: true
      });

    }

    // ======================
    // Create New Sensor
    // ======================

    const [sensorResult] = await pool.execute(
      `
      INSERT INTO Sensor (
        deviceID,
        typeID,
        locationID
      )
      VALUES (?, ?, ?)
      `,
      [
        deviceID,
        typeID,
        locationID
      ]
    );

    return res.status(201).json({
      success: true,
      sensorID: sensorResult.insertId,
      deviceID,
      existing: false
    });

  } catch (err) {

    console.error('registerSensor error:', err);

    return res.status(500).json({
      success: false,
      error: err.message
    });

  }
});
// GET logs for last X hours
// app.get('/api/logs', async (req, res) => {
//   const hours = req.query.hours || 2

//   const [rows] = await pool.query(`
//     SELECT s.sensorID, s.sensorType, s.sensorLocation,
//            l.datetime, l.temperature, l.humidity, l.windspeed, l.VPD
//     FROM SensorLog l
//     JOIN Sensor s ON s.sensorID = l.sensorID
//     WHERE l.datetime >= NOW() - INTERVAL ? HOUR
//     ORDER BY l.datetime
//   `, [hours])

//   res.json(rows)
// })

app.get('/api/logs', async (req, res) => {
  const { hours, start, end, instrumentation } = req.query

  // Opt-in: the default 6-hour window is ~17k rows, and serialising five extra
  // fields per row for every dashboard refresh is not free on this server.
  const extraColumns = instrumentation === '1' || instrumentation === 'true'
    ? `,
           l.timeConfidence,
           l.readLatencyMs,
           l.tickJitterMs,
           l.queueDelayMs,
           l.recordedAt,
           TIMESTAMPDIFF(MICROSECOND, l.datetime, l.recordedAt) AS endToEndUs`
    : ''

  let query = `
    SELECT s.sensorID,
           s.sensorDescription,
           t.sensorType,
           loc.locationName,
           l.datetime,
           l.temperature,
           l.humidity,
           l.windspeed,
           l.windDirection,
           l.VPD${extraColumns}
    FROM SensorLog l
    JOIN Sensor s ON s.sensorID = l.sensorID
    LEFT JOIN SensorType t ON s.typeID = t.typeID
    LEFT JOIN Location loc ON s.locationID = loc.locationID
    WHERE 1=1
  `
  const params = []

  if (start && end) {
    query += ` AND l.datetime BETWEEN ? AND ?`
    params.push(start, end)
  } else {
    query += ` AND l.datetime >= NOW() - INTERVAL ? HOUR`
    params.push(hours || 6)
  }

  query += ` ORDER BY l.datetime`

  const [rows] = await pool.query(query, params)
  res.json(rows)
})

app.post('/api/ErrorLog', async (req, res) => {
  try {
    const { sensorID, errorType, errorMessage, severity } = req.body;

    if (!errorMessage) {
      return res.status(400).json({ message: 'Error message is required' });
    }

    // createdAt is server insert time. A read failure on an offline Pi is only
    // reported once the network returns, so a 2am fault would otherwise be
    // stamped 8am - occurredAt carries the device's own time instead.
    const occurredAtMs = toInt(req.body.occurredAtMs);
    const confidence = TIME_CONFIDENCE.includes(req.body.timeConfidence)
      ? req.body.timeConfidence
      : 'UNKNOWN';

    const sql = `
      INSERT INTO ErrorLog
        (sensorID, errorType, errorMessage, severity, occurredAt, timeConfidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    const [result] = await pool.execute(sql, [
      sensorID || null,
      errorType || 'UNKNOWN',
      errorMessage,
      severity || 'LOW',
      occurredAtMs == null ? null : toSqlDateTime(occurredAtMs),
      confidence
    ]);

    res.status(200).json({
      success: true,
      errorID: result.insertId
    });

  } catch (err) {
    console.error("Error logging failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ===========================================================================
// SENSOR LOG INSERTS
//
// One shared column list for the single-row and batch routes so the
// instrumentation fields (timeSyncPlan.md §5) cannot drift between them.
// ===========================================================================

const SENSORLOG_COLUMNS = [
  'sensorID', 'datetime', 'temperature', 'humidity', 'windspeed', 'windDirection', 'VPD',
  'timeConfidence', 'readLatencyMs', 'tickJitterMs', 'queueDelayMs', 'syncRttMs'
];

const SENSORLOG_PLACEHOLDERS = `(${SENSORLOG_COLUMNS.map(() => '?').join(', ')})`;

const SENSORLOG_INSERT_PREFIX =
  `INSERT INTO SensorLog (${SENSORLOG_COLUMNS.join(', ')}) VALUES `;

// Ticks are deterministic, so UNIQUE (sensorID, datetime) makes upload retries
// exactly-once. This no-op update is what keeps that from throwing: the Pi's
// flush loop only advances a row on a 200 and stops on anything else, so a 500
// here would wedge that Pi's entire queue behind one duplicate - forever.
//
// The no-op is on sensorID, NOT on logID. Assigning to the AUTO_INCREMENT
// column here makes MySQL reject the whole statement with errno 1869,
// ER_AUTO_INCREMENT_CONFLICT ("Auto-increment value in UPDATE conflicts with
// internally generated values") as soon as the insert carries more than one
// row - so the single-row routes worked and every batch failed.
const SENSORLOG_INSERT_SUFFIX = ' ON DUPLICATE KEY UPDATE sensorID = sensorID';

/** Maps a request body row onto SENSORLOG_COLUMNS. Returns null if invalid. */
function toSensorLogValues(row) {
  const { sensorID, temperature, humidity, VPD, time } = row;

  if (sensorID == null || temperature == null || humidity == null ||
      VPD == null || time == null) {
    return null;
  }

  const confidence = TIME_CONFIDENCE.includes(row.timeConfidence)
    ? row.timeConfidence
    : 'UNKNOWN';

  return [
    sensorID,
    time,
    temperature,
    humidity,
    row.windSpeed ?? row.windspeed ?? null,
    row.windDirection ?? null,
    VPD,
    confidence,
    toInt(row.readLatencyMs),
    toInt(row.tickJitterMs),
    toInt(row.queueDelayMs),
    toInt(row.syncRttMs)
  ];
}

app.post('/api/getDataDHT', async (req, res) => {
  try {
    const values = toSensorLogValues(req.body);

    if (!values) {
      return res.status(400).json({ message: 'Missing DHT data' });
    }

    const [result] = await pool.execute(
      SENSORLOG_INSERT_PREFIX + SENSORLOG_PLACEHOLDERS + SENSORLOG_INSERT_SUFFIX,
      values
    );

    touchSeen(req.body.sensorID, 'data upload');

    res.status(200).json({
      success: true,
      logID: result.insertId,
      duplicate: result.affectedRows === 0
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/getDataC5A', async (req, res) => {
  try {
    const { windSpeed, windDirection } = req.body;

    // windSpeed/windDirection are what make this a C5A row, so unlike the
    // shared validator they are required here.
    if (windSpeed == null || windDirection == null) {
      return res.status(400).json({ message: 'Missing C5A data' });
    }

    const values = toSensorLogValues(req.body);

    if (!values) {
      return res.status(400).json({ message: 'Missing C5A data' });
    }

    const [result] = await pool.execute(
      SENSORLOG_INSERT_PREFIX + SENSORLOG_PLACEHOLDERS + SENSORLOG_INSERT_SUFFIX,
      values
    );

    touchSeen(req.body.sensorID, 'data upload');

    res.status(200).json({
      success: true,
      logID: result.insertId,
      duplicate: result.affectedRows === 0
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Batch insert - required, not an optimisation (timeSyncPlan.md §7a).
 *
 * One POST per row means one MySQL transaction per row, and with
 * innodb_flush_log_at_trx_commit = 1 that is one fsync per row (~8-15 ms on
 * the spinning-disk server). A 6-hour backlog across 4 Pis is ~17k rows:
 * ~4 minutes of pure fsync one-at-a-time, ~1.3 s batched at 200/POST. While
 * that drain grinds, live inserts from the other Pis queue behind it.
 */
app.post('/api/sensorLogBatch', async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : req.body.rows;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ success: false, message: 'rows array required' });
    }

    if (rows.length > MAX_BATCH_ROWS) {
      return res.status(413).json({
        success: false,
        message: `batch too large, max ${MAX_BATCH_ROWS} rows`
      });
    }

    const values = [];
    const rejected = [];

    rows.forEach((row, i) => {
      const mapped = toSensorLogValues(row);
      if (mapped) {
        values.push(mapped);
      } else {
        rejected.push(i);
      }
    });

    if (values.length === 0) {
      return res.status(400).json({ success: false, message: 'no valid rows', rejected });
    }

    const sql = SENSORLOG_INSERT_PREFIX +
      values.map(() => SENSORLOG_PLACEHOLDERS).join(', ') +
      SENSORLOG_INSERT_SUFFIX;

    const [result] = await pool.query(sql, values.flat());

    [...new Set(values.map(v => v[0]))].forEach(id => touchSeen(id, 'batch upload'));

    // `inserted` counts rows accepted, which is what the Pi needs to know to
    // clear them from its cache. `stored` excludes duplicates the unique key
    // absorbed - a replayed backlog can legitimately be all duplicates.
    res.status(200).json({
      success: true,
      inserted: values.length,
      stored: result.affectedRows,
      firstLogID: result.insertId,
      rejected
    });

  } catch (err) {
    console.error('sensorLogBatch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ===========================================================================
// SAMPLING SCHEDULE  (timeSyncPlan.md §5)
//
// Every Pi derives its own tick instants from the Unix epoch, so a period
// change only works if they all switch at the SAME instant - otherwise they
// scatter onto different grids as each one happens to poll. That is what
// effectiveFrom is for, and why it is snapped to a multiple of the new period.
// ===========================================================================

app.get('/api/schedule', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT configID, periodSeconds, effectiveFrom, active, note, createdAt
       FROM SamplingConfig
       ORDER BY configID DESC
       LIMIT 1`
    );

    const now = Date.now();

    if (rows.length === 0) {
      return res.json({
        periodSeconds: DEFAULT_PERIOD_SECONDS,
        effectiveFromMs: now,
        configID: null,
        serverEpochMs: now
      });
    }

    const row = rows[0];

    res.json({
      configID: row.configID,
      periodSeconds: row.periodSeconds,
      // Stored as a Unix epoch in ms, not a datetime: it is the instant a new
      // period takes effect and every Pi must derive the same tick from it.
      effectiveFromMs: Number(row.effectiveFrom),
      active: !!row.active,
      note: row.note,
      serverEpochMs: now
    });

  } catch (err) {
    console.error('schedule read error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/schedule', async (req, res) => {
  try {
    const periodSeconds = toInt(req.body.periodSeconds);
    const leadSeconds = toInt(req.body.leadSeconds) ?? DEFAULT_LEAD_SECONDS;

    // DHT22 cannot be sampled faster than once per 2 s (datasheet). Enforced
    // here as well as in the Pi scheduler.
    if (periodSeconds == null ||
        periodSeconds < MIN_PERIOD_SECONDS ||
        periodSeconds > MAX_PERIOD_SECONDS) {
      return res.status(400).json({
        success: false,
        message: `periodSeconds must be an integer between ${MIN_PERIOD_SECONDS} and ${MAX_PERIOD_SECONDS}`
      });
    }

    if (leadSeconds < 0 || leadSeconds > 3600) {
      return res.status(400).json({ success: false, message: 'leadSeconds out of range' });
    }

    const now = Date.now();
    const periodMs = periodSeconds * 1000;
    // Snap to a multiple of the NEW period so every Pi lands on the same grid.
    const effectiveFromMs = Math.ceil((now + leadSeconds * 1000) / periodMs) * periodMs;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('UPDATE SamplingConfig SET active = FALSE WHERE active = TRUE');
      // Append-only: each change inserts a row so the sampling rate at any past
      // instant stays recoverable when analysing data spanning a change.
      const [result] = await conn.execute(
        `INSERT INTO SamplingConfig (periodSeconds, effectiveFrom, active, note)
         VALUES (?, ?, TRUE, ?)`,
        [periodSeconds, effectiveFromMs, req.body.note || null]
      );
      await conn.commit();

      res.status(201).json({
        success: true,
        configID: result.insertId,
        periodSeconds,
        effectiveFromMs,
        serverEpochMs: now
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

  } catch (err) {
    console.error('schedule write error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ===========================================================================
// DEVICE ON/OFF TRACKING  (timeSyncPlan.md §6b)
// ===========================================================================

app.post('/api/heartbeat', async (req, res) => {
  try {
    const sensorID = toInt(req.body.sensorID);

    if (sensorID == null) {
      return res.status(400).json({ success: false, message: 'sensorID is required' });
    }

    const tracked = await markSeen(sensorID, {
      bootID: req.body.bootID || null,
      uptimeSeconds: req.body.uptimeSeconds,
      source: 'HEARTBEAT',
      detail: req.body.detail || null,
      offsetMs: req.body.offsetMs,
      rttMs: req.body.rttMs
    });

    if (!tracked) {
      console.warn(`heartbeat from unknown sensorID ${sensorID} - stale registration?`);
    }

    res.json({
      success: true,
      // false means this sensorID does not exist here; the Pi should
      // re-register rather than keep heartbeating into nothing.
      tracked: !!tracked,
      serverEpochMs: Date.now(),
      offlineAfterSeconds: Math.round(OFFLINE_AFTER_MS / 1000)
    });

  } catch (err) {
    console.error('heartbeat error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Clean-shutdown hook. Only reachable on a graceful stop with the network up,
 *  so it supplements the watchdog inference rather than replacing it. */
app.post('/api/deviceEvent', async (req, res) => {
  try {
    const sensorID = toInt(req.body.sensorID);
    const eventType = req.body.eventType;

    if (!['SHUTDOWN', 'BOOT', 'ONLINE', 'OFFLINE'].includes(eventType)) {
      return res.status(400).json({ success: false, message: 'unsupported eventType' });
    }

    const occurredAtMs = toInt(req.body.occurredAtMs) ?? Date.now();
    const deviceID = await resolveDeviceID(sensorID);

    const eventID = await logDeviceEvent({
      deviceID,
      eventType,
      occurredAtMs,
      bootID: req.body.bootID || null,
      source: eventType === 'SHUTDOWN' ? 'SHUTDOWN_HOOK' : 'HEARTBEAT',
      detail: req.body.detail || null
    });

    if (eventType === 'SHUTDOWN' && deviceID != null) {
      await pool.execute(
        `UPDATE DeviceStatus SET connectionStatus = 'OFFLINE' WHERE deviceID = ?`,
        [deviceID]
      );
      // A clean stop is the one case where the end time is exact rather than
      // inferred, so it is recorded as such.
      await closeSession(deviceID, occurredAtMs, 'SHUTDOWN', 'SHUTDOWN_HOOK');
    }

    res.status(201).json({ success: true, eventID, deviceID });

  } catch (err) {
    console.error('deviceEvent error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/devices', async (req, res) => {
  try {
    // One row per DEVICE, not per sensor: a power cut takes out the whole Pi,
    // so reporting per sensor would show one outage twice on a Pi hosting two.
    const [rows] = await pool.query(
      `SELECT dev.deviceID,
              dev.deviceUUID,
              dev.hostname,
              dev.description,
              st.connectionStatus,
              st.lastHeartbeat,
              st.bootID,
              st.bootAt,
              st.lastSyncAt,
              st.lastSyncOffsetMs,
              st.lastSyncRttMs,
              TIMESTAMPDIFF(SECOND, st.lastHeartbeat, NOW(6)) AS secondsSinceLastSeen
       FROM Device dev
       LEFT JOIN DeviceStatus st ON st.deviceID = dev.deviceID
       ORDER BY dev.deviceID`
    );

    const [sensors] = await pool.query(
      `SELECT s.sensorID, s.deviceID, s.sensorDescription,
              t.sensorType, loc.locationName
       FROM Sensor s
       LEFT JOIN SensorType t ON t.typeID = s.typeID
       LEFT JOIN Location loc ON loc.locationID = s.locationID
       ORDER BY s.sensorID`
    );

    const sensorsByDevice = new Map();
    for (const s of sensors) {
      if (!sensorsByDevice.has(s.deviceID)) sensorsByDevice.set(s.deviceID, []);
      sensorsByDevice.get(s.deviceID).push({
        sensorID: s.sensorID,
        sensorType: s.sensorType,
        locationName: s.locationName,
        sensorDescription: s.sensorDescription
      });
    }

    res.json({
      serverEpochMs: Date.now(),
      offlineAfterSeconds: Math.round(OFFLINE_AFTER_MS / 1000),
      // Tells the dashboard that "everything offline" right now may just mean
      // the backend restarted a moment ago.
      inStartupGrace: Date.now() - SERVER_STARTED_AT < STARTUP_GRACE_MS,
      devices: rows.map(r => ({
        ...r,
        connectionStatus: r.connectionStatus || 'UNKNOWN',
        isOnline: r.connectionStatus === 'ONLINE',
        lastSeenMs: toEpochMs(r.lastHeartbeat),
        bootAtMs: toEpochMs(r.bootAt),
        lastSyncAtMs: toEpochMs(r.lastSyncAt),
        sensors: sensorsByDevice.get(r.deviceID) || []
      }))
    });

  } catch (err) {
    console.error('devices error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/deviceEvents', async (req, res) => {
  try {
    const limit = Math.min(toInt(req.query.limit) ?? 100, 1000);
    const hours = toInt(req.query.hours);

    // Accepts either key. A caller holding a sensorID still gets that sensor's
    // Pi, since events are recorded per device.
    const deviceID = toInt(req.query.deviceID) ??
      await resolveDeviceID(toInt(req.query.sensorID));

    let query = `
      SELECT e.eventID, e.deviceID, e.eventType, e.occurredAt, e.detectedAt,
             e.bootID, e.source, e.detail,
             dev.deviceUUID, dev.hostname
      FROM DeviceEvent e
      LEFT JOIN Device dev ON dev.deviceID = e.deviceID
      WHERE 1=1
    `;
    const params = [];

    if (deviceID != null) {
      query += ' AND e.deviceID = ?';
      params.push(deviceID);
    }

    if (hours != null) {
      query += ' AND e.occurredAt >= NOW(6) - INTERVAL ? HOUR';
      params.push(hours);
    }

    query += ' ORDER BY e.occurredAt DESC LIMIT ?';
    params.push(limit);

    const [rows] = await pool.query(query, params);

    res.json(rows.map(r => ({
      ...r,
      occurredAtMs: toEpochMs(r.occurredAt),
      detectedAtMs: toEpochMs(r.detectedAt)
    })));

  } catch (err) {
    console.error('deviceEvents error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// START SERVER
app.listen(process.env.PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
