// =====================
// Sampling interval + device on/off panel
// =====================
// API, api(), apiPost(), formatAge() and SERVER_CONFIG come from common.js.
// The sampling limits are the server's - see GET /api/config.


// =====================
// Sampling schedule
// =====================
async function loadSchedule() {
  const status = document.getElementById("scheduleStatus")

  try {
    const s = await api(`/schedule`)

    // Placeholders, not values: an empty box means "leave this one alone",
    // which is what lets you change one interval without restating the other.
    document.getElementById("periodInput").placeholder = s.periodSeconds
    document.getElementById("sendInput").placeholder = s.sendSeconds

    const effective = new Date(s.effectiveFromMs)
    const pending = s.effectiveFromMs > s.serverEpochMs

    // Only the period has a switch instant. The upload interval takes effect
    // on each Pi as it polls, so there is no single time to name for it.
    const intervals = `sampling every ${s.periodSeconds}s, uploading every ${s.sendSeconds}s`

    status.textContent = pending
      ? `${intervals} - the new period takes effect at ${effective.toLocaleTimeString()}`
      : `${intervals} - active since ${effective.toLocaleString()}`

    // The PC and the Pis share a clock now, so a browser clock that disagrees
    // with the server is worth surfacing - it makes chart times look wrong.
    const skew = Math.abs(Date.now() - s.serverEpochMs)
    document.getElementById("clockSkew").textContent =
      skew > 5000 ? `browser clock differs from the server by ~${Math.round(skew / 1000)}s` : ""

  } catch (err) {
    status.textContent = "schedule unavailable"
  }
}

async function applySchedule() {
  const periodInput = document.getElementById("periodInput")
  const sendInput = document.getElementById("sendInput")
  const status = document.getElementById("scheduleStatus")

  // Either box may be left blank. The current value is shown as a placeholder
  // and the server carries an omitted interval forward, so a blank period box
  // does not reset the upload interval and vice versa.
  const periodSeconds = periodInput.value === ""
    ? Number(periodInput.placeholder)
    : Number(periodInput.value)

  const sendSeconds = sendInput.value === ""
    ? Number(sendInput.placeholder)
    : Number(sendInput.value)

  if (!Number.isInteger(periodSeconds) ||
      periodSeconds < SERVER_CONFIG.minPeriodSeconds ||
      periodSeconds > SERVER_CONFIG.maxPeriodSeconds) {
    status.textContent =
      `period must be a whole number of seconds, ` +
      `${SERVER_CONFIG.minPeriodSeconds} to ${SERVER_CONFIG.maxPeriodSeconds}`
    return
  }

  if (!Number.isInteger(sendSeconds) ||
      sendSeconds < SERVER_CONFIG.minSendSeconds ||
      sendSeconds > SERVER_CONFIG.maxSendSeconds) {
    status.textContent =
      `upload interval must be a whole number of seconds, ` +
      `${SERVER_CONFIG.minSendSeconds} to ${SERVER_CONFIG.maxSendSeconds}`
    return
  }

  // The server rejects this too; catching it here names the two boxes on the
  // screen instead of returning a 400 about field names.
  if (sendSeconds < periodSeconds) {
    status.textContent =
      `upload interval cannot be shorter than the sampling period ` +
      `(${sendSeconds}s < ${periodSeconds}s)`
    return
  }

  status.textContent = "applying..."

  try {
    // leadSeconds gives every Pi time to poll before the switch instant, so
    // they all change period on the same tick instead of scattering.
    const body = await apiPost(`/schedule`,
      { periodSeconds, sendSeconds, leadSeconds: 30 })

    periodInput.value = ""
    sendInput.value = ""
    const at = new Date(body.effectiveFromMs)
    status.textContent =
      `sampling every ${body.periodSeconds}s from ${at.toLocaleTimeString()}, ` +
      `uploading every ${body.sendSeconds}s`

  } catch (err) {
    status.textContent = "failed: " + err.message
  }
}


// =====================
// Device on/off state
// =====================

// A device is a Pi, and what makes one recognisable is what it measures and
// where - not 36 characters of hex. The full UUID stays on the row as a
// tooltip, for the times you genuinely need to match it to a device_uuid.txt.
function deviceLabel(d) {
  if (d.hostname) return d.hostname
  if (d.description) return d.description

  // Set(): two DHT22s at the same location would otherwise print twice.
  const sensors = [...new Set(
    (d.sensors || []).map(s => `${s.sensorType || "sensor"} @ ${s.locationName || "?"}`)
  )]

  if (sensors.length) return sensors.join(", ")

  return d.deviceUUID ? d.deviceUUID.slice(0, 8) : `device ${d.deviceID}`
}

async function loadDevices() {
  const tbody = document.querySelector("#deviceTable tbody")
  const note = document.getElementById("deviceNote")

  try {
    const body = await api(`/devices`)

    // A Pi that loses power cannot report its own death, so "offline" is
    // always inferred - and right after a backend restart every Pi looks dead.
    note.textContent = body.inStartupGrace
      ? "backend just restarted - offline detection is suppressed for now"
      : ""

    tbody.innerHTML = ""

    // A row is a Pi, not a sensor - one power cut is one row, however many
    // sensors that Pi carries. deviceLabel() names it after what it measures.
    body.devices.forEach(d => {
      const row = document.createElement("tr")

      const label = deviceLabel(d)

      row.innerHTML = `
        <td>${d.deviceID}</td>
        <td title="${d.deviceUUID || ""}">${label}</td>
        <td>${d.connectionStatus === "ONLINE" ? "ONLINE" : d.connectionStatus.toLowerCase()}</td>
        <td>${formatAge(d.secondsSinceLastSeen)}</td>
        <td>${d.bootAtMs ? new Date(d.bootAtMs).toLocaleString() : "-"}</td>
      `

      tbody.appendChild(row)
    })

  } catch (err) {
    note.textContent = "device status unavailable"
  }
}

// =====================
// Start
// =====================
document.getElementById("applyPeriod").onclick = applySchedule

function refreshDevicePanel() {
  loadSchedule()
  loadDevices()
}

// The limits are fetched once, then the input is labelled with them rather than
// with numbers typed into the HTML that nothing keeps in step.
loadServerConfig().then(cfg => {
  const period = document.getElementById("periodInput")
  period.min = cfg.minPeriodSeconds
  period.max = cfg.maxPeriodSeconds

  const periodLabel = document.getElementById("periodLabel")
  if (periodLabel) periodLabel.textContent = `Period (seconds, minimum ${cfg.minPeriodSeconds}):`

  const send = document.getElementById("sendInput")
  send.min = cfg.minSendSeconds
  send.max = cfg.maxSendSeconds

  const sendLabel = document.getElementById("sendLabel")
  if (sendLabel) sendLabel.textContent = `Upload every (seconds, minimum ${cfg.minSendSeconds}):`
})

refreshDevicePanel()
setInterval(refreshDevicePanel, 10000)
