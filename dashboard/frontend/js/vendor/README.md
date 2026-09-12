# Vendored browser libraries

These are checked in on purpose. **The site has no internet**, so the dashboard
cannot load them from a CDN.

| File | Package | Version |
|---|---|---|
| `chart.umd.min.js` | [chart.js](https://www.chartjs.org) | 4.5.1 |
| `chartjs-adapter-date-fns.bundle.min.js` | chartjs-adapter-date-fns (bundles date-fns) | 3.0.0 |
| `echarts.min.js` | [Apache ECharts](https://echarts.apache.org) | 6.1.0 |

`chart.umd.min.js` defines the global `Chart` (used by `js/script.js`), the
adapter gives its time axis a date library, and `echarts.min.js` defines
`echarts` (used by `js/wind3.js`). All three are MIT/Apache-2.0 licensed, with
the licence headers left intact at the top of each file.

They are served by `express.static` out of `frontend/`, so they need no backend
change — `dashboard/backend/server.js` already publishes this whole directory.

## Why not a CDN

They used to load from `cdn.jsdelivr.net`. That meant the **browser** needed
internet, not the server — which is why the dashboard worked from a laptop on
mobile data and failed from anything on site.

Worse, it failed *gradually*. The URLs carried no version
(`npm/chart.js`, not `npm/chart.js@4.5.1`), and jsDelivr caches floating URLs
for about a week because they track the latest release. So the charts drew fine
until the browser cache expired, then stopped, with everything else on the page
still working — the panels, the tables and the sensor checkboxes are served by
the backend over the LAN and never needed the internet.

The unversioned URLs were also an upgrade hazard on their own: a Chart.js major
release would have landed on the dashboard with no commit on our side.

## Updating one

Download it on a machine that has internet, drop it in here, update the version
in the table above, and re-test both pages. **Pin the version in the URL** —
that is the whole point:

    curl -O https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js

Then check the graphs actually draw. The failure mode is silent: with the
library missing, `new Chart(...)` and `echarts.init(...)` throw, the charts
never appear, and the rest of the page looks completely normal. Open the browser
console — that is where the error goes.
