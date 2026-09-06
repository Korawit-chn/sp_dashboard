// ===========================================================================
// DEVICE ON/OFF TRACKING  (timeSyncPlan.md §6b)
// ===========================================================================

const express = require('express')
const router = express.Router()

const { pool } = require('../db')
const { toEpochMs, toInt, asyncRoute } = require('../helpers')
const { OFFLINE_AFTER_MS, STARTUP_GRACE_MS, SERVER_STARTED_AT } = require('../config')
const {
  markSeen,
  resolveDeviceID,
  resolveDeviceIDByUUID,
  logDeviceEvent,
  closeSession
} = require('../deviceState')

// The device agent's only endpoint.
//
// Keyed on deviceUUID, not sensorID: a Pi is one box with one identity, and the
// agent knows nothing about what sensors or actuators are attached to it. That
// is also what lets an actuator-only Pi be tracked at all - it has no sensorID
// to report.
//
// sensorID is still accepted so an older client keeps working during a rollout.
router.post('/heartbeat', asyncRoute(async (req, res) => {
  const deviceUUID = req.body.deviceUUID || null;
  const sensorID = toInt(req.body.sensorID);

  if (!deviceUUID && sensorID == null) {
    return res.status(400).json({ success: false, message: 'deviceUUID is required' });
  }

  // UUID first: it is the identity the agent owns.
  const deviceID = deviceUUID
    ? await resolveDeviceIDByUUID(deviceUUID)
    : await resolveDeviceID(sensorID);

  const tracked = await markSeen(deviceID, {
    bootID: req.body.bootID || null,
    uptimeSeconds: req.body.uptimeSeconds,
    source: 'HEARTBEAT',
    detail: req.body.detail || null,
    offsetMs: req.body.offsetMs,
    rttMs: req.body.rttMs
  });

  if (!tracked) {
    // Not an error, and not something to fix by creating the row. The agent
    // registers nothing; it is waiting for the sensor or actuator client on the
    // same Pi to register, which happens within one maintenance cycle.
    console.warn(
      `heartbeat from unregistered device ${deviceUUID || `sensor ${sensorID}`} ` +
      `- waiting for its sensor/actuator client to register`
    );
  }

  res.json({
    success: true,
    // false means this device is not registered here yet. The agent keeps
    // retrying; nothing else needs to happen.
    tracked: !!tracked,
    serverEpochMs: Date.now(),
    offlineAfterSeconds: Math.round(OFFLINE_AFTER_MS / 1000)
  });

}));

/** Clean-shutdown hook. Only reachable on a graceful stop with the network up,
 *  so it supplements the watchdog inference rather than replacing it. */
router.post('/deviceEvent', asyncRoute(async (req, res) => {
  const deviceUUID = req.body.deviceUUID || null;
  const sensorID = toInt(req.body.sensorID);
  const eventType = req.body.eventType;

  if (!['SHUTDOWN', 'BOOT', 'ONLINE', 'OFFLINE'].includes(eventType)) {
    return res.status(400).json({ success: false, message: 'unsupported eventType' });
  }

  const occurredAtMs = toInt(req.body.occurredAtMs) ?? Date.now();

  // Same identity rule as /heartbeat: UUID if given, sensorID otherwise.
  const deviceID = deviceUUID
    ? await resolveDeviceIDByUUID(deviceUUID)
    : await resolveDeviceID(sensorID);

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

}));

router.get('/devices', asyncRoute(async (req, res) => {
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

}));

router.get('/deviceEvents', asyncRoute(async (req, res) => {
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

}));

module.exports = router
