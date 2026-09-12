// =====================
// Temperature / Humidity / VPD charts
//
// The three charts are one chart built three times. SERIES is the only thing
// that differs between them, so a fourth chart is a row in that table plus a
// <canvas> in index.html - not another 60 lines.
//
// API, getSelectedSensors(), sensorListOf(), renderSensorCheckboxes(),
// renderTimeControls(), currentTimeQuery(), startPolling() and api() come from
// common.js; sensorColor() from sensorColors.js.
// =====================

const SERIES = [
  { canvas: "tempChart", field: "temperature", label: "Temp (C)" },
  { canvas: "humiChart", field: "humidity",    label: "Humidity (%)" },
  { canvas: "VPDChart",  field: "VPD",         label: "VPD (kPa)" }
]

// canvas id -> Chart instance. These used to be three implicit globals created
// by assignment inside the build functions, which worked only because this file
// is not in strict mode.
const charts = {}

let allData = []

// The sensorIDs the checkbox list was last built for. It used to be a boolean -
// built once, never again - which was fine when the window was a hardcoded two
// hours. With a time picker, widening the range can bring in a sensor that was
// not reporting during the old one, and it has to appear in the list.
let sensorKey = null

// sensorID -> display name. Refreshed with the data so a sensor that is renamed
// or relocated picks the new label up, and so updateCharts() does not rescan
// every row to find one name three times a refresh.
let sensorNames = new Map()


// =====================
// Load data
// =====================
async function loadData() {
  try {
    const rows = await api(`/logs${currentTimeQuery()}`)
    allData = rows.map(d => ({ ...d, sensorName: sensorNameOf(d) }))
    sensorNames = new Map(sensorListOf(allData).map(s => [s.sensorID, s.name]))
  } catch (err) {
    console.error("logs unavailable:", err.message)
    return
  }

  const sensors = sensorListOf(allData)
  const key = sensors.map(s => s.sensorID).join(",")

  // Only when the SET changes - rebuilding this on every poll would fight the
  // user for the checkbox they are in the middle of clicking.
  if (key !== sensorKey) {
    sensorKey = key
    createSensorCheckboxes(sensors)
  }

  if (!charts.tempChart) buildCharts()

  updateCharts()
}


// =====================
// Create sensor toggles
// =====================
function createSensorCheckboxes(sensors) {
  renderSensorCheckboxes(
    document.getElementById("checkboxes"),
    sensors,
    updateCharts
  )
}


// =====================
// Build charts once
// =====================
function buildCharts() {
  SERIES.forEach(series => {
    charts[series.canvas] = new Chart(document.getElementById(series.canvas), {
      type: "line",
      data: { datasets: [] },
      options: {
        animation: false,
        responsive: true,
        interaction: {
          mode: "nearest",
          intersect: false
        },
        scales: {
          x: {
            type: "time",
            time: { unit: "minute" }
          },
          y: {
            title: {
              display: true,
              text: series.label
            }
          }
        }
      }
    })
  })
}


// =====================
// Update datasets
// =====================
function updateCharts() {
  // Read the checkboxes once for all three charts, not once per chart.
  const selectedSensors = getSelectedSensors()

  SERIES.forEach(series => {
    const chart = charts[series.canvas]
    if (!chart) return

    chart.data.datasets = selectedSensors.map(sensorID => {
      // The colour comes from the ID, so it is the same on all three panels -
      // sensor 3's temperature, humidity and VPD all draw green. It is the
      // sensor that identifies a line; the y-axis already says which metric
      // the panel shows. Do NOT vary it by metric.
      const color = sensorColor(sensorID)

      return {
        label: sensorNames.get(sensorID) || `sensor ${sensorID}`,
        data: allData
          .filter(d => Number(d.sensorID) === sensorID && d[series.field] !== null)
          .map(d => ({ x: new Date(d.datetime), y: d[series.field] })),
        // Both, not just borderColor: Chart.js fills the points from its own
        // default cycle otherwise. Setting both also makes the built-in legend
        // swatch right for free.
        borderColor: color,
        backgroundColor: color,
        pointBackgroundColor: color,
        fill: false
      }
    })

    chart.update()
  })
}


// =====================
// Start
//
// The config call comes first: renderTimeControls() reads maxLogHours from it
// to decide which presets it can offer, and startPolling() reads the window to
// decide how often to reload. loadServerConfig() falls back to the built-in
// defaults on its own if the call fails, so this cannot leave the page blank.
// =====================
async function start() {
  await loadServerConfig()

  renderTimeControls(
    document.getElementById("timeControls"),
    () => {
      // The sensor set is window-dependent, so a new range rebuilds the list.
      sensorKey = null
      startPolling(loadData)
    }
  )

  startPolling(loadData)
}

start()
