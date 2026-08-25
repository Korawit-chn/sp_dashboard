# Plan — Synchronised Time & Simultaneous Sampling

Status: approved, not yet implemented
Date: 2026-08-17
Scope: `PI Env/` (Raspberry Pi clients) + `dashboard/backend/` + `dashboard/database.sql`

---

## 1. Problem

The Raspberry Pis have no RTC and no internet, so `fake-hwclock` restores whatever
time was saved at shutdown. Every power cycle produces a different, wrong clock.

There are actually **two independent problems**, and fixing only the first does not
give simultaneous records:

| # | Problem | Cause |
|---|---------|-------|
| 1 | Absolute time is wrong | No RTC, no NTP. `datetime.now()` is meaningless after a reboot. |
| 2 | Samples are not aligned | Each Pi runs its own free-running `while True: ... time.sleep(N)` loop. `dht22.py:13` uses 2 s, `C5A.py:13` uses 1.1 s plus a 1.1 s blocking serial wait. Even with perfect clocks they would never land on the same instant. |

### Evidence from existing data

Measured from `11-8-2026_sensorlog.csv` (69,290 rows, 4 sensors, ~13.9 hours):

| Sensor | Type | Readings | Median gap | Mean gap | Max gap |
|--------|------|----------|-----------|----------|---------|
| 1 | C5A (wind) | 11,217 | 4 s | 4.44 s | 14 s |
| 2 | DHT22 | 19,011 | 3 s | 2.70 s | 14 s |
| 3 | DHT22 | 19,334 | 3 s | 3.05 s | 14 s |
| 4 | DHT22 | 19,728 | 3 s | 3.06 s | 14 s |

**Only 986 of 36,464 distinct timestamps contain all 4 sensors — 2.7 %.**

That number is the point of this work: 97 % of collected data cannot be used to
compare inside vs. outside VPD at the same instant. Worth quoting in the report as
the "before" measurement.

---

## 2. Approach decision

The original idea was: *PC sends a signal to every Pi each interval telling it to
sample once.* The first half (Pi asks PC for the time) is kept. The per-tick push is
replaced, for three concrete reasons:

- The PC does not know the Pis' IP addresses. Pis are clients that scan
  `networkList.txt` to find the PC (`sensorVPD/network.py`). Push would require an
  HTTP server on each Pi, registered IPs, and reserved DHCP leases.
- A per-tick signal puts the network inside every single sample. One dropped packet
  = one lost sample on one Pi = exactly the misalignment being fixed.
- It contradicts the offline-first behaviour already implemented in `cache.py` and the
  sensor loops: readings are saved locally before any network call, so collection never
  stops for network reasons. Push means no network, no samples at all.

### Chosen architecture — synced clock + shared schedule (pull)

If every Pi agrees on the time, and every Pi agrees on "sample at multiples of P
seconds counted from the Unix epoch", then they all fire at the same instants **with
no per-sample message at all**. The network is needed only occasionally, to correct
drift and pick up config changes. A network outage no longer breaks alignment.

**Decision 2 — clock correction: step at boot + software offset.**

- A root systemd oneshot service asks the PC for the time and steps the system clock
  **once at boot, before the sensor service starts**. Pi logs and file mtimes become
  correct.
- After that the running app holds a small in-memory offset for drift, so the clock
  is never stepped underneath a running schedule (a backward jump would corrupt tick
  scheduling).

**No internet is involved anywhere.** The time source is the PC, over the same LAN
link that already carries sensor data — `GET /api/time` hits the same host and port
as `/api/getDataDHT`. `timedatectl set-time` is a purely local syscall.

The one internet-related item to handle: the Pi runs `systemd-timesyncd`, which is
currently failing in the background trying to reach public NTP servers. It must be
disabled (`timedatectl set-ntp false`), otherwise it can refuse or overwrite our
clock setting. This is mandatory regardless of approach.

---

## 3. Phase 1 — Time sync

### Backend

`GET /api/time` → `{ epochMs, iso }`

Must not touch the database. The Pi measures round-trip delay against this route, so
any latency added here becomes clock error on the sensors.

### Pi — new module `sensorVPD/timesync.py`

Uses **Cristian's algorithm** to cancel network delay:

```
t0     = local clock before request
t1     = PC clock from response body
t3     = local clock after response
rtt    = t3 - t0
offset = t1 - t0 - rtt/2
```

Take ~5 samples, **keep the one with the lowest RTT** — a fast exchange is the one
least distorted by queueing delay (this is what NTP does). On a LAN this lands within
a few milliseconds, far better than needed for 5 s sampling.

Module contents:

- `read_boot_id()` — from `/proc/sys/kernel/random/boot_id`
- `probe(base_url, samples, timeout)` → `(offset, rtt)` or `None`
- `Clock` — holds the offset; `now()`, `timestamp()`, `confidence`, `sync()`
- `step_system_clock(epoch)` — `timedatectl set-ntp false` then `set-time`

`Clock.now()` returns `time.time() + offset`. Re-sync runs during the existing 60 s
maintenance cycle.

Note: `timedatectl` only accepts whole seconds, so the boot step is coarse. That is
fine — the software offset provides the fine correction.

---

## 4. Phase 2 — Aligned sampling

### Pi — new module `sensorVPD/scheduler.py`

Replaces `time.sleep(INTERVAL)` with "sleep until the next tick":

```
next_tick = floor(now / P) * P + P     # anchored to the Unix epoch
```

Anchoring to the epoch means every Pi derives identical instants with zero
coordination — no shared phase value has to be distributed.

**Sleep against a `time.monotonic()` deadline**, not the wall clock, so a clock
correction arriving mid-sleep cannot stretch or collapse it.

`wait_for_next_tick()` returns `Tick(epoch, monotonic, skipped)`. If the previous read
overran (e.g. DHT retries took 6 s on a 5 s period), the next *future* multiple is
used — ticks are skipped, never fired back-to-back to catch up. Skips are logged.

### Two critical details

**Stamp the reading with the tick time, not read-completion time.**
C5A blocks ~1.1 s on the serial exchange (`C5A.py:163`) while DHT22 returns in ~0.3 s.
Stamping at completion would bake a permanent ~1 s bias between sensor types into the
data and defeat the whole exercise. The actual read duration is stored separately in
`readLatencyMs` so the bias can still be quantified for the report.

**Move network work off the tick path.**
`networkSearch` blocks up to 5 s *per IP* in `networkList.txt`. On a 5 s period that
alone would cause missed ticks. Discovery / registration / schedule poll / flush move
into a background daemon thread (`sensorVPD/client.py`), leaving the tick loop
real-time. Each `cache.py` call opens its own SQLite connection, so cross-thread use
is safe; the existing `timeout=10` covers write contention.

### Per-tick timing budget

Measured / derived cost of one reading:

| Step | Now | After fix |
|------|-----|-----------|
| C5A pre-read `time.sleep(1.1)` | 1.1 s | removed |
| C5A `ser.read(20)` | 2.0 s (full timeout) | ~0.05 s |
| C5A loop `time.sleep(1.1)` | 1.1 s | replaced by tick |
| **C5A total** | **~4.2 s** | **~0.1 s** |
| DHT22 read | ~1 s | ~1 s (inherent) |
| SQLite insert | few ms | few ms |
| Network | 0 — background thread | 0 |

**The C5A serial read has a latent bug.** The port is opened with `timeout=2`
(`C5A.py:144`) and the code calls `ser.read(20)`, but a modbus response to this
request is **15 bytes** (addr + func + byte-count + 5 registers × 2 + CRC). pyserial
returns when it has the requested count *or* the timeout expires — so it never
receives 20 bytes and blocks the full 2 s on every read.

This is confirmed by the data: predicted cycle `1.1 + 2.0 + 1.1 = 4.2 s` versus a
**measured 4.44 s mean gap** for sensor 1.

The 1.1 s pre-read sleep is also not a hardware requirement. At 9600 baud 8N1
(~1.04 ms/byte) the real exchange is 8 bytes out ≈ 8 ms, 15 bytes back ≈ 16 ms, plus
device turnaround — **~35–75 ms total**. Fix is `ser.read(15)`, which returns as soon
as the frame lands.

Read duration does **not** affect timestamp accuracy, because readings are stamped
with the tick (§4). It only determines whether the tick budget is met.

Worth noting for the report: the DHT22 datasheet quotes a humidity response time on
the order of seconds (1/e). The sensors' own physical response is slower than the
entire read cycle, so tick-level alignment is already finer than the measurement
physics — pursuing millisecond precision would optimise below the sensors' resolution.

### Hardware constraint

DHT22 cannot be sampled faster than once per 2 s (datasheet limit, and the binding
constraint — not read duration). **Minimum period is enforced at 2 s** in both the
backend validator and the scheduler. The intended 5 s / 10 s values are comfortably
above this.

DHT22 also fails frequently. Reads get retried inside a budget of ~60 % of the period
(one retry at 2 s on a 5 s tick); if all attempts fail the tick is recorded as an
error rather than silently dropped.

---

## 5. Phase 3 — PC-controlled interval

New table `SamplingConfig(configID, periodSeconds, effectiveFrom, active, createdAt)`.

- `GET /api/schedule` → newest row + `serverEpochMs`
- `POST /api/schedule` → `{ periodSeconds, leadSeconds }`

Pis poll the schedule during the 60 s maintenance cycle.

**Interval changes carry an `effectiveFrom` epoch, aligned to a multiple of the new
period:**

```
effectiveFrom = ceil((now + lead) / (P_new * 1000)) * (P_new * 1000)
```

Without this, switching 5 s → 10 s would take effect whenever each Pi happened to
poll, scattering them again. With it, every Pi switches at the same instant and lands
on the same new grid. Default lead ≈ 30 s so all Pis have polled before the switch.

Dashboard gains a control writing to this endpoint.

---

## 6. Phase 4 — Readings taken before sync exists

The offline-first requirement and time sync genuinely conflict at boot: with no
network there is no correct time, but collection must continue anyway.

Resolution: every cached row also stores `bootID` and a `monotonic` value. The
monotonic clock is continuous and correct-rate within a single boot, so once the
offset to the PC is learned, the true time of every row in that boot can be
reconstructed **exactly**:

```
true_epoch(m) = ref_epoch + (m - ref_monotonic)
```

where `(ref_monotonic, ref_epoch)` is captured at the moment of first successful sync.

Rows carry `timeConfidence`:

| Value | Meaning |
|-------|---------|
| `SYNCED` | Clock was synced when the reading was taken |
| `CORRECTED` | Taken while unsynced, timestamp reconstructed afterwards |
| `ESTIMATED` | Taken while unsynced, not yet corrected |
| `UNKNOWN` | Legacy row |

Only un-uploaded rows are corrected — already-uploaded rows are the server's problem,
not the cache's. This is a defensible design decision for the report, not a workaround.

---

## 6a. Phase 5 — End-to-end latency instrumentation

Goal: record when a reading actually reached the database, for research on delivery
delay.

**This is only measurable because of the clock sync.** Pi and PC share a time base, so
`recordedAt - datetime` reflects real latency. Without §3 it would measure clock error.

The server stamps the insert with its own clock:

```sql
recordedAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
```

A single number is ambiguous (network? DB? sat in the offline cache?), so the whole
path is instrumented:

```
tick T (datetime, exact whole second)
  │
  ├─ tickJitterMs ──► scheduler actually wakes
  │                      │
  │                      ├─ readLatencyMs ──► value in hand → written to SQLite
  │
  ├──────── queueDelayMs ──────────► upload attempt begins
  │
  └──────── recordedAt − datetime ──────────► row committed in MySQL
```

| Question | Query |
|----------|-------|
| Is sampling firing on time? | `tickJitterMs` |
| How slow is the sensor itself? | `readLatencyMs` |
| Live upload or cache replay? | `queueDelayMs` (large ⇒ backlog) |
| End-to-end delay | `TIMESTAMPDIFF(MICROSECOND, datetime, recordedAt)` |
| Network + DB alone | end-to-end − `queueDelayMs` |

Because ticks are exactly whole seconds by construction, keeping `datetime` at second
resolution costs nothing — the subtraction stays exact to the microsecond.

### Resolution vs. accuracy — state this in the report

The column stores microseconds, but **accuracy is bounded by sync quality, realistically
±1–5 ms on a LAN**. MySQL on Windows may also deliver coarser than microsecond
granularity from the OS clock regardless of column type.

Claim microsecond *resolution*, millisecond *accuracy*. Second-scale delays are far
above this noise floor and measured reliably.

---

## 6b. Phase 6 — Device on/off tracking

Constraint: **a Pi that loses power cannot report its own death.** "Off" is always
inferred. Three sources combine to make the inference precise:

| Source | Precision | Available |
|--------|-----------|-----------|
| Heartbeat timeout | ± heartbeat interval (~60 s) | Always, even if the Pi never returns |
| Backlog gap in cached readings | ± one sampling period (5 s) | Only after the Pi reconnects |
| `bootID` + `/proc/uptime` | Exact | On reconnect |

**Heartbeat.** Pi POSTs `/api/heartbeat` on the existing 60 s maintenance cycle; any
data upload also counts as proof of life. A server-side watchdog marks a device offline
after ~3 missed intervals.

**Boot detection.** `bootID` from `/proc/sys/kernel/random/boot_id` changes every boot;
`/proc/uptime` gives seconds since. The first heartbeat after a reboot sends both, and
the server computes `bootAt = now - uptimeSeconds`. A new `bootID` for a known sensor
*is* the power-on event. Only meaningful once the clock is synced.

**Refinement.** Watchdog logs a provisional `OFFLINE`; when the Pi returns and flushes
its backlog, the last reading before the gap pins the power-off moment to within one
sampling period. Downtime = `bootAt - lastReadingBeforeGap`.

### Critical pitfall: server downtime is not device downtime

If the **PC** is off, every Pi looks dead. A naive watchdog would log spurious `OFFLINE`
events for all devices at server restart, and the "Pi downtime" dataset would actually
be recording *backend* downtime.

Mitigation: log a `SERVER_START` event at boot and suppress offline detection for one
threshold period after startup, so gaps stay attributable to the correct machine.
Without this the on/off log is wrong in exactly the case it matters most.

### Optional: clean shutdown

A systemd `ExecStop` hook posts a `SHUTDOWN` event on graceful stop, distinguishing
"deliberately stopped" from "power cut". Only works with network present and a graceful
shutdown, so it supplements rather than replaces the inference above.

---

## 7. Data model changes

All changes are **additive** — nothing dropped, renamed or retyped.

Adding to `SensorLog`:

- `timeConfidence ENUM('SYNCED','CORRECTED','ESTIMATED','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN'`
- `readLatencyMs INT NULL` — sensor read duration
- `tickJitterMs INT NULL` — scheduler wake accuracy vs. the tick
- `queueDelayMs INT NULL` — tick → upload attempt (large ⇒ replayed from cache)
- `recordedAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` — DB insert time

All are appended at the **end of the table**, not in their logical position after
`datetime`. `logID` was already at 8,425,300 in the August export, so this is a
multi-million-row table: appending lets MySQL 8 use `ALGORITHM=INSTANT` and complete
in milliseconds, whereas an `AFTER datetime` placement forces a full table rebuild on
older versions. If the server rejects `ALGORITHM=INSTANT`, drop that clause and expect
a lengthy rebuild.

### `DeviceStatus` — repurposed as current state

Currently exists but **no code path writes to it**, so it is empty and safe to alter.
One row per sensor, upserted by heartbeat:

- `UNIQUE (sensorID)`
- `lastSeen TIMESTAMP(6) NULL`
- `bootID CHAR(36) NULL`
- `bootAt TIMESTAMP(6) NULL`
- `isOnline BOOLEAN NOT NULL DEFAULT FALSE`

### `DeviceEvent` — new, the on/off log

```sql
CREATE TABLE DeviceEvent (
    eventID    BIGINT AUTO_INCREMENT PRIMARY KEY,
    sensorID   INT NULL,                       -- NULL for SERVER_START
    eventType  ENUM('BOOT','ONLINE','OFFLINE','SHUTDOWN','SERVER_START') NOT NULL,
    occurredAt TIMESTAMP(6) NOT NULL,          -- when it actually happened
    detectedAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    bootID     CHAR(36) NULL,
    source     ENUM('HEARTBEAT','BOOT_REPORT','WATCHDOG','BACKLOG_GAP','SHUTDOWN_HOOK') NOT NULL,
    detail     VARCHAR(255) NULL,

    FOREIGN KEY (sensorID) REFERENCES Sensor(sensorID) ON DELETE CASCADE,
    INDEX idx_deviceevent_sensor_time (sensorID, occurredAt)
);
```

`occurredAt` and `detectedAt` are kept separate because for `OFFLINE` they genuinely
differ — the server can only notice after the timeout expires. `source` records how the
event was determined, so a `BACKLOG_GAP` refinement is distinguishable from the coarser
`WATCHDOG` estimate it replaces.

Unchanged: `Location`, `SensorType`, `Sensor`, `ErrorLog`, `Actuator`, `ActuatorLog`,
`ClimateRules`.

**No frontend breakage.** `/api/logs` uses an explicit column list (`server.js:213`),
so new columns are invisible until used. `/api/sensors` uses `SELECT *` but only on
`Sensor`, which is untouched.

New `SamplingConfig` is append-only — each interval change inserts a row rather than
updating one, preserving a history of the sampling rate for analysing data that spans
a config change.

`datetime` stays `TIMESTAMP` (whole seconds). Ticks are whole seconds by construction
and the minimum period is 2 s, so `TIMESTAMP(3)` is not needed; sub-second jitter is
captured by `readLatencyMs` instead.

New `SamplingConfig` table (Phase 3).

**Delivery:** `database.sql` begins with `DROP DATABASE IF EXISTS`, so it must not be
re-run against live data. Changes ship as a **separate migration script** with
`database.sql` updated in parallel for fresh installs.

### Accepted limitation: duplicate rows on retry

No uniqueness constraint is added, by decision — the existing table holds **6,969
duplicate `(sensorID, datetime)` pairs (6,971 extra rows)**, so applying one would
require deleting real data, and the whole migration is kept strictly additive.

Consequence: if an upload succeeds server-side but the 200 response is lost, the Pi
re-sends on the next flush and a duplicate row is created. This stays possible.

Mitigation is analytical rather than structural — duplicates are exact-match on
`(sensorID, datetime)` and can be collapsed at query time:

```sql
SELECT sensorID, datetime, MIN(logID) AS logID, ...
FROM SensorLog GROUP BY sensorID, datetime
```

Revisit only if measured duplicate rates on synced data turn out to matter.

### Timezone

Timestamps stay in **local time** to match existing data and the current dashboard.
The PC sends unambiguous epoch ms; the Pi formats to local time. This requires every
Pi to be set to the same zone as the PC:

```bash
sudo timedatectl set-timezone Asia/Bangkok
```

To be added to the deployment README.

---

## 7a. Server hardware constraint — slow disk

The backend PC runs on a spinning disk. This does **not** affect tick alignment: ticks
are computed on the Pi from its own synced clock, and the PC is not in the sampling
loop. Server slowness and sampling accuracy are independent problems here — under a
push design they would not have been, since every sample would have waited on this PC.

It does affect four things.

### Batch uploads — required, not optional

`flush_queue` currently sends **one HTTP POST per row** (`dht22.py:87`), each becoming
its own MySQL transaction. With the default `innodb_flush_log_at_trx_commit = 1`, every
transaction forces an fsync (~8–15 ms on a 7200 rpm disk).

Live sampling is trivial — 4 sensors ÷ 5 s = 0.8 inserts/sec. The backlog drain is not.
A 6-hour outage across 4 Pis:

| | Requests | Transactions | Disk time |
|---|---|---|---|
| One row per POST | 17,280 | 17,280 | ~4 min of pure fsync |
| Batched, 200 rows per POST | 87 | 87 | ~1.3 s |

While a drain grinds, live inserts from other Pis queue behind it on the same disk — so
this degrades ongoing recording, not just catch-up.

Add `POST /api/sensorLogBatch` accepting an array, inserted as one multi-row `INSERT`.
The Pi flushes in capped chunks so a large backlog cannot monopolise the server.

### Index — reconsider

`/api/logs` defaults to 6 hours, ~17k rows out of ~8.4M. With no index MySQL scans all
8.4M on every dashboard refresh: **7–10 s on HDD** versus 50–200 ms indexed. The index
was dropped from scope under SSD assumptions; on a spinning disk the trade is different.

One-time build cost of 5–15 minutes, runnable at any time since the Pis cache locally.

### MySQL config — largest win, no schema change

`innodb_buffer_pool_size` defaults to **128 MB** while `SensorLog` is near 1 GB, so the
working set is re-read from disk constantly. In `my.ini` on the server:

```ini
[mysqld]
innodb_buffer_pool_size = 2G
```

Roughly 25–50 % of that machine's RAM. Free and reversible.

### Clock sync must tolerate server stalls

Cristian's algorithm assumes symmetric delay; server-side processing breaks that.
Adjustments to §3:

- Raise probe count from 5 to 10, keep the minimum-RTT sample.
- **Reject any sync with RTT > ~100 ms**, keeping the previous offset. A bad sync is
  worse than a slightly stale one.
- Persist the accepted RTT so the report can state real error bars.

Node's event loop is the specific risk: serialising a 17k-row `/api/logs` response
blocks `/api/time` along with everything else. The index above mitigates this too.

### Consequence for Phase 5 measurements

Both terms of `recordedAt - datetime` get noisier on this hardware — sync error grows
with server load, HDD commit latency grows with disk contention. If true write latency
is ~15 ms and sync error is ±20 ms, the measurement is mostly noise.

Report the delay **with error bars derived from the logged RTT**, not as a point value.

---

## 8. Bugs found while reading (independent of this work)

| Location | Issue |
|----------|-------|
| `dashboard/backend/server.js:329` | **`/api/getDataC5A` is broken.** Missing comma in `temperature, humidity windspeed` — every C5A insert fails with a SQL syntax error. Wind data is not reaching the DB. |
| `PI Env/sensorVPD/cache.py:67` | `cleanup()` uses `datetime.utcnow()` but rows are written with local `datetime.now()`. At UTC+7 the retention cutoff is 7 hours off. |
| `PI Env/sensorVPD/cache.py:42` | `get_unsent()` has no `LIMIT`. After a long outage it loads the entire backlog into memory on every flush attempt. |
| `PI Env/dht22.py:148` | `save_reading()` called without `sensor_id`, so cached rows store `sensorID` NULL. |
| `PI Env/C5A.py:164` | `ser.read(20)` on a 15-byte modbus response blocks the full `timeout=2` on every read, costing 2 s per cycle for nothing. See §4. |
| `PI Env/sensorVPD/cache.py:4`, `configReader.py:8`, `dht22.py:18` | `sensor_cache.db`, `device_uuid.txt` and `config.txt` are all **relative to the working directory**. Running `dht22.py` and `C5A.py` from one folder makes them share all three: both register as the *same* `sensorID`, and because `get_unsent()` has no sensor filter, each flushes the other's rows to the wrong endpoint — `dht22.py` posting C5A rows to `/api/getDataDHT` silently drops windspeed. Possible cause of the 1,126 windspeed-NULL rows on sensor 1. |
| `PI Env/README.md` | Documents `config.txt` as `Type: DHT22` key-value, but `configReader.py:17` calls `json.load()`, which would reject that. The README is stale; the real format is JSON. Relevant because the plan adds a `Period` key. |

All seven are fixed as part of this work. The cache-sharing fix is either a per-script
`DB_FILE` or a stream column with a filtered `get_unsent()`; the latter fits the batch
upload work in §7a.

---

## 9. File-by-file change list

### New — Pi

| File | Purpose |
|------|---------|
| `PI Env/sensorVPD/timesync.py` | Cristian's algorithm, `Clock`, boot id, system clock step |
| `PI Env/sensorVPD/scheduler.py` | `TickScheduler`, epoch-anchored ticks, pending period switch |
| `PI Env/sensorVPD/client.py` | `BackendClient` — discovery, registration, schedule poll, resync, flush, background maintenance thread |
| `PI Env/sync_clock.py` | Boot-time clock step, run as root before the sensor service |
| `PI Env/deploy/sensor-timesync.service` | systemd oneshot, ordered before the sensor service |
| `PI Env/deploy/sensor.service` | systemd unit for the sensor loop |
| `PI Env/deploy/010-timesync-sudoers` | Optional passwordless `timedatectl`, only for manual runs |

### Modified — Pi

| File | Change |
|------|--------|
| `PI Env/sensorVPD/cache.py` | Add `bootID`, `monotonic`, `timeConfidence`, `readLatencyMs` via `PRAGMA table_info` migration; add `correct_boot_timestamps()`; add `LIMIT` to `get_unsent()`; fix `cleanup()` timezone |
| `PI Env/sensorVPD/configReader.py` | Accept optional `Period` as a local fallback |
| `PI Env/sensorVPD/__init__.py` | Export new modules |
| `PI Env/dht22.py` | Tick-driven loop, retry budget, shared `BackendClient` |
| `PI Env/C5A.py` | Tick-driven loop, shared `BackendClient` |
| `PI Env/README.md` | Timezone, systemd install, `set-ntp false` |

Note: `dht22.py` and `C5A.py` currently duplicate ~80 lines each (`discover_backend`,
`register_sensor_if_needed`, `flush_queue`, `maybe_refresh_network`). Extracting
`client.py` avoids writing the new time-sync and schedule logic twice, so this makes
the change smaller rather than larger.

### Modified — backend

| File | Change |
|------|--------|
| `dashboard/backend/server.js` | Add `GET /api/time`, `GET/POST /api/schedule`, `POST /api/heartbeat`, `GET /api/devices`, `GET /api/deviceEvents`; offline watchdog with startup grace period; fix C5A SQL typo; accept the five new `SensorLog` fields |
| `dashboard/database.sql` | Add `SamplingConfig`, `DeviceEvent`, new `SensorLog` + `DeviceStatus` columns (fresh installs) |
| `dashboard/migration_timesync.sql` | **New** — additive ALTERs + new tables for existing databases |
| `dashboard/frontend/` | Interval control writing to `POST /api/schedule`; device on/off status panel |

Pi additions for Phases 5–6: `client.py` gains heartbeat posting with `bootID` +
`/proc/uptime`, and per-row `tickJitterMs` / `queueDelayMs` capture;
`deploy/sensor.service` gains an `ExecStop` shutdown hook.

---

## 10. Verification

1. **Sync accuracy** — log offset and RTT on every sync; RTT on LAN should be single-digit ms.
2. **Alignment** — re-run the coverage query from §1 on new data. Target: near 100 % of
   ticks containing all sensors, versus the current 2.7 %.
3. **Boot recovery** — power cycle a Pi with the PC unreachable, confirm it keeps
   collecting, then restore the network and confirm `ESTIMATED` rows become `CORRECTED`
   with sane timestamps.
4. **Interval switch** — change 5 s → 10 s while running, confirm every Pi switches on
   the same tick.
5. **Latency** — check `recordedAt - datetime` on live rows sits in the tens of ms, and
   that backlog rows are separable by `queueDelayMs`.
6. **Power-cycle log** — pull the plug on a Pi, confirm `OFFLINE` appears after the
   watchdog threshold; restore power and confirm `BOOT` lands with a sane `bootAt` and
   the off-time is refined from the backlog gap.
7. **Server-downtime pitfall** — stop the backend for 10 minutes while the Pis keep
   running, restart, and confirm **no** spurious `OFFLINE` events were logged.

---

## 11. Optional hardware note

A **DS3231 RTC module** (~100–150 THB) holds time across power-off to ~2 ppm. It does
*not* solve alignment — Phase 2 is still required — but it removes the boot-order
dependency entirely and keeps the Pi correct even when the PC is off. Given that
"cost-efficient" is an explicit project goal, it is cheap insurance worth considering.

---

## 12. Open items

- Existing `11-8-2026_sensorlog.csv` data was collected with drifting clocks. Decide
  whether to discard it, or keep it flagged as `UNKNOWN` confidence for the report's
  "before" comparison.
- Heartbeat cadence: 60 s (reuses the existing maintenance cycle, ~3 min to detect a
  dead Pi) or 30 s. Does not affect recorded off-time precision, which comes from the
  backlog gap.
- Whether to add the `SensorLog (sensorID, datetime)` index after all — dropped from
  scope under SSD assumptions, but worth 7–10 s → 50–200 ms per dashboard refresh on
  the actual spinning-disk server. See §7a.

### Blocking: unmeasured facts about the server PC

None of the development machine's specs apply — the backend runs on a different,
slower box. The following are **assumed, not verified**, and several decisions depend
on them:

| Fact | Needed for | How |
|------|-----------|-----|
| MySQL **server** version | Whether the migration is instant (needs 8.0.12+) or a locking rebuild | `SELECT VERSION();` |
| RAM | Sizing `innodb_buffer_pool_size` | `Get-CimInstance Win32_ComputerSystem` |
| Disk type (HDD/SSD) | Whether §7a applies at all | `MSFT_PhysicalDisk.MediaType` |
| `SensorLog` size | Index build time, buffer pool target | `information_schema.TABLES` |
| Current `innodb_buffer_pool_size` | Whether it is still the 128 MB default | `SELECT @@innodb_buffer_pool_size;` |

`ALGORITHM=INSTANT` fails closed — if unsupported it errors and changes nothing — so
the migration is safe to attempt before these are known.
