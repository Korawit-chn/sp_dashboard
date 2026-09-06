// ===========================================================================
// DEVICE ON/OFF STATE  (timeSyncPlan.md §6b)
//
// Everything that decides whether a Pi is alive, and what to record when that
// answer changes. Pulled out of server.js unchanged - no route, no Express.
// ===========================================================================
const { pool } = require('./db')
const { toSqlDateTime, toEpochMs, toInt } = require('./helpers')
const {
  OFFLINE_AFTER_MS,
  STARTUP_GRACE_MS,
  SERVER_STARTED_AT
} = require('./config')


/**
 * Sensor -> Device. A power cut takes out the whole Pi, so status, events and
 * sessions are keyed on the device; the Pis only ever report a sensorID.
 *
 * Cached for the process lifetime: uq_sensor_identity includes deviceID, so a
 * Sensor row's device never changes - a different device is a different row.
 */
const deviceIDBySensor = new Map()

/**
 * deviceUUID -> Device. What the device agent identifies itself by.
 *
 * Deliberately does NOT create the row. Registration belongs to whatever owns
 * the thing being registered - registerSensor creates Device + Sensor,
 * registerActuator creates Device + Actuator. The agent only reports state, so
 * a heartbeat for a UUID nobody has registered is rejected rather than
 * quietly conjuring a Device with no sensors and no actuators on it.
 *
 * Self-healing: the agent retries every 60 s, and the sensor or actuator client
 * registers within one maintenance cycle, after which the heartbeat lands.
 *
 * Cached per process, like resolveDeviceID: deviceUUID is UNIQUE on Device, so
 * the mapping never changes. Only successful lookups are cached - a miss must
 * stay a miss until the client actually registers.
 */
const deviceIDByUUID = new Map()

async function resolveDeviceIDByUUID(deviceUUID) {
  if (!deviceUUID) return null

  const cached = deviceIDByUUID.get(deviceUUID)
  if (cached !== undefined) return cached

  const [rows] = await pool.execute(
    'SELECT deviceID FROM Device WHERE deviceUUID = ?',
    [deviceUUID]
  )

  const deviceID = rows.length ? rows[0].deviceID : null
  if (deviceID != null) deviceIDByUUID.set(deviceUUID, deviceID)
  return deviceID
}

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
async function markSeen(deviceID, { nowMs, bootID, uptimeSeconds, source, detail,
                                    offsetMs, rttMs } = {}) {
  // Callers resolve the device first - by UUID for the agent, by sensorID for
  // anything still holding one. A null here means the Pi is not registered, and
  // the caller reports that back so it can register rather than heartbeat into
  // nothing.
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

// touchSeen() used to live here: sensor uploads counted as proof of life, with
// a 15 s per-sensor throttle to keep the cost off the single-row upload path.
//
// It is gone. Liveness has exactly one writer now - the device agent - so an
// upload says nothing about whether the box is up, and the upload path is that
// much shorter for it. See AI Assistant/deviceAgentPlan.md §0.


// ===========================================================================
// LIVENESS
//
// DeviceStatus and ActuatorStatus both carry connectionStatus + lastHeartbeat
// and both go stale the same way, so the watchdog is written once and
// parameterised on the table.
//
// Only the watchdog generalises. The rest of markSeen() - bootID, sessions,
// BOOT/ONLINE events - deliberately does not: relay_control.py has no boot
// concept by design, and DeviceEvent is foreign-keyed to Device, so actuator
// events could not be recorded there anyway. Mirroring DeviceStatus's liveness
// columns is the whole of the shared part; do not grow an actuator event log
// that nothing reads.
// ===========================================================================

/**
 * Marks every row in `table` OFFLINE whose last heartbeat is older than the
 * threshold, and calls onOffline for each one.
 *
 * Table and column names are interpolated because MySQL takes no placeholder
 * for an identifier. Both callers below pass literals from this file.
 */
async function runLivenessWatchdog({ table, keyColumn, extraColumns = [], onOffline }) {
  const now = Date.now()

  // §6b pitfall: right after a backend restart every device looks dead.
  if (now - SERVER_STARTED_AT < STARTUP_GRACE_MS) return

  const columns = [keyColumn, 'lastHeartbeat', ...extraColumns].join(', ')

  try {
    const [rows] = await pool.query(
      `SELECT ${columns}
       FROM ${table}
       WHERE connectionStatus = 'ONLINE'
         AND lastHeartbeat IS NOT NULL
         AND lastHeartbeat < NOW(6) - INTERVAL ? SECOND`,
      [Math.round(OFFLINE_AFTER_MS / 1000)]
    )

    for (const row of rows) {
      const id = row[keyColumn]
      const lastSeenMs = toEpochMs(row.lastHeartbeat) ?? now

      await pool.execute(
        `UPDATE ${table} SET connectionStatus = 'OFFLINE' WHERE ${keyColumn} = ?`,
        [id]
      )

      if (onOffline) await onOffline(row, lastSeenMs)

      console.log(`Watchdog: ${table} ${id} marked OFFLINE`)
    }
  } catch (err) {
    console.error(`${table} watchdog error:`, err.message)
  }
}

function runOfflineWatchdog() {
  return runLivenessWatchdog({
    table: 'DeviceStatus',
    keyColumn: 'deviceID',
    extraColumns: ['bootID'],
    onOffline: async (row, lastSeenMs) => {
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
    }
  })
}

module.exports = {
  resolveDeviceID,
  resolveDeviceIDByUUID,
  logDeviceEvent,
  openSession,
  closeSession,
  reopenSession,
  markSeen,
  runLivenessWatchdog,
  runOfflineWatchdog
}
