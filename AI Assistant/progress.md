# Implementation Progress — timeSyncPlan.md

Tracking file for `timeSyncPlan.md`. Update this whenever a session finishes a chunk.

- Started: 2026-08-17
- Status: **code complete, hardware verification outstanding**

Legend: `[x]` done · `[~]` partial · `[ ]` not started · `[!]` blocked

---

## 1. What is done

### Database

| Item | State | File |
|------|-------|------|
| New `SensorLog` columns (fresh installs) | [x] | `dashboard/database.sql` |
| `DeviceStatus` rework, `DeviceEvent`, `SamplingConfig` | [x] | `dashboard/database.sql` |
| Additive migration for the live DB | [x] written, [!] **not run** | `dashboard/migration_timesync.sql` |

The migration uses `information_schema` guards + `PREPARE`, no stored routines,
so it is idempotent and needs only `ALTER`/`CREATE` rights.
`ALGORITHM=INSTANT` on all five `SensorLog` columns.

### Backend — `dashboard/backend/server.js`

- [x] `GET /api/time` — Cristian's time source, **no DB access**
- [x] `GET /api/schedule`, `POST /api/schedule` — epoch-snapped `effectiveFrom`
- [x] `POST /api/heartbeat` — bootID + uptime → `bootAt`, emits `BOOT`/`ONLINE`
- [x] `POST /api/deviceEvent` — clean-shutdown hook
- [x] `GET /api/devices`, `GET /api/deviceEvents`
- [x] `POST /api/sensorLogBatch` — multi-row insert, 500-row cap
- [x] Offline watchdog + `SERVER_START` grace period (§6b pitfall)
- [x] `/api/logs?instrumentation=1` — opt-in extra columns + `endToEndUs`
- [x] `express.json({ limit: '5mb' })` — the 100 kb default would 413 a batch

### Pi — new

- [x] `sensorVPD/timesync.py` — Cristian's algorithm, `Clock`, boot id, clock step
- [x] `sensorVPD/scheduler.py` — `TickScheduler`, epoch anchoring, pending switch
- [x] `sensorVPD/client.py` — `BackendClient`, background maintenance thread
- [x] `sync_clock.py` — boot-time root clock step
- [x] `deploy/sensor-timesync.service`, `deploy/sensor.service`, `deploy/010-timesync-sudoers`

### Pi — modified

- [x] `sensorVPD/cache.py` — `PRAGMA table_info` migration, `stream` column,
      `correct_boot_timestamps()`, `LIMIT`, local-time `cleanup()`, batch mark
- [x] `sensorVPD/configReader.py` — `Period` fallback, paths anchored to `PI Env`
- [x] `sensorVPD/__init__.py`
- [x] `dht22.py`, `C5A.py` — tick-driven, retry budget, shared client, SIGTERM
- [x] `PI Env/README.md` — JSON config, timezone, systemd, `set-ntp false`

### Frontend

- [x] `frontend/js/devices.js` — interval control + device/event tables
- [x] `frontend/html/index.html`, `frontend/style.css`

### Bugs from §8 — all seven fixed

| # | Bug | Fix |
|---|-----|-----|
| 1 | `server.js` C5A missing comma — every wind insert failed | shared column list used by both routes |
| 2 | `cache.cleanup()` used `utcnow()` vs local rows | `datetime.now()` |
| 3 | `get_unsent()` had no `LIMIT` | `LIMIT`, default 500 |
| 4 | `dht22.py` never passed `sensor_id` | passes `client.sensor_id` |
| 5 | `ser.read(20)` on a 15-byte frame → 2 s per read | `read(15)` + CRC check + buffer reset |
| 6 | shared cache/uuid/config across scripts | `stream` column, paths anchored to `PI Env`, `SENSOR_CONFIG` |
| 7 | stale README (`config.txt` shown as key-value) | rewritten as JSON |

---

## 2. What was actually verified

Automated, this machine, no hardware:

- **Scheduler** — epoch anchoring produces identical instants for Pis with
  different phases; ticks land on exact multiples; overrun skips ticks instead
  of firing back-to-back; the 2 s minimum is enforced; four Pis polling a
  period change at different moments all switch on the same instant; a real
  sleep woke within 50 ms of its deadline.
- **Cache** — stream separation (DHT flush never sees C5A rows), `LIMIT`,
  legacy rows backfilled to the right stream, back-correction reconstructs the
  pre-sync epoch exactly and promotes `ESTIMATED` → `CORRECTED`.
- **Client vs a stub backend** — discovery, registration, schedule poll,
  heartbeat with bootID/uptime, batch upload, `queueDelayMs`, wind fields only
  on the C5A stream, a 450-row backlog draining as 200/200/50, `SHUTDOWN` post,
  clean thread stop. **A deliberate 3600 s server skew was recovered to within
  0.5 ms.**
- **Backend** — boots, `/api/time` answers with no DB access at ~1 ms RTT
  (the Pi rejects anything over 100 ms), validators reject a 1 s period and
  malformed batch rows, and the server degrades with a warning rather than
  crashing when the migration has not been run.

Scripts: `dashboard/backend/verify_timesync.js` (API-level §10 checks).

---

## 3. Outstanding

### [!] Blocking: run the migration

The app user `seniordashboard` has DML only — no `ALTER`, no `CREATE ROUTINE`.
Everything DB-backed is untested until this runs **as root**:

```bash
mysql -u root -p sensor_dashboard < dashboard/migration_timesync.sql
```

Then, with the backend running:

```bash
node dashboard/backend/verify_timesync.js
```

### Server facts (§12) — two of five now known

Measured on **this dev machine**, which is *not* the backend PC:

| Fact | Dev machine | Server PC |
|------|-------------|-----------|
| MySQL version | 8.0.45 → `ALGORITHM=INSTANT` supported | unknown |
| `innodb_buffer_pool_size` | 134217728 (the 128 MB default) | unknown |
| RAM / disk type / `SensorLog` size | n/a | unknown |

The dev DB has 33 rows; the real table is ~8.4 M. Re-check on the server.

### Still needs hardware (§10)

- [ ] Alignment coverage re-measured — target ~100 % vs the current 2.7 %
- [ ] Boot recovery with the PC unreachable — `ESTIMATED` → `CORRECTED`
- [ ] Live 5 s → 10 s switch lands on the same tick everywhere
- [ ] `recordedAt - datetime` in the tens of ms; backlog separable by `queueDelayMs`
- [ ] Power-cycle → `OFFLINE` then `BOOT` with a sane `bootAt`
- [ ] Backend stopped 10 min → **no** spurious `OFFLINE` events

### Decisions still open (§12)

- [ ] Keep `11-8-2026_sensorlog.csv` flagged `UNKNOWN` as the "before" baseline, or discard
- [ ] Heartbeat cadence — currently **60 s**, offline after **180 s**
- [x] `SensorLog (sensorID, datetime)` index — **included**, in `database.sql`
      and as an optional step at the end of the migration (deliberately not run
      automatically: 5–15 min build on the real table)

---

## 4. Notes for the next session

- **Deviations from the plan, all deliberate:**
  - The `ExecStop` shutdown hook is handled **in-process** via a `SIGTERM`
    handler in `dht22.py`/`C5A.py` rather than a separate script — the loop
    already holds a registered `BackendClient`, so no extra file is needed.
  - `cache.py` also stores `tickEpoch` and `stream`, beyond the four columns
    the plan lists. `tickEpoch` is what makes `queueDelayMs` computable at
    flush time; `stream` is the §8 cache-sharing fix.
  - `markSeen` is throttled to once per 15 s per sensor on the upload path
    (never on `/api/heartbeat`), so proof-of-life does not add two round trips
    per row on the single-row fallback path.
  - `BACKLOG_GAP` refinement of `OFFLINE` events is **not implemented** — the
    schema and `source` enum support it, but nothing computes it yet. Downtime
    is currently watchdog-precision (±180 s), not backlog-precision (±1 period).
    This is the one §6b item left undone.
- Path handling changed: `sensor_cache.db`, `device_uuid.txt`, `networkList.txt`
  and `config.txt` now resolve against the `PI Env` folder, not the cwd. On an
  existing Pi, **move any existing `sensor_cache.db` and `device_uuid.txt` into
  `PI Env/`** or the Pi will register as a new sensor and orphan its backlog.
- `PI Env` scripts were byte-compiled only; `board`/`adafruit_dht`/`serial`
  imports were never executed on this machine.
- Two `node server.js` processes were stopped during testing. If the dashboard
  backend was running on port 5000, restart it (`npm start` in
  `dashboard/backend`).
