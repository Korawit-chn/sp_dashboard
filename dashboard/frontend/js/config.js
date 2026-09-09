// Nothing to edit here any more.
//
// The backend serves this page (dashboard/backend/server.js mounts
// express.static over ../frontend), so the API is on the same origin the page
// came from. Open the dashboard at:
//
//     http://<backend-host>:5000/html/
//
// This used to be a hand-edited IP address and it was the most-missed step in
// the whole install: get it wrong and every panel silently shows "unavailable".
window.CONFIG = {
  API: `${location.origin}/api`

  // ONLY if you serve the frontend from somewhere else - a separate
  // live-server, or opening the file directly - point this at the backend by
  // hand instead. Check the backend PC's address with `ipconfig`.
  // API: "http://192.168.1.100:5000/api"
}
