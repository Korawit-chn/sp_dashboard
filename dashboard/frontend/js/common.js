// =====================
// Shared by every page and every panel. Loaded FIRST - see index.html.
//
// This file exists because the load order used to be load-bearing and silent:
// actuators.js called formatAge() out of devices.js, and an HTML comment was
// the only thing enforcing it. Anything more than one file needs now lives
// here instead, so reordering the panel scripts cannot break them.
// =====================

// One API base for the whole frontend. Before this file, script.js and
// wind3.js each declared `const API` and devices.js/actuators.js worked around
// the clash by inventing DEVICE_API and ACTUATOR_API - top-level `const` is
// shared across <script> tags, so two of them on one page is a SyntaxError.
// One declaration here, everyone reads it.
const API = window.CONFIG.API


// =====================
// Formatting
// =====================

function formatAge(seconds) {
  if (seconds == null) return "never"
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

// mysql2 hands back DECIMAL as a STRING ("50.00"), not a number, because a JS
// double cannot represent every DECIMAL exactly. Harmless until you compare or
// do arithmetic with it, so convert once here rather than at each use.
function toNumber(value) {
  if (value == null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}


// =====================
// Fetch
// =====================

// Every caller used to repeat: fetch, await json, check res.ok, pick the right
// error field, catch. The error field is the part worth centralising - 400s
// carry `message` and 500s carry `error`, and reading only `message` made every
// server-side failure show up as a bare "failed", hiding the one useful thing.
//
// Throws on a non-2xx or on a dead connection, so callers have ONE failure path
// instead of two. The thrown Error carries .status and .body for the cases that
// want to log the whole reply.
async function api(path, options) {
  const res = await fetch(`${API}${path}`, options)

  // A 500 from behind a proxy can be HTML, and a 204 has no body at all.
  // Neither should turn into a confusing JSON parse error.
  let body = null
  try {
    body = await res.json()
  } catch (err) {
    body = null
  }

  if (!res.ok) {
    const error = new Error(
      (body && (body.message || body.error)) || `request failed (${res.status})`
    )
    error.status = res.status
    error.body = body
    throw error
  }

  return body
}

function apiPost(path, payload) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })
}


// =====================
// Server-owned limits
// =====================

// The frontend used to carry its own copies of these. GET /api/devices and
// POST /api/heartbeat already returned offlineAfterSeconds and the dashboard
// ignored it in favour of a hardcoded constant, which is how the two drift.
//
// The values below are a LAST RESORT for a page whose /api/config call failed;
// they are not the source of truth. config.js in the backend is.
const SERVER_CONFIG = {
  minPeriodSeconds: 2,
  maxPeriodSeconds: 3600,
  minSendSeconds: 5,
  maxSendSeconds: 3600,
  offlineAfterSeconds: 180,
  maxMistSeconds: 600,
  maxFanSeconds: 3600
}

async function loadServerConfig() {
  try {
    Object.assign(SERVER_CONFIG, await api(`/config`))
  } catch (err) {
    console.warn("/api/config unavailable, using built-in defaults:", err.message)
  }
  return SERVER_CONFIG
}


// =====================
// Sensor selection
// =====================

// The checkbox list is the same control on both pages. script.js re-ran this
// query inline in each of its three chart updates; wind3.js already had it as
// a function. One copy.
function getSelectedSensors() {
  return [...document.querySelectorAll("#checkboxes input:checked")]
    .map(c => c.value)
}

// A reading is labelled by what it measures and where. Both pages derive it the
// same way from a /api/logs row.
function sensorNameOf(row) {
  return (
    row.sensorDescription ||
    ((row.sensorType || row.locationName)
      ? `${row.sensorType || "unknown"}_${row.locationName || "unknown"}`
      : "unknown")
  )
}
