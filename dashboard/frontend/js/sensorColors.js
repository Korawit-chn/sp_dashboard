// =====================
// The sensor colour rule. Loaded FIRST, before common.js.
//
// Spec: AI Assistant/SENSOR_COLORS.md. The same ten colours, in the same
// order, are SENSOR_PALETTE / sensor_color() in Reference/plot_sensors.py -
// matplotlib's "tab:blue".."tab:gray" ARE these hex values. Change one side
// and you have to change the other, or a sensor reads one colour on the
// dashboard and another in the analysis figures.
//
// This file is the only place the hex values appear. Anything that draws a
// sensor - chart line, legend, checkbox swatch - calls sensorColor(). A colour
// repeated as a literal in a second component is how the rule quietly breaks.
//
// No `export`: the pages load bare <script> tags, there is no bundler. Like
// API in common.js, these are top-level declarations shared across <script>
// tags, so this file must be included exactly once per page.
// =====================

const SENSOR_PALETTE = [
  "#1f77b4", // 1  blue
  "#ff7f0e", // 2  orange
  "#2ca02c", // 3  green
  "#d62728", // 4  red
  "#9467bd", // 5  purple
  "#8c564b", // 6  brown
  "#e377c2", // 7  pink
  "#bcbd22", // 8  olive
  "#17becf", // 9  cyan
  "#7f7f7f"  // 10 gray
]

// Colour is a function of sensorID ALONE - never of array index, loop counter,
// draw order, the sort order of the API response, or the sensor's name. Those
// all move when the data moves; the ID does not. That is what makes sensor 2
// orange on every chart, still orange when sensors 1 and 4 are unticked, and
// still orange after sensor 5 is installed tomorrow.
//
// IDs past the end of the palette wrap round, so an unfamiliar sensor gets a
// stable colour rather than no colour.
function sensorColor(sensorId) {
  const id = Number(sensorId)

  // Should not happen - /api/logs always carries sensorID. Gray rather than
  // undefined, so a line still draws if it ever does.
  if (!Number.isFinite(id)) return "#7f7f7f"

  // The extra (+ len) % len is not decoration. JS % keeps the sign of the left
  // operand, so id 0 - which Number(null) also produces, and null is exactly
  // the input this function is defensive about - gives -1 and indexes off the
  // front of the array as undefined, not as a colour. SENSOR_COLORS.md's
  // reference implementation has this hole; this is the same rule for every
  // id >= 1, and gray instead of undefined below that.
  const len = SENSOR_PALETTE.length
  const i = ((Math.abs(Math.trunc(id)) - 1) % len + len) % len

  return SENSOR_PALETTE[i]
}
