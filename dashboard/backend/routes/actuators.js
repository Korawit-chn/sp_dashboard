// ===========================================================================
// ACTUATOR CONTROL (fan PWM + tach, mist relay)
//
// Same pull model as /api/schedule: the Pi cannot be pushed to, so a "command"
// is just the latest MANUAL/AUTOMATION row in ActuatorLog. The Pi polls for it.
// Periodic telemetry (rpm/pulseCount/dutyPercent) is written as its own
// ActuatorLog row with triggerSource='SYSTEM' so it never gets picked up as
// a command, plus a matching ActuatorStatus row for health/heartbeat.
//
// Was the fenced "v2.2.1af" block in server.js.
// ===========================================================================

const express = require('express')
const router = express.Router()

const { pool } = require('../db')
const { toEpochMs, toInt, toFloat, findOrCreate, asyncRoute } = require('../helpers')
const {
  ACTUATOR_ACTIONS,
  TRIGGER_SOURCES,
  ACTUATOR_STATES,
  MAX_MIST_SECONDS,
  MAX_FAN_SECONDS
} = require('../config')

// How long a run of each kind may last. Which ACTION carries a duration is the
// same question as which one starts a run: ON is the mist relay starting, and
// SET_SPEED is the fan spinning up. OFF is the END of a run and never carries
// one - giving it a duration would be asking for the fan to stop for a while
// and then do what, exactly.
//
// An action absent from this table simply has no timed form.
const DURATION_CAP_SECONDS = {
  ON: MAX_MIST_SECONDS,
  SET_SPEED: MAX_FAN_SECONDS
}

// Find-or-create, mirrors registerSensor
router.post('/registerActuator', asyncRoute(async (req, res) => {
  const { deviceUUID, actuatorType, locationName, actuatorName, description } = req.body;

  // locationName is REQUIRED, matching registerSensor. It used to be optional,
  // and it cannot be now: an actuator is identified by
  // (deviceID, typeID, locationID), and MySQL treats every NULL in a UNIQUE key
  // as distinct - so a NULL locationID would make the upsert below insert a
  // fresh row on every single registration instead of finding the existing one.
  if (!deviceUUID || !actuatorType || !locationName) {
    return res.status(400).json({
      success: false,
      message: 'deviceUUID, actuatorType and locationName are required'
    });
  }

  // The Device comes first. This is what registerSensor has always done and
  // registerActuator never did, which is why the mist Pi had no Device row at
  // all - and therefore nothing for the dashboard to show as ONLINE once
  // liveness moved to DeviceStatus.
  const deviceID = await findOrCreate('Device', 'deviceUUID', 'deviceID', deviceUUID);
  const typeID = await findOrCreate('ActuatorType', 'typeName', 'typeID', actuatorType);
  const locationID = await findOrCreate('Location', 'locationName', 'locationID', locationName);

  // Upserts on uq_actuator_identity (deviceID, typeID, locationID) - the same
  // shape as uq_sensor_identity. The old key was deviceUUID alone, which is
  // what limited a Pi to exactly one actuator; the fan and the mister can now
  // share a box.
  await pool.execute(
    `INSERT INTO Actuator (deviceID, typeID, locationID, actuatorName, description)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE actuatorID = actuatorID`,
    [deviceID, typeID, locationID, actuatorName || null, description || null]
  );

  // insertId is unreliable after a no-op ON DUPLICATE KEY UPDATE, so read the
  // row back rather than trusting it - same reason registerSensor re-selects.
  const [actuatorRows] = await pool.execute(
    `SELECT actuatorID FROM Actuator
     WHERE deviceID = ? AND typeID = ? AND locationID = ?`,
    [deviceID, typeID, locationID]
  );

  res.status(200).json({
    success: true,
    actuatorID: actuatorRows[0].actuatorID,
    deviceID,
    typeID,
    locationID
  });

}));

// Dashboard/rule -> issue a command (ON / OFF / SET_SPEED)
router.post('/actuatorCommand', asyncRoute(async (req, res) => {
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

  // How long the run should last, capped per action - see
  // DURATION_CAP_SECONDS. Clamped rather than rejected: a caller asking a
  // mister for an hour gets ten minutes, which is the safe reading.
  //
  // Absent is still allowed, and does not mean "run forever": the Pi supplies
  // its own MaxRun from config.txt / config_fan.txt when a command arrives
  // without one, so every run has an end time even if the request did not name
  // it. That fallback lives on the Pi on purpose - it is the half that still
  // works when the backend disappears mid-run.
  const cap = DURATION_CAP_SECONDS[action];
  const requestedDuration = toInt(req.body.durationSeconds);
  const durationSeconds = (cap == null || requestedDuration == null || requestedDuration <= 0)
    ? null
    : Math.min(requestedDuration, cap);

  // status column only holds ON/OFF/IDLE; SET_SPEED implies the fan is running
  const newStatus = action === 'SET_SPEED' ? 'ON' : action;

  // Optimistic: this is intent, not fact. A device that reports back via
  // /api/actuatorState overwrites it with what the hardware is really doing
  // on its next poll, and until then intent is the best answer available.
  //
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

}));

// Pi polls this to find out what it should be doing
router.get('/actuatorCommand', asyncRoute(async (req, res) => {
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

}));

// Pi pushes back telemetry (duty applied, pulses counted, derived rpm)
router.post('/actuatorStatus', asyncRoute(async (req, res) => {
  const actuatorID = toInt(req.body.actuatorID);
  const pwmDutyPercent = toFloat(req.body.pwmDutyPercent);
  const pulseCount = toInt(req.body.pulseCount);
  const rpm = toInt(req.body.rpm);
  // powerDraw and signalStrength are still accepted and ignored. Both columns
  // went in M005: the hardware has no current readback at all, and RSSI is a
  // property of the Pi's one radio rather than of each actuator on it. Older
  // fan clients keep sending them; there is no reason to 400 for that.

  if (actuatorID == null) {
    return res.status(400).json({ success: false, message: 'actuatorID is required' });
  }

  // Telemetry goes to ActuatorLog and nowhere else. This used to write the same
  // duty to ActuatorStatus in the same request, which is what made that table a
  // duplicate of the log. Liveness is the device agent's job now.
  //
  // Feedback reading, kept separate from real commands via triggerSource='SYSTEM'
  await pool.execute(
    `INSERT INTO ActuatorLog (actuatorID, action, pwmDutyPercent, pulseCount, rpm, triggerSource)
     VALUES (?, 'SET_SPEED', ?, ?, ?, 'SYSTEM')`,
    [actuatorID, pwmDutyPercent, pulseCount, rpm]
  );

  res.status(200).json({ success: true });

}));

// Simple actuators (mist maker relay) report state + heartbeat here.
//
// Separate from /api/actuatorStatus because that one hardcodes a SET_SPEED
// ActuatorLog row on every call. That is right for a fan, where duty/rpm/pulse
// feedback IS the telemetry, and wrong for a relay that has none: within a day
// the real ON/OFF history would be buried under heartbeat noise. So this
// writes no log row at all, and ActuatorLog stays a record of commands.
router.post('/actuatorState', asyncRoute(async (req, res) => {
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
  //
  // It is NOT a heartbeat any more. relay_control.py used to call this every
  // 60 s purely to stamp lastHeartbeat; the device agent reports liveness now,
  // so this fires only when the state actually changes.
  await pool.execute(
    'UPDATE Actuator SET status = ?, statusUpdatedAt = NOW(6) WHERE actuatorID = ?',
    [state, actuatorID]
  );

  res.status(200).json({ success: true, serverEpochMs: Date.now() });

}));

// List actuators + latest known status, like /api/devices
router.get('/actuators', asyncRoute(async (req, res) => {
  const [rows] = await pool.query(
    // Liveness comes from the actuator's DEVICE now - there is no
    // ActuatorStatus table. `a.status` is what the hardware is doing;
    // `st.connectionStatus` is whether the Pi carrying it is reachable.
    //
    // The ActuatorLog join does not filter on `rpm IS NOT NULL`. It used to,
    // which made it "latest row that had an rpm" rather than "latest row", so a
    // fan with a dead tach would freeze its duty alongside its rpm. Unfiltered,
    // duty is always current and lastRpm reads NULL until the fan reports one -
    // which the panel renders as no rpm rather than as an hour-old number
    // sitting next to a fresh duty.
    `SELECT a.actuatorID, a.deviceID, a.actuatorName, a.description,
            a.status, a.statusUpdatedAt, a.isActive,
            at.typeName, loc.locationName,
            d.deviceUUID, d.hostname,
            st.connectionStatus,
            st.lastHeartbeat AS lastTelemetryAt,
            ll.pwmDutyPercent AS lastDutyPercent,
            ll.rpm AS lastRpm, ll.pulseCount AS lastPulseCount
     FROM Actuator a
     LEFT JOIN ActuatorType at ON at.typeID = a.typeID
     LEFT JOIN Location loc ON loc.locationID = a.locationID
     LEFT JOIN Device d ON d.deviceID = a.deviceID
     LEFT JOIN DeviceStatus st ON st.deviceID = a.deviceID
     LEFT JOIN ActuatorLog ll ON ll.actionID = (
       SELECT MAX(actionID) FROM ActuatorLog WHERE actuatorID = a.actuatorID
     )
     ORDER BY a.actuatorID`
  );

  res.json({
    serverEpochMs: Date.now(),
    actuators: rows.map(r => ({
      ...r,
      // A Pi whose agent has never checked in has no DeviceStatus row, so the
      // LEFT JOIN gives NULL. UNKNOWN is the honest reading and matches the
      // column's own default - the frontend treats anything that is not ONLINE
      // as "state unknown".
      status: r.status || 'IDLE',
      connectionStatus: r.connectionStatus || 'UNKNOWN',
      statusUpdatedAtMs: toEpochMs(r.statusUpdatedAt)
    }))
  });

}));

module.exports = router
