// ===========================================================================
// SAMPLING SCHEDULE  (timeSyncPlan.md §5, AI Assistant/samplingIntervalPlan.md)
//
// Two intervals, stored in one row and validated differently.
//
// periodSeconds - how often a Pi READS. Every Pi derives its own tick instants
// from the Unix epoch, so a period change only works if they all switch at the
// SAME instant - otherwise they scatter onto different grids as each one
// happens to poll. That is what effectiveFrom is for, and why it is snapped to
// a multiple of the new period. It also has a hardware floor (DHT22, 2 s).
//
// sendSeconds - how often a Pi UPLOADS what it read. No agreement between Pis
// is needed, so no effectiveFrom: adding that machinery would advertise a
// coordination guarantee that is not being made, and staggered uploads are
// mildly preferable anyway because they spread the write load. Its floor is
// economic (batching stops paying below a few seconds) and its ceiling is the
// Pi's drain capacity - see MIN/MAX_SEND_SECONDS in config.js.
//
// One row carries both because SamplingConfig is append-only: the history of
// each interval stays recoverable, which is what you need when reading data
// that spans a change.
// ===========================================================================

const express = require('express')
const router = express.Router()

const { pool } = require('../db')
const { toInt, asyncRoute } = require('../helpers')
const {
  MIN_PERIOD_SECONDS,
  MAX_PERIOD_SECONDS,
  DEFAULT_PERIOD_SECONDS,
  DEFAULT_LEAD_SECONDS,
  MIN_SEND_SECONDS,
  MAX_SEND_SECONDS,
  DEFAULT_SEND_SECONDS
} = require('../config')

router.get('/schedule', asyncRoute(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT configID, periodSeconds, sendSeconds, effectiveFrom, active, note, createdAt
     FROM SamplingConfig
     ORDER BY configID DESC
     LIMIT 1`
  );

  const now = Date.now();

  if (rows.length === 0) {
    return res.json({
      periodSeconds: DEFAULT_PERIOD_SECONDS,
      sendSeconds: DEFAULT_SEND_SECONDS,
      effectiveFromMs: now,
      configID: null,
      serverEpochMs: now
    });
  }

  const row = rows[0];

  res.json({
    configID: row.configID,
    periodSeconds: row.periodSeconds,
    sendSeconds: row.sendSeconds,
    // Stored as a Unix epoch in ms, not a datetime: it is the instant a new
    // period takes effect and every Pi must derive the same tick from it.
    effectiveFromMs: Number(row.effectiveFrom),
    active: !!row.active,
    note: row.note,
    serverEpochMs: now
  });

}));

router.post('/schedule', asyncRoute(async (req, res) => {
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

  // Optional, and carried forward when omitted rather than reset to the
  // default: the table is append-only, so every new row has to restate BOTH
  // intervals, and a client that only knows about periodSeconds - the panel
  // before this change, or a script - must not silently undo someone's upload
  // setting as a side effect of changing the sampling period.
  const sendSeconds = toInt(req.body.sendSeconds) ?? await currentSendSeconds();

  if (sendSeconds < MIN_SEND_SECONDS || sendSeconds > MAX_SEND_SECONDS) {
    return res.status(400).json({
      success: false,
      message: `sendSeconds must be an integer between ${MIN_SEND_SECONDS} and ${MAX_SEND_SECONDS}`
    });
  }

  // Uploading more often than you sample is pointless - every extra cycle
  // finds an empty cache and posts nothing.
  if (sendSeconds < periodSeconds) {
    return res.status(400).json({
      success: false,
      message: `sendSeconds (${sendSeconds}) cannot be shorter than periodSeconds (${periodSeconds})`
    });
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
      `INSERT INTO SamplingConfig (periodSeconds, sendSeconds, effectiveFrom, active, note)
       VALUES (?, ?, ?, TRUE, ?)`,
      [periodSeconds, sendSeconds, effectiveFromMs, req.body.note || null]
    );
    await conn.commit();

    res.status(201).json({
      success: true,
      configID: result.insertId,
      periodSeconds,
      sendSeconds,
      effectiveFromMs,
      serverEpochMs: now
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

}));

// The active send interval, for a POST that did not name one. Falls back to the
// code default only on an empty table - the same case GET /schedule answers
// from constants.
async function currentSendSeconds() {
  const [rows] = await pool.query(
    'SELECT sendSeconds FROM SamplingConfig ORDER BY configID DESC LIMIT 1'
  );

  return rows.length ? rows[0].sendSeconds : DEFAULT_SEND_SECONDS;
}

module.exports = router
