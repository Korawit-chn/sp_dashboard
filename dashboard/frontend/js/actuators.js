// =====================
// Actuator control panels - mist makers and fans
//
// Both sections are one panel driven by a dropdown, not a panel per device.
// createPicker() holds everything they share; each type supplies only its own
// controls and its own status line.
// =====================
// API, api(), apiPost(), toNumber() and formatAge() come from common.js.

const MIST_TYPE = "Mist Maker"
const FAN_TYPE = "FAN"

// Neither panel carries a default run length any more. Both duration boxes
// start empty, and empty now MEANS something - run until Stop - so filling one
// in with a suggested number would quietly pick the other mode for the user.


// =====================
// Shared
// =====================

// ID first, because it is the thing you quote when reading the ActuatorLog or
// curling the API, and it stays stable when someone renames a location.
function optionLabel(actuator) {
  return `#${actuator.actuatorID} - ${actuator.locationName || "no location"}`
}

// The browser does not decide when anything is dead - the server owns
// connectionStatus, and it is now the status of the actuator's PI, reported by
// that Pi's device agent. The actuator panel and the device table therefore
// read the same field and cannot disagree.
//
// What that field does NOT say: whether the actuator's own control loop is
// alive. A crashed relay_control.py on a Pi whose agent is still beating reads
// ONLINE. Restart=always in mist.service is the mitigation - see
// AI Assistant/deviceAgentPlan.md.
//
// lastTelemetryAt is the Pi's last heartbeat, measured against the SERVER's
// clock rather than the browser's - a laptop with a wrong clock would otherwise
// show every device as offline.
function freshness(actuator, serverEpochMs) {
  const lastSeenMs = actuator.lastTelemetryAt
    ? new Date(actuator.lastTelemetryAt).getTime()
    : null

  const age = lastSeenMs == null ? null : serverEpochMs - lastSeenMs

  return { age, offline: actuator.connectionStatus !== "ONLINE" }
}

async function sendCommand(payload, status, describe) {
  status.textContent = "sending..."

  try {
    const body = await apiPost(`/actuatorCommand`, payload)

    status.textContent = describe(body)
    loadActuators()

  } catch (err) {
    // api() has already picked the right field out of the reply - 400s carry
    // `message`, 500s carry `error` - so there is one failure path here.
    status.textContent = err.status ? err.message : "failed: " + err.message
    if (err.status) console.error("actuatorCommand failed:", err.status, err.body)
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

    // An unreachable Pi is exactly when the stored status is least
    // trustworthy: it still holds whatever was last written, which may be the
    // dashboard's own optimistic guess from a command that never arrived. Name
    // what is actually known - the Pi is unreachable - rather than claiming a
    // hardware state we cannot confirm.
    status.textContent = offline ? "[ Pi unreachable - state unknown ]" : statusText(actuator)

    root.style.opacity = offline ? "0.6" : "1"
    seen.textContent = age == null
      ? "Pi has never reported"
      : `Pi last seen ${formatAge(Math.floor(age / 1000))}`
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
    // The server clamps to this too, and the Pi clamps again from config.txt.
    durationInput.max = String(SERVER_CONFIG.maxMistSeconds)
    durationInput.step = "1"
    durationInput.size = 5
    // Blank is a real choice here, not a missing value, so the placeholder
    // names it instead of suggesting a number the box does not actually use.
    durationInput.placeholder = "∞"

    startButton.textContent = "Start"
    stopButton.textContent = "Stop"

    startButton.onclick = () => {
      const mister = selected()
      if (!mister) return

      // Leaving the box empty is how you ask for a run with no timer: the
      // field is OMITTED rather than sent as 0 or null, because the server
      // stores a missing duration as NULL and the Pi reads NULL as "no
      // deadline, mist until an OFF arrives". A run started this way does not
      // stop by itself if the backend or the network goes away - see RUNS
      // WITH NO DEADLINE in mist_relay_control.py.
      const seconds = Number(durationInput.value)

      const command = { actuatorID: mister.actuatorID, action: "ON" }

      if (seconds > 0) command.durationSeconds = seconds

      sendCommand(
        command,
        status,
        // The server clamps the duration to its own maximum and the Pi clamps
        // it again from config.txt, so report what was stored, not what was
        // asked for.
        body => body.durationSeconds == null
          ? "queued - until Stop"
          : `queued - ${body.durationSeconds}s`
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
    row.append("Run for ", durationInput, " seconds (blank = until Stop) ",
               startButton, " ", stopButton)
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
    const durationInput = document.createElement("input")
    const startButton = document.createElement("button")
    const stopButton = document.createElement("button")

    slider.type = "range"
    slider.min = "0"
    slider.max = "100"
    slider.step = "5"
    slider.value = 0

    durationInput.type = "number"
    durationInput.min = "1"
    // The server clamps to this too, and the Pi clamps again from
    // config_fan.txt - same three-layer arrangement as the mist maker.
    durationInput.max = String(SERVER_CONFIG.maxFanSeconds)
    durationInput.step = "1"
    durationInput.size = 5
    // Blank is a real choice, not a missing value - same as the mist maker.
    durationInput.placeholder = "∞"

    readout.textContent = "0%"
    startButton.textContent = "Start"
    stopButton.textContent = "Stop"

    fanSlider = slider
    fanReadout = readout

    // The slider only STAGES a speed now; Start is what commands the fan.
    //
    // It used to send on release, which made the control a live dial: every
    // drag was a row in ActuatorLog and a command the Pi had to apply, and
    // there was no way to line up a speed and a run length and commit them
    // together. Speed and duration are one command, so they are sent by one
    // button - the same shape as the mist maker's Run for / Start.
    slider.oninput = () => { readout.textContent = `${slider.value}%` }

    startButton.onclick = () => {
      const fan = selected()
      if (!fan) return

      const duty = Number(slider.value)
      const seconds = Number(durationInput.value)

      // An empty box asks for a run with no timer, and the field is OMITTED to
      // say so - the server stores a missing duration as NULL and the Pi reads
      // NULL as "no deadline, spin until something stops me". Sending 0 would
      // mean something else entirely: run_until() reads a non-positive
      // duration as malformed and answers with MaxRun.
      //
      // A fan started this way does not stop by itself if this dashboard goes
      // away mid-run. Same trade as the mist maker's blank box.
      const command = {
        actuatorID: fan.actuatorID,
        action: "SET_SPEED",
        pwmDutyPercent: duty
      }

      if (seconds > 0) command.durationSeconds = seconds

      sendCommand(
        command,
        status,
        // Report what was STORED, not what was asked for: the server clamps
        // the duration to its own maximum and the Pi clamps it again.
        body => body.durationSeconds == null
          ? `queued - ${duty}% until Stop`
          : `queued - ${duty}% for ${body.durationSeconds}s`
      )
    }

    // Never disabled, and it deliberately carries no duration: Stop is the end
    // of a run, not a run of its own. Same reasoning as the mist maker's Stop -
    // if the panel and the hardware have come apart, this is the control that
    // has to keep working.
    stopButton.onclick = () => {
      const fan = selected()
      if (!fan) return

      slider.value = 0
      readout.textContent = "0%"

      sendCommand(
        { actuatorID: fan.actuatorID, action: "SET_SPEED", pwmDutyPercent: 0 },
        status,
        () => "queued - stopping"
      )
    }

    const row = document.createElement("div")
    row.append("Speed ", slider, " ", readout,
               " for ", durationInput, " seconds (blank = until Stop) ",
               startButton, " ", stopButton)
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
    const body = await api(`/actuators`)

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
