// =====================
// Actuator control panels - mist makers and fans
//
// Both sections are one panel driven by a dropdown, not a panel per device.
// createPicker() holds everything they share; each type supplies only its own
// controls and its own status line.
// =====================
const ACTUATOR_API = window.CONFIG.API

const MIST_TYPE = "Mist Maker"
const FAN_TYPE = "FAN"

const DEFAULT_RUN_SECONDS = 60

// Devices report at least once a minute. Three missed reports is the point at
// which we stop believing the status column - see the note in createPicker().
const OFFLINE_AFTER_MS = 3 * 60 * 1000


// =====================
// Shared
// =====================

// ID first, because it is the thing you quote when reading the ActuatorLog or
// curling the API, and it stays stable when someone renames a location.
function optionLabel(actuator) {
  return `#${actuator.actuatorID} - ${actuator.locationName || "no location"}`
}

// mysql2 hands back DECIMAL as a STRING ("50.00"), not a number, because a JS
// double cannot represent every DECIMAL exactly. Harmless until you compare or
// do arithmetic with it, so convert once here rather than at each use.
function toNumber(value) {
  if (value == null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function freshness(actuator, serverEpochMs) {
  // lastTelemetryAt is the heartbeat, and it is the right field to judge
  // liveness by. statusUpdatedAt only moves when a command is issued, so a
  // device sitting idle for an hour would look dead by that measure.
  const lastSeenMs = actuator.lastTelemetryAt
    ? new Date(actuator.lastTelemetryAt).getTime()
    : null

  // Measured against the SERVER's clock, not the browser's - a laptop with a
  // wrong clock would otherwise show every device as offline.
  const age = lastSeenMs == null ? null : serverEpochMs - lastSeenMs

  return { age, offline: age == null || age > OFFLINE_AFTER_MS }
}

async function sendCommand(payload, status, describe) {
  status.textContent = "sending..."

  try {
    const res = await fetch(`${ACTUATOR_API}/actuatorCommand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })

    const body = await res.json()

    if (!res.ok) {
      // 400s carry `message`, 500s carry `error`. Reading only `message` made
      // every server-side failure show up as a bare "failed", which hides the
      // one thing worth knowing.
      status.textContent = body.message || body.error || `failed (${res.status})`
      console.error("actuatorCommand failed:", res.status, body)
      return
    }

    status.textContent = describe(body)
    loadActuators()

  } catch (err) {
    status.textContent = "failed: " + err.message
  }
}


// =====================
// The picker both sections are built from
// =====================

function createPicker({ containerID, noteID, empty, controls, onSelect, statusText }) {
  const note = document.getElementById(noteID)

  const root = document.createElement("div")
  root.className = "panel"

  const select = document.createElement("select")
  const status = document.createElement("span")
  const seen = document.createElement("div")

  status.className = "muted"
  seen.className = "muted"

  let list = []
  let selectedID = null
  let signature = ""

  const selected = () => list.find(a => a.actuatorID === selectedID) || null

  select.onchange = () => {
    selectedID = Number(select.value)
    status.textContent = ""
    if (onSelect) onSelect(selected())
    loadActuators()
  }

  const picker = document.createElement("div")
  picker.append("Device ", select, " ", status)

  root.append(picker, controls({ selected, status }), seen)
  document.getElementById(containerID).appendChild(root)

  return function update(found, serverEpochMs) {
    list = found
    note.textContent = found.length ? "" : empty
    root.style.display = found.length ? "" : "none"

    if (!found.length) return

    // Options are rebuilt only when the SET of devices changes. Repopulating a
    // <select> on every poll would slam shut a dropdown the user had open.
    const next = found.map(optionLabel).join("|")

    if (next !== signature) {
      signature = next
      select.innerHTML = ""

      found.forEach(a => {
        const option = document.createElement("option")
        option.value = a.actuatorID
        option.textContent = optionLabel(a)
        select.appendChild(option)
      })

      // Keep the current choice if it still exists; otherwise fall back to the
      // first rather than leaving the panel pointed at nothing.
      if (!selected()) {
        selectedID = found[0].actuatorID
        if (onSelect) onSelect(selected())
      }

      select.value = selectedID
    }

    const actuator = selected()
    const { age, offline } = freshness(actuator, serverEpochMs)

    // A device that is not reporting is exactly when its status is least
    // trustworthy: it still holds whatever was last written, which may be the
    // dashboard's own optimistic guess from a command that never arrived. Say
    // "unknown" rather than claiming a state.
    status.textContent = offline ? "[ offline - state unknown ]" : statusText(actuator)

    root.style.opacity = offline ? "0.6" : "1"
    seen.textContent = age == null
      ? "never reported"
      : `last seen ${formatAge(Math.floor(age / 1000))}`
  }
}


// =====================
// Mist maker
// =====================

const updateMist = createPicker({
  containerID: "mistPanels",
  noteID: "mistNote",
  empty: "no mist maker has registered yet",

  controls({ selected, status }) {
    const durationInput = document.createElement("input")
    const startButton = document.createElement("button")
    const stopButton = document.createElement("button")

    durationInput.type = "number"
    durationInput.min = "1"
    durationInput.max = "600"
    durationInput.step = "1"
    durationInput.size = 5
    durationInput.placeholder = DEFAULT_RUN_SECONDS

    startButton.textContent = "Start"
    stopButton.textContent = "Stop"

    startButton.onclick = () => {
      const mister = selected()
      if (!mister) return

      sendCommand(
        {
          actuatorID: mister.actuatorID,
          action: "ON",
          durationSeconds: Number(durationInput.value) || DEFAULT_RUN_SECONDS
        },
        status,
        // The server clamps the duration to its own maximum and the Pi clamps
        // it again from config.txt, so report what was stored, not what was
        // asked for.
        body => `queued - ${body.durationSeconds}s`
      )
    }

    // Never disabled, not even when the panel thinks the mister is already
    // off. If the Pi's believed state has drifted, Stop is the thing that has
    // to stay reachable.
    stopButton.onclick = () => {
      const mister = selected()
      if (!mister) return

      sendCommand(
        { actuatorID: mister.actuatorID, action: "OFF" },
        status,
        () => "queued - stopping"
      )
    }

    const row = document.createElement("div")
    row.append("Run for ", durationInput, " seconds ", startButton, " ", stopButton)
    return row
  },

  statusText(mister) {
    const since = mister.statusUpdatedAtMs
      ? ` since ${new Date(mister.statusUpdatedAtMs).toLocaleTimeString()}`
      : ""
    return `[ ${mister.status}${since} ]`
  }
})


// =====================
// Fan
// =====================

// Held outside controls() so switching fans can re-seed the handle.
let fanSlider = null
let fanReadout = null

function seedFanSlider(fan) {
  const duty = fan ? toNumber(fan.lastDutyPercent) ?? 0 : 0
  fanSlider.value = duty
  fanReadout.textContent = `${fanSlider.value}%`
}

const updateFan = createPicker({
  containerID: "fanPanels",
  noteID: "fanNote",
  empty: "no fan has registered yet",

  controls({ selected, status }) {
    const slider = document.createElement("input")
    const readout = document.createElement("span")
    const offButton = document.createElement("button")
    const fullButton = document.createElement("button")

    slider.type = "range"
    slider.min = "0"
    slider.max = "100"
    slider.step = "5"
    slider.value = 0

    readout.textContent = "0%"
    offButton.textContent = "Off"
    fullButton.textContent = "Full"

    fanSlider = slider
    fanReadout = readout

    const setSpeed = duty => {
      const fan = selected()
      if (!fan) return

      slider.value = duty
      readout.textContent = `${duty}%`

      sendCommand(
        { actuatorID: fan.actuatorID, action: "SET_SPEED", pwmDutyPercent: duty },
        status,
        () => `sent ${duty}% to #${fan.actuatorID}`
      )
    }

    // `input` fires continuously while dragging; only the label follows it.
    // `change` fires once the handle is released, and that is what commands
    // the fan - a request per pixel of drag would flood the backend and the Pi.
    slider.oninput = () => { readout.textContent = `${slider.value}%` }
    slider.onchange = () => setSpeed(Number(slider.value))

    offButton.onclick = () => setSpeed(0)
    fullButton.onclick = () => setSpeed(100)

    const row = document.createElement("div")
    row.append("Speed ", slider, " ", readout, " ", offButton, " ", fullButton)
    return row
  },

  // Switching fans re-seeds the slider from THAT fan's reported duty, so the
  // handle starts where the chosen fan actually is rather than carrying the
  // previous fan's setting across to it. Never called from the poll, only on
  // selection - otherwise it would yank the handle out from under a drag.
  onSelect: seedFanSlider,

  statusText(fan) {
    const duty = toNumber(fan.lastDutyPercent)
    const rpm = fan.lastRpm

    // Duty leads, not `status`. The backend marks an actuator ON for any
    // SET_SPEED, including SET_SPEED 0 - so a stopped fan can read "ON".
    // The reported duty is the honest answer.
    return duty == null
      ? "[ no reading yet ]"
      : `[ ${duty}%${rpm == null ? "" : ` · ${rpm} rpm`} ]`
  }
})


// =====================
// Poll
// =====================

// One fetch feeds both sections - same endpoint, same interval, so two polls
// would be twice the traffic for nothing.
async function loadActuators() {
  try {
    const res = await fetch(`${ACTUATOR_API}/actuators`)
    const body = await res.json()

    updateMist(body.actuators.filter(a => a.typeName === MIST_TYPE), body.serverEpochMs)
    updateFan(body.actuators.filter(a => a.typeName === FAN_TYPE), body.serverEpochMs)

  } catch (err) {
    document.getElementById("mistNote").textContent = "actuator status unavailable"
    document.getElementById("fanNote").textContent = ""
  }
}


// =====================
// Start
// =====================
loadActuators()
setInterval(loadActuators, 5000)
