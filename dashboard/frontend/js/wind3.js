const API = window.CONFIG.API

let echart = null     // ECharts
let allData = []
let sensorsCreated = false

let timeMode = "hours"
let startTime = null
let endTime = null



// =====================
// Load data
// =====================
async function loadData() {
  let url = `${API}/logs`

  if (timeMode === "hours") {
    url += `?hours=6`
  } else if (timeMode === "custom") {
    url += `?start=${startTime}&end=${endTime}`
  } else if (timeMode === "fromNow") {
    url += `?start=${startTime}`
  }

  const res = await fetch(url)


  allData = (await res.json()).map(d => ({
    ...d,
    sensorName:
      d.sensorDescription ||
      ((d.sensorType || d.locationName)
        ? `${d.sensorType || 'unknown'}_${d.locationName || 'unknown'}`
        : 'unknown')
  }))

  // keep only rows with wind
  allData = allData.filter(d => d.windspeed !== null)

  if (!sensorsCreated) {
    createCheckboxes()
    setupToggle()
    sensorsCreated = true
  }

  renderChart()
}

// =====================
// Time Control
// =====================
function setupTimeControls() {
  const select = document.getElementById("timeSelect")
  const custom = document.getElementById("customRange")
  const fromNow = document.getElementById("fromNowRange")

  select.onchange = () => {
    custom.style.display = "none"
    fromNow.style.display = "none"

    if (select.value === "custom") {
      custom.style.display = "inline"
    } 
    else if (select.value === "fromNow") {
      fromNow.style.display = "inline"
    }
    else if (select.value === "hours") {
      timeMode = "hours"
      loadData()
    }
  }


  document.getElementById("applyTime").onclick = () => {
    timeMode = "custom"
    startTime = document.getElementById("startTime").value
    endTime = document.getElementById("endTime").value
    loadData()
  }

  document.getElementById("applyFromNow").onclick = () => {
    timeMode = "fromNow"
    startTime = document.getElementById("fromTime").value
    loadData()
  }
}




// =====================
// Toggle setup
// =====================
function setupToggle() {
  document.querySelectorAll("input[name='mode']")
    .forEach(r => {
      r.onchange = () => {
        currentMode = r.value
        renderChart()
      }
    })
}


// =====================
// Sensor checkboxes
// =====================
function createCheckboxes() {
  const sensors = [...new Set(allData.map(d => d.sensorName))]
  const container = document.getElementById("checkboxes")

  container.innerHTML = ""

  sensors.forEach(name => {
    const label = document.createElement("label")

    label.innerHTML = `
      <input type="checkbox" checked value="${name}">
      ${name}
    `

    label.onchange = renderChart
    container.appendChild(label)
  })
}


// =====================
// Render chart (switch)
// =====================
function renderChart() {
  // cleanup
  if (echart) {
    echart.clear()
  }

  document.getElementById("roseChart").style.display = "block"
  buildRoseChart()
}


// =====================
// WIND ROSE
// =====================
function buildRoseChart() {

  // =====================
  // Direction setup
  // =====================
  const DIR_LABELS = ["N","NE","E","SE","S","SW","W","NW"]
  const DIR_BINS = 8
  const DIR_STEP = 360 / DIR_BINS
  const HALF_STEP = DIR_STEP / 2

  function getDirIndex(deg) {
    // normalize 0–360
    deg = ((deg % 360) + 360) % 360

    // center N at 0°
    const shifted = (deg + HALF_STEP) % 360
    return Math.floor(shifted / DIR_STEP)
  }

  // =====================
  // Fixed wind speed bins
  // =====================
  const SPEED_BINS = [
    { label: "< 0.5 m/s",  min: 0,    max: 0.5,       color: "gray" }, // gray
    { label: "0.5-2 m/s",  min: 0.5,  max: 2,         color: "cyan" }, // cyan
    { label: "2-4 m/s",    min: 2,    max: 4,         color: "blue" }, // blue
    { label: "4-6 m/s",    min: 4,    max: 6,         color: "green" }, // green
    { label: "6-8 m/s",    min: 6,    max: 8,         color: "yellow" }, // yellow
    { label: "8-10 m/s",   min: 8,    max: 10,        color: "orange" }, // orange
    { label: "> 10 m/s",   min: 10,   max: Infinity, color: "red" }  // red
  ]

  // =====================
  // Data matrix
  // =====================
  const matrix = SPEED_BINS.map(() =>
    new Array(DIR_BINS).fill(0)
  )

  // =====================
  // Sensor filter
  // =====================
  const selectedSensors = getSelectedSensors()
  const filteredData = allData.filter(d =>
    selectedSensors.includes(d.sensorName)
  )

  // =====================
  // Fill matrix
  // =====================
  filteredData.forEach(d => {
    if (d.windspeed == null || d.windDirection == null) return

    const dirIndex = getDirIndex(d.windDirection)

    const speedIndex = SPEED_BINS.findIndex(
      b => d.windspeed >= b.min && d.windspeed < b.max
    )

    if (speedIndex !== -1) {
      matrix[speedIndex][dirIndex]++
    }
  })

  // =====================
  // Init chart
  // =====================
  if (!echart) {
    echart = echarts.init(document.getElementById("roseChart"))
  }

  // =====================
  // Chart options
  // =====================
  const option = {
    animation: false,

    tooltip: {
      formatter: p =>
        `${p.seriesName}<br>${p.name}: ${p.value} samples`
    },

    legend: {
      right: 0,
      top: "top",
      orient: "vertical"
    },

    polar: {
      radius: "70%"
    },

    angleAxis: {
      type: "category",
      data: DIR_LABELS,
      startAngle: 90 + HALF_STEP,
      clockwise: true
    },

    radiusAxis: {
      name: "Samples",
      axisLine: { show: false },
      axisTick: { show: false },   // 👈 important
      axisLabel: { show: true },

    },

    series: SPEED_BINS.map((bin, i) => ({
      name: bin.label,
      type: "bar",
      coordinateSystem: "polar",
      stack: "wind",
      data: matrix[i],
      barWidth: `${DIR_STEP * 0.5}deg`,
      itemStyle: {
        color: bin.color,
        opacity: 0.75
      }
    }))
  }

  echart.setOption(option)
}




// =====================
function getSelectedSensors() {
  return [...document.querySelectorAll("#checkboxes input:checked")]
    .map(c => c.value)
}


// =====================
setupTimeControls()
loadData()
setInterval(loadData, 5000)
