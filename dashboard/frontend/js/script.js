// =====================
// Temperature / Humidity / VPD charts
//
// The three charts are one chart built three times. SERIES is the only thing
// that differs between them, so a fourth chart is a row in that table plus a
// <canvas> in index.html - not another 60 lines.
//
// API, getSelectedSensors(), sensorNameOf() and api() come from common.js.
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
let sensorsCreated = false


// =====================
// Load data
// =====================
async function loadData() {
  try {
    const rows = await api(`/logs?hours=2`)
    allData = rows.map(d => ({ ...d, sensorName: sensorNameOf(d) }))
  } catch (err) {
    console.error("logs unavailable:", err.message)
    return
  }

  if (!sensorsCreated) {
    createSensorCheckboxes()
    buildCharts()
    sensorsCreated = true
  }

  updateCharts()
}


// =====================
// Create sensor toggles
// =====================
function createSensorCheckboxes() {
  const sensors = [...new Set(allData.map(d => d.sensorName))]
  const container = document.getElementById("checkboxes")

  container.innerHTML = ""

  sensors.forEach(name => {
    const label = document.createElement("label")

    label.innerHTML = `
      <input type="checkbox" checked value="${name}">
      ${name}
    `

    label.onchange = updateCharts
    container.appendChild(label)
  })
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

    chart.data.datasets = selectedSensors.map(sensor => ({
      label: sensor,
      data: allData
        .filter(d => d.sensorName === sensor && d[series.field] !== null)
        .map(d => ({ x: new Date(d.datetime), y: d[series.field] })),
      fill: false
    }))

    chart.update()
  })
}


// =====================
// Start
// =====================
loadData()
setInterval(loadData, 2500)
