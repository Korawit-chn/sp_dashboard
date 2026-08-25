const API = window.CONFIG.API

let chart = null
let allData = []
let sensorsCreated = false


// =====================
// Load data
// =====================
async function loadData() {
  const res = await fetch(`${API}/logs?hours=2`)
  allData = (await res.json()).map(d => ({
    ...d,
    sensorName:
      d.sensorDescription ||
      ((d.sensorType || d.locationName)
        ? `${d.sensorType || 'unknown'}_${d.locationName || 'unknown'}`
        : 'unknown')
  }))
  console.log(allData)

  if (!sensorsCreated) {
    createSensorCheckboxes()
    buildChart()
    sensorsCreated = true
  }

  updateChart()
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

    label.onchange = updateChart
    container.appendChild(label)
  })
}


// =====================
// Build chart once
// =====================
function buildChart() {
  buildTempChart()
  buildHumiChart()
  buildVPDChart()
}


function buildTempChart() {
  tempChart = new Chart(document.getElementById("tempChart"), {
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
            text: "Value"
          }
        }
      }
    }
  })
}


function buildHumiChart() {
  humiChart = new Chart(document.getElementById("humiChart"), {
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
            text: "Value"
          }
        }
      }
    }
  })
}

function buildVPDChart() {
  VPDChart = new Chart(document.getElementById("VPDChart"), {
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
            text: "Value"
          }
        }
      }
    }
  })
}



// =====================
// Update datasets
// =====================
function updateChart() {
  updateTempChart()
  updateHumiChart()
  updateVPDChart()
}

function updateTempChart() {
  const selectedSensors =
    [...document.querySelectorAll("#checkboxes input:checked")]
      .map(c => c.value)

  const datasets = []

  selectedSensors.forEach(sensor => {

    const sensorData = allData.filter(d => d.sensorName === sensor)

    datasets.push({
      label: `${sensor}`,
      data: sensorData
        .filter(d => d.temperature !== null)
        .map(d => ({
          x: new Date(d.datetime),
          y: d.temperature
        })),
      fill: false
    })
  
  })

  tempChart.data.datasets = datasets
  tempChart.update()
}

function updateHumiChart() {
  const selectedSensors =
    [...document.querySelectorAll("#checkboxes input:checked")]
      .map(c => c.value)

  const datasets = []

  selectedSensors.forEach(sensor => {

    const sensorData = allData.filter(d => d.sensorName === sensor)
 
    datasets.push({
      label: `${sensor}`,
      data: sensorData
        .filter(d => d.humidity !== null)
        .map(d => ({
          x: new Date(d.datetime),
          y: d.humidity
        })),
      fill: false
    })


  })

  humiChart.data.datasets = datasets
  humiChart.update()
}

function updateVPDChart() {
  const selectedSensors =
    [...document.querySelectorAll("#checkboxes input:checked")]
      .map(c => c.value)

  const datasets = []

  selectedSensors.forEach(sensor => {

    const sensorData = allData.filter(d => d.sensorName === sensor)
 
    datasets.push({
      label: `${sensor}`,
      data: sensorData
        .filter(d => d.VPD !== null)
        .map(d => ({
          x: new Date(d.datetime),
          y: d.VPD
        })),
      fill: false
    })


  })

  VPDChart.data.datasets = datasets
  VPDChart.update()
}


// =====================
// Start
// =====================
loadData()
setInterval(loadData, 2500)
