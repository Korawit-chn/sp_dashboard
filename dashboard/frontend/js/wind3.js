// API, api(), getSelectedSensors(), sensorListOf(), sensorNameOf(),
// renderSensorCheckboxes(), renderTimeControls(), currentTimeQuery() and
// startPolling() come from common.js; sensorColor() from sensorColors.js.

let echart = null     // ECharts
let allData = []

// See the note on the same variable in script.js.
let sensorKey = null



// =====================
// Load data
// =====================
async function loadData() {
  let rows
  try {
    rows = await api(`/logs${currentTimeQuery()}`)
  } catch (err) {
    console.error("logs unavailable:", err.message)
    return
  }

  allData = rows.map(d => ({ ...d, sensorName: sensorNameOf(d) }))

  // keep only rows with wind
  allData = allData.filter(d => d.windspeed !== null)

  const sensors = sensorListOf(allData)
  const key = sensors.map(s => s.sensorID).join(",")

  if (key !== sensorKey) {
    sensorKey = key
    createCheckboxes(sensors)
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
// Sensor checkboxes
// =====================
function createCheckboxes(sensors) {
  // Same builder the main page uses, so a sensor's swatch here is the same
  // colour as its line on the temperature chart.
  renderSensorCheckboxes(
    document.getElementById("checkboxes"),
    sensors,
    renderChart
  )
}


// =====================
// Render chart (switch)
// =====================
function renderChart() {
  // The clear() that used to be here is gone: setOption below is notMerge, and
  // that is what has to do the clearing now - the number of polar components
  // changes with the number of ticked sensors.
  document.getElementById("roseChart").style.display = "block"
  buildRoseChart()
}


// =====================
// Wind rose geometry and bins
//
// Module scope: none of it changes between renders, and roseMatrix() below now
// runs once per sensor rather than once per chart.
// =====================
const DIR_LABELS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
const DIR_BINS = 8
const DIR_STEP = 360 / DIR_BINS
const HALF_STEP = DIR_STEP / 2

function getDirIndex(deg) {
  // normalize 0-360
  deg = ((deg % 360) + 360) % 360

  // center N at 0 degrees
  const shifted = (deg + HALF_STEP) % 360
  return Math.floor(shifted / DIR_STEP)
}

// These are wind SPEED colours and have nothing to do with sensorColor().
// A petal stands for a speed band, not for a sensor, so the sensor colour rule
// does not reach it - what identifies the sensor is which rose the petal sits
// in and the title above it. Do not "fix" these to palette entries.
const SPEED_BINS = [
  { label: "< 0.5 m/s",  min: 0,    max: 0.5,      color: "gray" },
  { label: "0.5-2 m/s",  min: 0.5,  max: 2,        color: "cyan" },
  { label: "2-4 m/s",    min: 2,    max: 4,        color: "blue" },
  { label: "4-6 m/s",    min: 4,    max: 6,        color: "green" },
  { label: "6-8 m/s",    min: 6,    max: 8,        color: "yellow" },
  { label: "8-10 m/s",   min: 8,    max: 10,       color: "orange" },
  { label: "> 10 m/s",   min: 10,   max: Infinity, color: "red" }
]


// =====================
// One sensor's rose
// =====================

// Sample counts as [speed bin][direction] for ONE sensor's rows.
function roseMatrix(rows) {
  const matrix = SPEED_BINS.map(() => new Array(DIR_BINS).fill(0))

  rows.forEach(d => {
    if (d.windspeed == null || d.windDirection == null) return

    const dirIndex = getDirIndex(d.windDirection)
    const speedIndex = SPEED_BINS.findIndex(
      b => d.windspeed >= b.min && d.windspeed < b.max
    )

    if (speedIndex !== -1) {
      matrix[speedIndex][dirIndex]++
    }
  })

  return matrix
}

// The busiest direction in a matrix - how far its longest petal has to reach.
function matrixPeak(matrix) {
  let peak = 0

  for (let dir = 0; dir < DIR_BINS; dir++) {
    let total = 0
    for (const bin of matrix) total += bin[dir]
    if (total > peak) peak = total
  }

  return peak
}

// Roses are laid out in as square a grid as they fit into: 1, then 2 across,
// then 2x2, then 3 across. Keyed off the COUNT, so the grid is the same shape
// whichever sensors are ticked.
function roseLayout(count) {
  const cols = Math.ceil(Math.sqrt(count))
  return { cols, rows: Math.ceil(count / cols) }
}


// =====================
// WIND ROSE
//
// One rose per ticked sensor, side by side, each titled in that sensor's
// colour. This used to be a single rose summed over every ticked sensor, which
// silently merged two anemometers into one figure - the readings went in and
// nothing on screen said whose they were. Only sensor 4 reports wind on this
// deployment, so that merge was invisible until a second one arrived.
//
// The sensor colour rule reaches this page through the title and the checkbox
// swatch (AI Assistant/SENSOR_COLORS.md); the petals stay speed-coloured.
//
// Every rose shares ONE ECharts instance rather than one instance each, so the
// speed legend is shared and hiding a band hides it on all of them.
// =====================
function buildRoseChart() {
  if (!echart) {
    echart = echarts.init(document.getElementById("roseChart"))
  }

  const selected = getSelectedSensors()

  // allData is already filtered to rows carrying wind, so this is the ticked
  // sensors that actually report it - in sensorID order, so the roses do not
  // swap places when a sensor's first reading of the window lands late.
  const sensors = sensorListOf(allData).filter(s => selected.includes(s.sensorID))

  if (sensors.length === 0) {
    echart.clear()
    return
  }

  const roses = sensors.map(sensor => ({
    sensor,
    matrix: roseMatrix(allData.filter(d => Number(d.sensorID) === sensor.sensorID))
  }))

  // ONE radius scale across every rose. Left to themselves each rose scales to
  // its own busiest direction, so a sensor with a tenth of the samples draws
  // the same size as a busy one - and side-by-side roses that cannot be
  // compared by size are worse than no comparison at all.
  const peak = Math.max(1, ...roses.map(r => matrixPeak(r.matrix)))

  const { cols, rows } = roseLayout(roses.length)

  // Percentages of the container. The right margin is the legend's, the top is
  // the row of titles.
  const RIGHT = 84
  const TOP = 8
  const BOTTOM = 4

  // Radius in PIXELS, not a percentage: an ECharts percentage radius is taken
  // against the whole container, so every rose in a 2x2 grid would be drawn at
  // the size of a single full-container one and they would overlap.
  const cellW = echart.getWidth() * (RIGHT / 100) / cols
  const cellH = echart.getHeight() * ((100 - TOP - BOTTOM) / 100) / rows
  const radius = Math.max(30, Math.min(cellW, cellH) * 0.38)

  const cellHeight = (100 - TOP - BOTTOM) / rows

  const centerOf = (i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    return {
      x: (col + 0.5) * (RIGHT / cols),
      y: TOP + (row + 0.5) * cellHeight,
      titleTop: row * cellHeight + TOP / 2
    }
  }

  // seriesIndex -> sensor name, so the tooltip can say whose rose was hovered.
  // Without it two roses give byte-identical tooltips.
  const seriesOwner = []
  const series = []

  roses.forEach((rose, i) => {
    SPEED_BINS.forEach((bin, b) => {
      seriesOwner[series.length] = rose.sensor.name

      series.push({
        name: bin.label,
        type: "bar",
        coordinateSystem: "polar",
        polarIndex: i,
        // Stack name per rose: one shared name stacks every sensor's petals
        // into whichever rose drew first.
        stack: `wind${rose.sensor.sensorID}`,
        data: rose.matrix[b],
        barWidth: `${DIR_STEP * 0.5}deg`,
        itemStyle: {
          color: bin.color,
          opacity: 0.75
        }
      })
    })
  })

  const option = {
    animation: false,

    tooltip: {
      formatter: p =>
        `${seriesOwner[p.seriesIndex]}<br>${p.seriesName}<br>${p.name}: ${p.value} samples`
    },

    // Named explicitly so the legend lists each speed band once rather than
    // once per rose.
    legend: {
      data: SPEED_BINS.map(b => b.label),
      right: 0,
      top: "top",
      orient: "vertical"
    },

    // The sensor's colour, on the one mark that stands for the sensor. The
    // name is spelled out beside it - colour is never the only channel.
    title: roses.map((rose, i) => {
      const c = centerOf(i)
      return {
        text: rose.sensor.name,
        left: `${c.x}%`,
        top: `${c.titleTop}%`,
        textAlign: "center",
        textStyle: {
          color: sensorColor(rose.sensor.sensorID),
          fontSize: 13,
          fontWeight: "normal"
        }
      }
    }),

    polar: roses.map((rose, i) => {
      const c = centerOf(i)
      return { center: [`${c.x}%`, `${c.y}%`], radius }
    }),

    angleAxis: roses.map((rose, i) => ({
      polarIndex: i,
      type: "category",
      data: DIR_LABELS,
      startAngle: 90 + HALF_STEP,
      clockwise: true
    })),

    radiusAxis: roses.map((rose, i) => ({
      polarIndex: i,
      max: peak,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: true }
    })),

    series
  }

  // notMerge: the component arrays shrink when a sensor is unticked, and a
  // merged setOption keeps the leftovers on screen.
  echart.setOption(option, true)
}


// =====================
// The rose radii are computed in pixels from the instance size, so a resized
// window needs the whole layout rebuilt, not just echart.resize(). ECharts does
// not watch the container itself.
window.addEventListener("resize", () => {
  if (!echart) return
  echart.resize()
  renderChart()
})

// See the note on start() in script.js - the config call has to land before the
// time control is built.
async function start() {
  await loadServerConfig()

  renderTimeControls(
    document.getElementById("timeControls"),
    () => {
      sensorKey = null
      startPolling(loadData)
    }
  )

  startPolling(loadData)
}

start()
