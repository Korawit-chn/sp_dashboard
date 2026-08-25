# Database v3 — What Changed and Why

For the team. Read this before deploying `Database_v3.sql`.
Background on the sensor-side work is in `timeSyncPlan.md`; this file covers the database.

---

## What this is

`Database_v3.sql` creates a **new database, `sensor_dashboard_v3`**, rather than altering the existing one. The old `sensor_dashboard` is left completely untouched — the `DROP DATABASE` at the top of the script can only ever affect `sensor_dashboard_v3`.

To reuse the original name instead, change `sensor_dashboard_v3` to `sensor_dashboard` on the three lines at the top of the script. **That deletes every reading collected since July.** Don't do it unless that's what you want.

---

## Why a new database instead of migrating

We were originally going to `ALTER` the existing tables. Starting fresh turned out to be better on every count:

| Migrating in place | Fresh v3 |
|--------------------|----------|
| Needs MySQL 8.0.12+ on the server for `ALGORITHM=INSTANT`; otherwise a locking table rebuild | `CREATE TABLE` works on every version |
| `UNIQUE (sensorID, datetime)` impossible — old data holds 6,969 duplicate pairs | Free from day one |
| Index build 5–15 minutes on a spinning disk | Free on an empty table |
| Columns forced to the end of the table for INSTANT compatibility | Placed where they belong |
| One table mixing trustworthy and untrustworthy timestamps | Every row in v3 is synced-clock data |
| Old data at risk if something goes wrong | Old data untouchable |

It also gives the report a clean boundary: **v2 = free-running sensors, v3 = synchronised.** No filtering by confidence flag to work out which rows to trust.

---

## Why we're doing any of this

The Raspberry Pis have no RTC and no internet, so their clocks reset to a wrong time on every reboot, and each Pi samples on its own free-running loop. Measured from `11-8-2026_sensorlog.csv`:

> Of 36,464 distinct timestamps, only **986 contain all 4 sensors — 2.7 %.**

97 % of collected data can't be used to compare inside vs. outside VPD at the same moment. v3 supports the fix and lets us prove it worked.

---

## `SensorLog`

Six new columns, plus a unique key and an index.

| Column | Written by | Meaning |
|--------|-----------|---------|
| `timeConfidence` | Pi | Whether the Pi's clock was trustworthy when the reading was taken |
| `tickJitterMs` | Pi | How late the sampler woke vs. its scheduled instant |
| `readLatencyMs` | Pi | How long the sensor read itself took |
| `queueDelayMs` | Pi | Gap between the scheduled instant and the upload attempt. **Large = replayed from the offline cache**, not sent live |
| `syncRttMs` | Pi | Round-trip of the clock sync in force for this reading — gives us error bars |
| `recordedAt` | MySQL | When the row was actually committed |

### `timeConfidence` values

| Value | Meaning |
|-------|---------|
| `SYNCED` | Clock was synced to the PC — trust this timestamp |
| `CORRECTED` | Taken while offline with a wrong clock, but reconstructed afterwards and accurate |
| `ESTIMATED` | Taken while offline, not yet corrected — **do not trust** |
| `UNKNOWN` | Default. Should not appear in v3 |

### `datetime` is now the *scheduled* instant

Every Pi computes sampling times from the same formula, so all sensors fire on the same whole-second tick. The reading is stamped with that tick, **not** with when the read finished.

This matters because the C5A blocks on its serial exchange while the DHT22 returns quickly. Stamping at completion would bake a permanent offset between sensor types into the data and defeat the whole point. Actual read duration is preserved separately in `readLatencyMs`.

### What the timing columns let us measure

```
scheduled tick (datetime)
  │
  ├─ tickJitterMs ──► sampler wakes
  │                      │
  │                      ├─ readLatencyMs ──► value read → saved to Pi's local cache
  │
  ├──────── queueDelayMs ──────────► upload attempt starts
  │
  └──────── recordedAt − datetime ──────────► row committed in MySQL
```

```sql
-- End-to-end delivery delay, live rows only (excludes offline-cache replays)
SELECT sensorID,
       AVG(TIMESTAMPDIFF(MICROSECOND, datetime, recordedAt)) / 1000 AS avg_ms
FROM SensorLog
WHERE queueDelayMs < 2000
GROUP BY sensorID;
```

> **Careful with this in the report.** `TIMESTAMP(6)` gives microsecond *resolution*, but accuracy is limited by clock-sync quality — realistically ±1–5 ms on a LAN. That's what `syncRttMs` is for: report the delay with error bars, not as a point value. Say "microsecond resolution, millisecond accuracy."

### `UNIQUE (sensorID, datetime)` — and the trap it creates

Because ticks are deterministic, a sensor can only have one reading per tick. This makes upload retries exactly-once: if a `200` response is lost in transit and the Pi re-sends, no duplicate appears.

**But the backend must handle the duplicate gracefully.** The Pi's flush loop only marks a row uploaded on a `200`, and stops on anything else. If a duplicate insert throws a 500, the Pi retries the same row forever and **the entire upload queue deadlocks behind it.**

So inserts must be written as:

```sql
INSERT INTO SensorLog (...) VALUES (...)
ON DUPLICATE KEY UPDATE logID = logID
```

A no-op update that returns cleanly. This has to land in the same change as the constraint.

---

## `Device` — new, and why the on/off tables key on it

A Raspberry Pi is not the same thing as a sensor. `device_uuid.txt` identifies the **Pi**; `uq_sensor_identity` allows one Pi to own several `Sensor` rows — a different sensor type, or the same sensor after a location change.

That matters for on/off tracking. A power cut takes out the whole Pi, so if `DeviceStatus`/`DeviceEvent`/`DeviceSession` were keyed on `sensorID`, one outage would log two `OFFLINE` events and produce two session rows for a Pi hosting two sensors.

So v3 adds a `Device` table keyed on `deviceUUID`, `Sensor` gains a `deviceID` foreign key, and all three on/off tables key on `deviceID`. `uq_sensor_identity` becomes `(deviceID, typeID, locationID)` and the redundant `deviceUUID` column comes off `Sensor`.

`ErrorLog` stays keyed on `sensorID` — errors are sensor-specific, not device-wide.

**Backend change:** `/api/registerSensor` must find-or-create the `Device` row from `deviceUUID` before creating the `Sensor` row. The payload the Pis already send is unchanged.

---

## `DeviceStatus`

Reworked into a current-state table — one row per **device**, `deviceID` as both primary key and foreign key, updated by heartbeat.

| Column | Meaning |
|--------|---------|
| `connectionStatus` | `ONLINE` / `OFFLINE` / `UNKNOWN` |
| `lastHeartbeat` | Last contact from the device |
| `bootID` | From `/proc/sys/kernel/random/boot_id`. Changes on every boot, so a new value means a power cycle |
| `bootAt` | Actual power-on time, computed from `/proc/uptime` at first contact |
| `lastSyncAt`, `lastSyncOffsetMs`, `lastSyncRttMs` | Clock health per device — lets the dashboard show a Pi drifting *before* its data is affected |
| `updatedAt` | Auto-maintained |

---

## `DeviceEvent` — new

Append-only log of every device transition: `BOOT`, `ONLINE`, `OFFLINE`, `SHUTDOWN`, `SERVER_START`.

**Why two timestamps?** A Pi that loses power can't tell us it died — we only notice when heartbeats stop. `occurredAt` is when it actually happened; `detectedAt` is when the server worked it out. For `OFFLINE` these differ, sometimes by minutes.

**Why `source`?** We estimate the off-time twice. The watchdog notices a missing heartbeat first (rough, ±1 minute). Later the Pi reconnects and uploads its offline backlog, and the gap in that data pins the power-off moment to within one sampling period (±5 s). `source` tells you which estimate you're looking at — `BACKLOG_GAP` beats `WATCHDOG`.

**Why is `deviceID` nullable?** `SERVER_START` is about the backend, not a device. That event exists to solve a trap: if the **PC** is off, every Pi looks dead, and a naive watchdog would log fake `OFFLINE` events for all of them. Recording server startup lets us tell "the Pi died" apart from "we weren't listening."

---

## `DeviceSession` — new

One row per continuous powered-on period. `DeviceEvent` is the audit trail; this is the shape you'll actually query.

`endedAt` NULL means the device is still running. Downtime is the gap between one row's `endedAt` and the next `startedAt`.

```sql
-- Uptime per device
SELECT deviceID,
       COUNT(*) AS power_cycles,
       SUM(durationSeconds) / 3600 AS hours_up
FROM DeviceSession
WHERE startedAt >= '2026-08-01'
GROUP BY deviceID;
```

```sql
-- Downtime between sessions
SELECT deviceID,
       endedAt AS went_off,
       LEAD(startedAt) OVER (PARTITION BY deviceID ORDER BY startedAt) AS came_back,
       TIMESTAMPDIFF(SECOND, endedAt,
           LEAD(startedAt) OVER (PARTITION BY deviceID ORDER BY startedAt)) AS down_seconds
FROM DeviceSession;
```

Three design details:

- **`durationSeconds` is a generated column**, computed from `startedAt`/`endedAt` rather than stored, so it can never drift out of sync. `VIRTUAL`, so it costs no storage.
- **`UNIQUE (deviceID, bootID)`** means one session per boot. A repeated boot report — first heartbeat succeeds but its response is lost — produces one session, not several.
- **`endAccuracy`** exists because `endedAt` gets written twice: the watchdog's rough estimate first, then the precise backlog-gap figure. The column stops a rough estimate being mistaken for a precise one.

---

## `SamplingConfig` — new

Controls how often sensors sample. The PC owns it; the Pis poll it.

**Append-only.** Changing the interval inserts a row rather than updating one, so we keep a history of what the sampling rate was at any point — which matters when analysing data spanning a config change.

`effectiveFrom` is a **Unix epoch in milliseconds**, not a datetime. It's the instant a new period takes effect, always aligned to a multiple of that period so every Pi switches on the same tick. Without it, changing 5 s → 10 s would take effect whenever each Pi happened to poll, and they'd scatter again.

Minimum period is **2 seconds** — a DHT22 hardware limit, enforced in the API.

---

## `ErrorLog`

Gains `occurredAt` and `timeConfidence`.

`createdAt` is server insert time. A read failure that happens while a Pi is offline is only reported once the network returns, so a 2 a.m. failure could otherwise be stamped 8 a.m. `occurredAt` carries the device's own time — the same problem the `SensorLog` work exists to solve.

---

## Unchanged

`Location`, `SensorType`, `Actuator`, `ActuatorLog`, `ClimateRules` are identical to v2.

`Sensor` is the one existing table that changed shape: `deviceUUID` moves to the new `Device` table and is replaced by a `deviceID` foreign key. Anything reading `Sensor.deviceUUID` — including `/api/sensors`, which does `SELECT *` — needs to join `Device` to get it back.

---

## Deploying

### 1. Create the database

```bash
mysql -u root -p < Database_v3.sql
```

### 2. Nothing to copy — the Pis register themselves

No seed data is needed. Each Pi holds a persistent `device_uuid.txt` and a `config.txt`, and `register_sensor_if_needed()` posts them to `/api/registerSensor`, which find-or-creates the `Device`, `SensorType`, `Location` and `Sensor` rows on demand. Since we're deploying new sensor code anyway, every Pi restarts, its in-memory `sensor_id` resets to `None`, and it re-registers against v3 on its own.

One consequence: **`sensorID` numbers are assigned in registration order, so they may differ from v2.** "Sensor 3" might become a different number. `deviceUUID` is stable, so the mapping is always recoverable — just don't assume the old IDs carry over when comparing v2 and v3 data.

### 3. Point the backend at v3

Change `DB_NAME` in `dashboard/backend/.env`, then restart. Rollback is changing that one line back.

### 4. Old data

`sensor_dashboard` stays where it is. Both databases live on the same server, so a combined view is just:

```sql
SELECT ... FROM sensor_dashboard.SensorLog    WHERE datetime BETWEEN ? AND ?
UNION ALL
SELECT ... FROM sensor_dashboard_v3.SensorLog WHERE datetime BETWEEN ? AND ?
```

Archive it with `mysqldump` and drop it when we're confident, if disk space becomes a concern.

---

## Still to agree on

1. **The old data.** Keep `sensor_dashboard` as the "before" comparison for the report, or archive and drop it?
2. **Heartbeat cadence.** 60 s (reuses the existing network cycle, detects a dead Pi in ~3 min) or 30 s? Either way the recorded off-time precision comes from the backlog gap, not this setting.
