// ===========================================================================
// Every tunable constant in the backend, in one place.
//
// Some of these are also known to the Pi clients and the frontend. Where that
// duplication is deliberate it says so; where it is not, GET /api/config is
// what removes it - the frontend reads these values at load instead of
// carrying its own copy.
// ===========================================================================

// --- Time sync / device tracking  (timeSyncPlan.md §3, §6b) ---
const HEARTBEAT_INTERVAL_MS = 60 * 1000        // Pi maintenance cycle
const OFFLINE_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS
const WATCHDOG_TICK_MS = 30 * 1000

// A Pi cannot report its own death, so "offline" is always inferred. If the
// SERVER was the thing that was off, every Pi looks dead at startup - suppress
// detection for one full threshold so gaps stay attributable to the right box.
const STARTUP_GRACE_MS = OFFLINE_AFTER_MS

// --- Sampling schedule ---
const MIN_PERIOD_SECONDS = 2      // DHT22 datasheet limit
const MAX_PERIOD_SECONDS = 3600
const DEFAULT_PERIOD_SECONDS = 5
const DEFAULT_LEAD_SECONDS = 30   // all Pis must have polled before the switch
const MAX_BATCH_ROWS = 500

// --- Upload interval ---
//
// How often a Pi drains its cache. A DIFFERENT question from the sampling
// period, and validated differently: the period has a hardware floor and a
// coordinated switch instant, this has neither.
//
// It is also NOT the heartbeat interval. HEARTBEAT_INTERVAL_MS above stays
// fixed at 60 s and OFFLINE_AFTER_MS is built on it, so raising this to 5
// minutes does not make a single Pi look offline. Merging the two is the one
// way to get this change badly wrong.
//
// The floor stops the batch upload degrading into the per-row upload that
// /api/sensorLogBatch exists to avoid. The ceiling is the Pi's drain capacity:
// a cycle accumulates sendSeconds/periodSeconds rows and drains at most
// batch_size * max_batches_per_cycle = 2000, so at the fastest legal sampling
// (2 s) a cycle stops keeping up near 4000 s. 3600 is inside that at every
// legal period, with margin - it is a bound, not a coincidence.
const MIN_SEND_SECONDS = 5
const MAX_SEND_SECONDS = 3600
const DEFAULT_SEND_SECONDS = 60   // what the Pi clients used to hardcode

// --- Dashboard log queries ---
//
// GET /api/logs took `hours` straight from the query string and handed it to
// MySQL. 'abc' coerced to 0 and came back as an empty array - which on a chart
// is indistinguishable from a sensor that has sent nothing - and 999999
// scanned the whole table.
//
// The ceiling is on the TIME RANGE, not a row LIMIT. A LIMIT under
// ORDER BY datetime keeps the OLDEST rows and silently drops the newest, so a
// busy dashboard would quietly stop drawing partway along with no error at
// all. Bounding the window instead makes the refusal explicit and keeps every
// row that IS returned trustworthy.
//
// 168 h at the 5 s period across four Pis is roughly 480k rows. Raise it if
// you need longer windows, but build idx_sensorlog_sensor_time first
// (section 3 of Database_v3.6.sql) or the query gets slow rather than wrong.
const DEFAULT_LOG_HOURS = 6
const MAX_LOG_HOURS = 168

const SERVER_STARTED_AT = Date.now()

const TIME_CONFIDENCE = ['SYNCED', 'CORRECTED', 'ESTIMATED', 'UNKNOWN']

// --- Actuators ---
const ACTUATOR_ACTIONS = ['ON', 'OFF', 'SET_SPEED'];
const TRIGGER_SOURCES = ['MANUAL', 'AUTOMATION', 'SYSTEM'];
const ACTUATOR_STATES = ['ON', 'OFF', 'IDLE'];

// Outer bound on a mist run. The Pi enforces its own cap from config.txt and
// that is the one that actually protects the dome - this is only a twin, so a
// bad number cannot reach the hardware through the API either. DELIBERATELY
// duplicated; do not "fix" it by deleting either copy.
const MAX_MIST_SECONDS = 600;

// The same idea for a fan run, and a different number because the hazard is
// different. 600 s protects the dome from being flooded; a fan cannot flood
// anything, so its cap is only about not leaving one running unattended, and
// an hour covers any realistic timed run.
//
// Same DELIBERATE duplication: fan_control.py clamps again from MaxRun in
// config_fan.txt, and that copy is the one the hardware actually obeys.
const MAX_FAN_SECONDS = 3600;

module.exports = {
  HEARTBEAT_INTERVAL_MS,
  OFFLINE_AFTER_MS,
  WATCHDOG_TICK_MS,
  STARTUP_GRACE_MS,
  MIN_PERIOD_SECONDS,
  MAX_PERIOD_SECONDS,
  DEFAULT_PERIOD_SECONDS,
  DEFAULT_LEAD_SECONDS,
  MIN_SEND_SECONDS,
  MAX_SEND_SECONDS,
  DEFAULT_SEND_SECONDS,
  MAX_BATCH_ROWS,
  DEFAULT_LOG_HOURS,
  MAX_LOG_HOURS,
  SERVER_STARTED_AT,
  TIME_CONFIDENCE,
  ACTUATOR_ACTIONS,
  TRIGGER_SOURCES,
  ACTUATOR_STATES,
  MAX_MIST_SECONDS,
  MAX_FAN_SECONDS
}
