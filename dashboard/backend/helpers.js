// ===========================================================================
// Value conversion and the find-or-create used by both register routes.
// No Express, no routes - safe to require from anywhere.
// ===========================================================================
const { pool } = require('./db')

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

function toFloat(value, decimals = 2) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : null
}

/**
 * Find-or-create a lookup row by its unique name column, returning its id.
 *
 * Replaces four hand-written SELECT-then-INSERT blocks (ActuatorType,
 * SensorType, and Location twice - the same lookup on the same table, written
 * out in both register routes).
 *
 * Written as an upsert rather than SELECT-then-INSERT because the hand-written
 * version raced: two sensors on one Pi registering at the same instant could
 * both see "not found" and both INSERT, and the second one dies on the unique
 * key. registerSensor already used an upsert for Device with a comment saying
 * exactly that, then used the racy form for its other two lookups.
 *
 * ON DUPLICATE KEY UPDATE makes insertId unreliable after a no-op, so the row
 * is always read back rather than trusted - the same reason registerSensor
 * re-selects Device.
 *
 * Table and column names are interpolated, never parameterised: MySQL does not
 * accept placeholders for identifiers. Every caller passes a literal from this
 * codebase, never anything from a request body.
 */
async function findOrCreate(table, keyColumn, idColumn, value) {
  if (value == null || value === '') return null

  await pool.execute(
    `INSERT INTO ${table} (${keyColumn}) VALUES (?)
     ON DUPLICATE KEY UPDATE ${idColumn} = ${idColumn}`,
    [value]
  )

  const [rows] = await pool.execute(
    `SELECT ${idColumn} FROM ${table} WHERE ${keyColumn} = ?`,
    [value]
  )

  return rows.length ? rows[0][idColumn] : null
}

/**
 * Wraps an async route so a rejected promise reaches the error handler.
 *
 * This project is on Express 5, which already forwards a rejected handler to
 * next() on its own - so this is belt and braces, not load-bearing. It is kept
 * for two reasons: it makes "errors go to the error handler" visible at the
 * route rather than being an invisible property of the Express major version,
 * and it is what stops a downgrade to Express 4 from silently turning every
 * throw into a request that hangs forever.
 *
 * Either way it is what replaces the 17 identical try/catch-then-500 blocks.
 */
function asyncRoute(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

module.exports = { toSqlDateTime, toEpochMs, toInt, toFloat, findOrCreate, asyncRoute }
