// ===========================================================================
// SENSORS - registration, readings in, readings out, error log.
// ===========================================================================

const express = require('express')
const router = express.Router()

const { pool } = require('../db')
const { toSqlDateTime, toEpochMs, toInt, findOrCreate, asyncRoute } = require('../helpers')
const {
  TIME_CONFIDENCE,
  MAX_BATCH_ROWS,
  DEFAULT_LOG_HOURS,
  MAX_LOG_HOURS
} = require('../config')

router.post('/registerSensor', asyncRoute(async (req, res) => {
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

  // Device, SensorType and Location are all find-or-create by a unique name.
  // This used to be three hand-written blocks - an upsert for Device (with a
  // comment explaining that a SELECT-then-INSERT would race between two sensors
  // on the same Pi) and then the racy SELECT-then-INSERT for the other two.
  // findOrCreate() is the upsert, so all three are now safe the same way.
  //
  // A Pi is not a sensor: one device owns several Sensor rows, so the on/off
  // tables key on deviceID.
  const deviceID   = await findOrCreate('Device', 'deviceUUID', 'deviceID', deviceUUID);
  const typeID     = await findOrCreate('SensorType', 'sensorType', 'typeID', sensorType);
  const locationID = await findOrCreate('Location', 'locationName', 'locationID', locationName);

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

}));
// GET logs for last X hours
// router.get('/logs', async (req, res) => {
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

router.get('/logs', asyncRoute(async (req, res) => {
  const { start, end, instrumentation } = req.query

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

  // start and end are INDEPENDENT.
  //
  // This used to require both (if (start && end)), so a request carrying only
  // start fell through to the hours branch and answered a different question
  // entirely. wind3.js's "From time -> Now" sends exactly that, so choosing a
  // start time returned the last 6 hours instead - with a 200 and nothing to
  // indicate the window had been ignored.
  if (start || end) {
    // "everything before X" is unbounded, and is not a question the dashboard
    // asks. Rejecting it keeps every path through this route bounded.
    if (!start) {
      return res.status(400).json({ message: 'start is required when end is given' })
    }

    const from = new Date(start)
    const to = end ? new Date(end) : new Date()

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ message: 'start and end must be valid datetimes' })
    }

    // An explicit range is deliberate, but still bounded - the same ceiling
    // applies however the window was expressed.
    if ((to - from) / 3600000 > MAX_LOG_HOURS) {
      return res.status(400).json({
        message: `range must not exceed ${MAX_LOG_HOURS} hours`
      })
    }

    query += ` AND l.datetime >= ?`
    params.push(start)

    if (end) {
      query += ` AND l.datetime <= ?`
      params.push(end)
    }
  } else {
    const hours = req.query.hours === undefined
      ? DEFAULT_LOG_HOURS
      : Number(req.query.hours)

    // Unvalidated, 'abc' became INTERVAL 0 HOUR and returned [] with a 200 -
    // a typo and a dead sensor looked identical on the chart.
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_LOG_HOURS) {
      return res.status(400).json({
        message: `hours must be a number greater than 0 and at most ${MAX_LOG_HOURS}`
      })
    }

    query += ` AND l.datetime >= NOW() - INTERVAL ? HOUR`
    params.push(hours)
  }

  query += ` ORDER BY l.datetime`

  const [rows] = await pool.query(query, params)
  res.json(rows)
}))

router.post('/ErrorLog', asyncRoute(async (req, res) => {
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

}));


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

// Bounds taken straight from the SensorLog column types. A value outside them
// is rejected by MySQL under STRICT_TRANS_TABLES (confirmed in sql_mode on the
// 8.0.45 server), and because a batch is ONE multi-row INSERT, a single bad
// value takes all 500 rows of that statement with it.
//
// That is not merely a lost batch. client.py only retires rows on a 200, so the
// failure returns a 500, the Pi retries the SAME rows next cycle, gets the same
// 500, and that queue never drains again - the identical trap the errno
// 1452/1216 handler in server.js was written for. Checking here is what keeps
// one corrupt reading a one-row loss instead of a dead sensor.
//
// A corrupt C5A frame is the concrete case: C5A.py builds a reading as
// int.from_bytes(data[6:8]) * 0.1, so a mangled frame yields up to 6553.5 -
// fine as a number, impossible as DECIMAL(5,2).
const DECIMAL_5_2_MAX = 999.99;    // temperature, humidity, windspeed
const DECIMAL_6_2_MAX = 9999.99;   // VPD
const INT_MAX = 2147483647;        // windDirection

// TIMESTAMP spans 1970-01-01 .. 2038-01-19 and the column is stored in the
// server's timezone. A day of slack at each end means a legitimate reading near
// the boundary cannot be thrown out by a timezone offset, while the values this
// is aimed at - epoch 0 from a Pi that never got a clock, or a garbage
// far-future date - are still caught.
const TIMESTAMP_MIN_MS = Date.UTC(1970, 0, 2);
const TIMESTAMP_MAX_MS = Date.UTC(2038, 0, 18);

/** A description of why `value` cannot be stored, or null if it can. */
function numberFault(name, value, limit) {
  if (value == null) return null;   // the column is nullable; absent is fine

  const n = Number(value);

  // NaN and Infinity arrive as non-finite: vpd_kpa() on a corrupt frame is how
  // this shows up, since es grows exponentially with temperature.
  if (!Number.isFinite(n)) {
    return `${name} is not a finite number (${JSON.stringify(value)})`;
  }

  if (Math.abs(n) > limit) {
    return `${name} ${n} out of range for the column (max ${limit})`;
  }

  return null;
}

function datetimeFault(time) {
  const ms = toEpochMs(time);

  if (ms == null) return `time is not a date (${JSON.stringify(time)})`;

  if (ms < TIMESTAMP_MIN_MS || ms > TIMESTAMP_MAX_MS) {
    return `time ${JSON.stringify(time)} is outside the TIMESTAMP range`;
  }

  return null;
}

/**
 * Maps a request body row onto SENSORLOG_COLUMNS.
 *
 * Returns `{ values }` for a row that can be stored, or `{ fault }` naming the
 * first thing wrong with it. The fault text goes into ErrorLog, so it has to
 * say which field and what the value was - "invalid row", read six hours
 * later, does not tell you which sensor is misbehaving.
 */
function mapSensorLogRow(row) {
  const { sensorID, temperature, humidity, VPD, time } = row;

  if (sensorID == null || temperature == null || humidity == null ||
      VPD == null || time == null) {
    return { fault: 'missing sensorID, temperature, humidity, VPD or time' };
  }

  const windspeed = row.windSpeed ?? row.windspeed ?? null;

  const fault =
    datetimeFault(time) ||
    numberFault('temperature', temperature, DECIMAL_5_2_MAX) ||
    numberFault('humidity', humidity, DECIMAL_5_2_MAX) ||
    numberFault('VPD', VPD, DECIMAL_6_2_MAX) ||
    numberFault('windspeed', windspeed, DECIMAL_5_2_MAX) ||
    numberFault('windDirection', row.windDirection, INT_MAX);

  if (fault) return { fault };

  const confidence = TIME_CONFIDENCE.includes(row.timeConfidence)
    ? row.timeConfidence
    : 'UNKNOWN';

  return {
    values: [
      sensorID,
      time,
      temperature,
      humidity,
      windspeed,
      row.windDirection ?? null,
      VPD,
      confidence,
      toInt(row.readLatencyMs),
      toInt(row.tickJitterMs),
      toInt(row.queueDelayMs),
      toInt(row.syncRttMs)
    ]
  };
}

// ===========================================================================
// Corrupt readings
//
// A refused row is DISCARDED - it can never be stored, so keeping it would
// wedge the queue it sits in. Discarding it silently would mean a sensor could
// degrade for a week with nothing to show for it, so it is recorded in
// ErrorLog first and only then dropped from SensorLog.
// ===========================================================================

const DATA_CORRUPT = 'data corrupt';

// Errors meaning "this DATA cannot be stored", as opposed to a server or
// connection fault. Matching errnos is a backstop, not the mechanism:
// mapSensorLogRow() is meant to catch these before MySQL ever sees them, and
// the 1452/1216 note in server.js is the standing warning that which errno you
// get is not something the application controls.
const DATA_FAULT_ERRNOS = new Set([
  1264,  // ER_WARN_DATA_OUT_OF_RANGE
  1265,  // WARN_DATA_TRUNCATED
  1292,  // ER_TRUNCATED_WRONG_VALUE - a datetime that will not parse
  1366,  // ER_TRUNCATED_WRONG_VALUE_FOR_FIELD
  1406   // ER_DATA_TOO_LONG
]);

const isDataFault = (err) => DATA_FAULT_ERRNOS.has(err.errno);

/**
 * Record one refused reading, stamped with the time the READING was taken.
 *
 * occurredAt, not createdAt: createdAt is when the server happened to receive
 * it, so a backlog replayed after six hours offline would file every corrupt
 * row under the moment the network came back. The point of the record is to
 * find when the sensor actually misbehaved.
 *
 * Never throws. It runs while answering a request whose whole purpose is to
 * stop one bad row taking the others down; letting the bookkeeping fail the
 * response would rebuild the exact trap it exists to remove.
 */
async function logCorruptRow({ sensorID, fault, time, timeConfidence }) {
  // If the TIME is what is corrupt it cannot go into a TIMESTAMP either, so the
  // column is left NULL and the raw value is kept in the message instead.
  const badTime = datetimeFault(time);
  const occurredAt = badTime ? null : toSqlDateTime(toEpochMs(time));

  const confidence = TIME_CONFIDENCE.includes(timeConfidence)
    ? timeConfidence
    : 'UNKNOWN';

  const message = badTime ? `${fault} (raw time ${JSON.stringify(time)})` : fault;

  const sql = `
    INSERT INTO ErrorLog
      (sensorID, errorType, errorMessage, severity, occurredAt, timeConfidence)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

  try {
    await pool.execute(sql,
      [sensorID ?? null, DATA_CORRUPT, message, 'MEDIUM', occurredAt, confidence]);
    return;
  } catch (err) {
    // ErrorLog.sensorID carries the same foreign key SensorLog does, so a row
    // from a rebuilt database fails here for the reason it failed there. The
    // reading is still worth recording; only the link to a sensor is not.
    if (err.errno !== 1452 && err.errno !== 1216) {
      console.error('ErrorLog write failed:', err.code || err.message);
      return;
    }
  }

  try {
    await pool.execute(sql,
      [null, DATA_CORRUPT, `${message} (from unknown sensorID ${sensorID})`,
       'MEDIUM', occurredAt, confidence]);
  } catch (err) {
    console.error('ErrorLog write failed:', err.code || err.message);
  }
}

// ===========================================================================
// Single-row upload. One handler, mounted at both paths.
//
// The two routes were byte-identical apart from C5A additionally requiring
// windSpeed/windDirection to be present - so the difference is a required-field
// list, not a handler. The Pi's STREAM_ROUTES map keeps pointing at whichever
// path its stream uses; nothing on the device changes.
//
// This is NOT what /api/sensorLogBatch replaces: the batch route is a
// requirement, not an optimisation of this one (timeSyncPlan.md §7a). Both stay.
// ===========================================================================
function singleRowUpload(label, requiredFields) {
  return asyncRoute(async (req, res) => {
    for (const field of requiredFields) {
      if (req.body[field] == null) {
        return res.status(400).json({ message: `Missing ${label} data` });
      }
    }

    const mapped = mapSensorLogRow(req.body);

    if (mapped.fault) {
      await logCorruptRow({
        sensorID: req.body.sensorID,
        fault: mapped.fault,
        time: req.body.time,
        timeConfidence: req.body.timeConfidence
      });

      // 200, not 400, and the status is load-bearing for the same reason the
      // 409 in server.js is: _send_one_by_one() in client.py stops its loop on
      // ANY non-200 and leaves the row unretired, so a 400 on a row that can
      // never succeed is retried unchanged forever and wedges that queue. The
      // reading is refused either way - `rejected` is how the Pi is told, and
      // ErrorLog above is where the evidence lives.
      return res.status(200).json({
        success: true,
        rejected: true,
        stored: 0,
        message: `${label} row rejected as corrupt: ${mapped.fault}`
      });
    }

    const [result] = await pool.execute(
      SENSORLOG_INSERT_PREFIX + SENSORLOG_PLACEHOLDERS + SENSORLOG_INSERT_SUFFIX,
      mapped.values
    );

    res.status(200).json({
      success: true,
      logID: result.insertId,
      duplicate: result.affectedRows === 0
    });
  });
}

router.post('/getDataDHT', singleRowUpload('DHT', []));

// windSpeed/windDirection are what make a row a C5A row, so unlike the shared
// validator they are required here.
router.post('/getDataC5A', singleRowUpload('C5A', ['windSpeed', 'windDirection']));

/**
 * Batch insert - required, not an optimisation (timeSyncPlan.md §7a).
 *
 * One POST per row means one MySQL transaction per row, and with
 * innodb_flush_log_at_trx_commit = 1 that is one fsync per row (~8-15 ms on
 * the spinning-disk server). A 6-hour backlog across 4 Pis is ~17k rows:
 * ~4 minutes of pure fsync one-at-a-time, ~1.3 s batched at 200/POST. While
 * that drain grinds, live inserts from the other Pis queue behind it.
 */
router.post('/sensorLogBatch', asyncRoute(async (req, res) => {
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

  const accepted = [];   // { index, values, row } for rows that can be stored
  const rejected = [];   // indices into `rows`, which is what the Pi reads
  const corrupt = [];    // rows to record in ErrorLog before they are dropped

  rows.forEach((row, i) => {
    const mapped = mapSensorLogRow(row);

    if (mapped.fault) {
      rejected.push(i);
      corrupt.push({
        sensorID: row.sensorID,
        fault: mapped.fault,
        time: row.time,
        timeConfidence: row.timeConfidence
      });
      return;
    }

    accepted.push({ index: i, values: mapped.values, row });
  });

  let stored = 0;
  let firstLogID = null;

  if (accepted.length > 0) {
    const sql = SENSORLOG_INSERT_PREFIX +
      accepted.map(() => SENSORLOG_PLACEHOLDERS).join(', ') +
      SENSORLOG_INSERT_SUFFIX;

    try {
      const [result] = await pool.query(sql, accepted.flatMap(a => a.values));
      stored = result.affectedRows;
      firstLogID = result.insertId;
    } catch (err) {
      // mapSensorLogRow() is supposed to have caught every one of these, so
      // reaching here means a value it does not know about. Rather than let one
      // row lose the other 499 - and wedge the queue behind them - insert them
      // one at a time to find out which. Slow, and it only runs when something
      // has already gone wrong.
      if (!isDataFault(err)) throw err;

      console.warn(`sensorLogBatch: ${err.code} in a batch of ${accepted.length}` +
                   ` - isolating rows`);

      for (const entry of accepted) {
        try {
          const [one] = await pool.execute(
            SENSORLOG_INSERT_PREFIX + SENSORLOG_PLACEHOLDERS + SENSORLOG_INSERT_SUFFIX,
            entry.values
          );
          stored += one.affectedRows;
          if (firstLogID === null && one.insertId) firstLogID = one.insertId;
        } catch (rowErr) {
          if (!isDataFault(rowErr)) throw rowErr;

          rejected.push(entry.index);
          corrupt.push({
            sensorID: entry.row.sensorID,
            fault: `refused by the database: ${rowErr.code} - ${rowErr.sqlMessage}`,
            time: entry.row.time,
            timeConfidence: entry.row.timeConfidence
          });
        }
      }
    }
  }

  // Sequential, not Promise.all: a batch is normally all-good and this loop
  // does nothing, while the case it does run for is a sensor emitting garbage -
  // exactly when firing 500 concurrent inserts at the pool is least welcome.
  for (const entry of corrupt) {
    await logCorruptRow(entry);
  }

  if (corrupt.length > 0) {
    console.warn(`sensorLogBatch: ${corrupt.length} of ${rows.length} rows ` +
                 `recorded as "${DATA_CORRUPT}" and dropped`);
  }

  // 200 even when EVERY row was corrupt. This used to answer 400 'no valid
  // rows', which the Pi treats like any other non-200 - it left them unretired
  // and re-sent the same all-bad batch every cycle, forever. A row that can
  // never be stored has to be reported as handled, or it blocks the ones behind
  // it; `rejected` is what says it was not kept.
  //
  // `inserted` counts rows the Pi may clear from its cache. `stored` excludes
  // duplicates the unique key absorbed - a replayed backlog can legitimately be
  // all duplicates.
  res.status(200).json({
    success: true,
    inserted: rows.length - rejected.length,
    stored,
    firstLogID,
    rejected
  });

}));

module.exports = router
