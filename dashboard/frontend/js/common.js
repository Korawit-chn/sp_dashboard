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
  maxFanSeconds: 3600,
  maxLogHours: 168,
  defaultLogHours: 6
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
//
// Returns sensorIDs, not names. The checkbox used to carry the display name and
// both pages filtered by string, which meant two sensors that both fell through
// to "unknown" in sensorNameOf() merged into one series - and, worse, that
// nothing downstream knew a sensor's ID, so the charts had no way to obey the
// colour rule. The ID is what identifies a sensor; the name is what you show.
function getSelectedSensors() {
  return [...document.querySelectorAll("#checkboxes input:checked")]
    .map(c => Number(c.value))
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

// The sensors present in a set of /api/logs rows, as { sensorID, name }.
//
// Sorted by sensorID rather than by first appearance, so the checkbox order is
// the same on both pages and does not reshuffle when a quiet sensor's first
// reading lands later in the window. Colour does not depend on this order - see
// sensorColors.js - but the reading order of the list should still be stable.
function sensorListOf(rows) {
  const byId = new Map()

  rows.forEach(row => {
    if (row.sensorID == null) return
    const id = Number(row.sensorID)
    if (!byId.has(id)) byId.set(id, { sensorID: id, name: sensorNameOf(row) })
  })

  return [...byId.values()].sort((a, b) => a.sensorID - b.sensorID)
}

// Both pages built this list with the same loop, so the swatch colour would
// have had to be written in two files. One builder instead: sensorColors.js
// stays the only place a sensor colour is decided.
//
// The swatch is decoration - the name next to it is what carries sensor
// identity for anyone who cannot separate blue from cyan. Never drop the text.
function renderSensorCheckboxes(container, sensors, onChange) {
  // Ticks survive a rebuild. Changing the time range can bring a sensor into
  // the window that was not in it before, so this list is no longer built once
  // - and a rebuild that silently re-ticked a sensor the user had turned off
  // would put a line back on the chart they had deliberately removed.
  const previous = new Map(
    [...container.querySelectorAll("input[type=checkbox]")]
      .map(input => [Number(input.value), input.checked])
  )

  container.innerHTML = ""

  sensors.forEach(sensor => {
    const label = document.createElement("label")

    const input = document.createElement("input")
    input.type = "checkbox"
    input.value = sensor.sensorID

    // defaultChecked, not .checked: it sets the `checked` ATTRIBUTE, which is
    // what the hand-written markup here used to carry. With only the property
    // set, the boxes start ticked but their default is "off", so the browser's
    // own form-state restoration on a reload hands back a different set of
    // ticks than the one that was on screen.
    // A sensor seen before keeps its tick; one that has just appeared starts on.
    input.defaultChecked = previous.has(sensor.sensorID)
      ? previous.get(sensor.sensorID)
      : true

    // Same reason, belt and braces: this list is rebuilt from live data, so
    // restoring stale ticks into it is never wanted.
    input.autocomplete = "off"

    const swatch = document.createElement("span")
    swatch.className = "sensor-swatch"
    swatch.style.background = sensorColor(sensor.sensorID)

    label.append(input, swatch, document.createTextNode(sensor.name))
    label.onchange = onChange

    container.appendChild(label)
  })
}


// =====================
// Time range
//
// One control for both pages. index.html had none at all - script.js asked for
// a hardcoded ?hours=2 - and wind3.js carried its own copy, so this is the same
// de-duplication the checkbox list above got.
//
// The window is state, not DOM: currentTimeQuery() is read by each page's
// loadData(), so nothing outside here has to know which mode is selected.
// =====================

// Ceilings come from the server (see SERVER_CONFIG); anything past maxLogHours
// is refused by /api/logs with a 400, so it is never offered.
const TIME_PRESETS = [
  { label: "Last 1 hour",   hours: 1 },
  { label: "Last 6 hours",  hours: 6 },
  { label: "Last 24 hours", hours: 24 },
  { label: "Last 3 days",   hours: 72 },
  { label: "Last 7 days",   hours: 168 }
]

let timeRange = { mode: "hours", hours: 6, start: null, end: null }

// datetime-local gives "2026-09-13T01:30". MySQL takes a DATETIME literal with
// a space, and routes/sensors.js puts this value straight into the query, so
// the T is normalised away here rather than relied on.
function toSqlish(value) {
  return value ? `${value.replace("T", " ")}:00`.slice(0, 19) : value
}

// The query string for the selected window, "?" included.
function currentTimeQuery() {
  if (timeRange.mode === "custom") {
    return `?start=${encodeURIComponent(toSqlish(timeRange.start))}` +
           `&end=${encodeURIComponent(toSqlish(timeRange.end))}`
  }

  if (timeRange.mode === "fromNow") {
    return `?start=${encodeURIComponent(toSqlish(timeRange.start))}`
  }

  return `?hours=${timeRange.hours}`
}

// Whether the window tracks "now". A closed custom range does not, and that is
// what decides whether there is any point polling.
function isLiveRange() {
  return timeRange.mode !== "custom"
}

// Roughly how many hours wide the window is - used to pick a refresh interval.
function currentWindowHours() {
  if (timeRange.mode === "hours") return timeRange.hours

  const from = new Date(timeRange.start).getTime()
  if (!Number.isFinite(from)) return SERVER_CONFIG.defaultLogHours

  const to = timeRange.mode === "custom" ? new Date(timeRange.end).getTime() : Date.now()
  return Math.max(0, (to - from) / 3600000)
}


// =====================
// Polling
//
// A flat 2.5 s was fine for a hardcoded 2-hour window. It is not fine now the
// window can be 7 days: the note in routes/sensors.js puts 6 hours at ~17k rows
// across four Pis, so a 7-day window is a few hundred thousand - and refetching
// that every 2.5 s, off the same disk the Pis are uploading to, is a denial of
// service we would be running against ourselves.
//
// A CLOSED range is not polled at all. Its answer cannot change.
// =====================

let pollTimer = null

function pollIntervalMs() {
  if (!isLiveRange()) return null

  const hours = currentWindowHours()
  if (hours <= 6) return 2500
  if (hours <= 24) return 10000
  if (hours <= 72) return 30000
  return 60000
}

// Loads now, then keeps reloading for as long as the window tracks "now".
// Call it again after the range changes; it cancels the timer it replaces.
function startPolling(loadFn) {
  clearTimeout(pollTimer)

  const tick = () => {
    // Rescheduled in finally, not after a success: a load that throws must
    // still queue the next one, or one blocked request stops the dashboard
    // updating for good.
    Promise.resolve()
      .then(loadFn)
      .catch(err => console.error("load failed:", err.message))
      .finally(() => {
        const ms = pollIntervalMs()
        if (ms != null) pollTimer = setTimeout(tick, ms)
      })
  }

  tick()
}


// =====================
// The control itself
// =====================

// Builds the picker into `container` and calls onChange() whenever the selected
// window changes. Presets past the server's ceiling are dropped rather than
// offered and then refused.
function renderTimeControls(container, onChange) {
  const maxHours = SERVER_CONFIG.maxLogHours
  const presets = TIME_PRESETS.filter(p => p.hours <= maxHours)

  timeRange = {
    mode: "hours",
    hours: presets.some(p => p.hours === SERVER_CONFIG.defaultLogHours)
      ? SERVER_CONFIG.defaultLogHours
      : presets[0].hours,
    start: null,
    end: null
  }

  container.innerHTML = ""

  const select = document.createElement("select")
  presets.forEach(p => select.add(new Option(p.label, `hours:${p.hours}`)))
  select.add(new Option("Custom range", "custom"))
  select.add(new Option("From time \u2192 Now", "fromNow"))
  select.value = `hours:${timeRange.hours}`

  const label = document.createElement("label")
  label.append("Time range: ", select)

  const status = document.createElement("span")
  status.className = "muted"

  // --- custom range ---
  const customBox = document.createElement("span")
  const startInput = document.createElement("input")
  const endInput = document.createElement("input")
  const customApply = document.createElement("button")
  startInput.type = endInput.type = "datetime-local"
  customApply.textContent = "Apply"
  customBox.append(" ", startInput, " \u2192 ", endInput, " ", customApply)
  customBox.hidden = true

  // --- from now ---
  const fromBox = document.createElement("span")
  const fromInput = document.createElement("input")
  const fromApply = document.createElement("button")
  fromInput.type = "datetime-local"
  fromApply.textContent = "Apply"
  fromBox.append(" ", fromInput, " ", fromApply)
  fromBox.hidden = true

  container.append(label, customBox, fromBox, " ", status)

  // 2500 ms is "every 2.5s", not the "every 3s" a plain round gives.
  const everySeconds = () => {
    const s = pollIntervalMs() / 1000
    return Number.isInteger(s) ? s : s.toFixed(1)
  }

  const describe = () => {
    const live = isLiveRange()
    const span = currentWindowHours()

    if (timeRange.mode === "hours") {
      status.textContent = `showing the last ${timeRange.hours}h, ` +
        `refreshing every ${everySeconds()}s`
    } else if (timeRange.mode === "fromNow") {
      status.textContent = `showing ${timeRange.start.replace("T", " ")} \u2192 now ` +
        `(${span.toFixed(1)}h), refreshing every ${everySeconds()}s`
    } else {
      status.textContent = `showing ${timeRange.start.replace("T", " ")} \u2192 ` +
        `${timeRange.end.replace("T", " ")} (${span.toFixed(1)}h) - fixed range, not refreshing`
    }

    return live
  }

  // Checked HERE rather than left to the server, because the server's answer to
  // a malformed window is not an error the user would notice. An empty
  // datetime-local sends start=&end=, both falsy, so /api/logs falls through to
  // its default 6 hours and returns a 200 - a chart that looks perfectly normal
  // and answers a different question than the one that was asked.
  function faultIn(start, end) {
    if (!start) return "pick a start time"

    const from = new Date(start).getTime()
    if (!Number.isFinite(from)) return "start time is not a date"

    const to = end ? new Date(end).getTime() : Date.now()
    if (end && !Number.isFinite(to)) return "end time is not a date"
    if (to <= from) return "the end time must be after the start time"

    const hours = (to - from) / 3600000
    if (hours > SERVER_CONFIG.maxLogHours) {
      return `that is ${hours.toFixed(0)}h; the server allows at most ` +
             `${SERVER_CONFIG.maxLogHours}h`
    }

    return null
  }

  const applied = () => {
    describe()
    onChange()
  }

  select.onchange = () => {
    customBox.hidden = select.value !== "custom"
    fromBox.hidden = select.value !== "fromNow"

    // A preset applies immediately; the two custom modes wait for Apply, since
    // neither has a usable value yet.
    if (select.value.startsWith("hours:")) {
      timeRange = { mode: "hours", hours: Number(select.value.slice(6)), start: null, end: null }
      applied()
    } else {
      status.textContent = "pick a time, then Apply"
    }
  }

  customApply.onclick = () => {
    const fault = faultIn(startInput.value, endInput.value)
    if (!endInput.value) return (status.textContent = "pick an end time")
    if (fault) return (status.textContent = fault)

    timeRange = { mode: "custom", hours: null, start: startInput.value, end: endInput.value }
    applied()
  }

  fromApply.onclick = () => {
    const fault = faultIn(fromInput.value, null)
    if (fault) return (status.textContent = fault)

    timeRange = { mode: "fromNow", hours: null, start: fromInput.value, end: null }
    applied()
  }

  describe()
}
