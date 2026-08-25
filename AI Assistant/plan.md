# Mist Maker — dashboard control plan

Put the mist maker under dashboard control by turning
`Pi Actuator/relay_control.py` into a service, built the same way as the sensor
Pi clients.

- Written: 2026-08-24
- Status: **plan only, nothing built**
- Depends on: `database/Database_v3af.sql`, the `/api/actuator*` endpoints in
  `dashboard/backend/server.js` (v2.2.1af block)

---

## 1. Scope

`relay_control.py` does everything on the Pi: find the backend, register
itself, poll for commands, trigger the relay, report status. One file. It runs
under systemd with `Restart=always`.

```
python3 relay_control.py 60      # unchanged — manual bench run, 60 seconds
python3 relay_control.py serve   # new — service mode
python3 relay_control.py flip    # new — one raw pulse, see section 3
```

`mist_trigger.py` changes in exactly one way: the pin is an optional argument
(`python3 mist_trigger.py D27`) instead of a hardcoded `D17`, defaulting to
`D17` so running it bare behaves as it always did. The hardware behaviour is
untouched. It pulses the pin for 100 ms and the
process exits — that start-to-exit cycle is what the board reacts to, and the
comment at the bottom says the missing `deinit()` is deliberate. `fire()`
keeps shelling out to it. Do not inline it, do not replace it with a direct
GPIO write.

Climate rules are **database only** in this plan: the tables get shaped,
nothing reads them yet, and no rule logic goes on the Pi. §4.2.

(Housekeeping: the docstring in `relay_control.py` calls the file `control.py`
and the trigger `trigger.py`. Fix the names while editing.)

---

## 2. Follow the sensor Pi

`PI sensor/` already solved most of this. Copy its shape rather than inventing
a second one — the useful half of this plan is the right-hand column.

| Sensor Pi | Mist maker |
|-----------|------------|
| `config.txt`, `key: value` | same parser, same format |
| `device_uuid.txt`, auto-created | **the same `device_uuid.txt`** — see §6.1 |
| `networkList.txt`, candidate IPs | same file, same format |
| `network.networkSearch()` | same 15 lines, copied into `relay_control.py` |
| `POST /api/registerSensor` → `sensorID` | `POST /api/registerActuator` → `actuatorID` |
| `GET /api/schedule` — poll for the period | `GET /api/actuatorCommand` — poll for the command |
| `POST /api/heartbeat` | `POST /api/actuatorState` (§5.2) |
| `deploy/sensor.service` | `deploy/mist.service` |

And what the mist maker does **not** need, which is why this stays one file
instead of a `sensorVPD`-style package:

| Sensor Pi has | Mist maker skips it because |
|---------------|------------------------------|
| SQLite offline cache | commands are not data. A command missed during an outage is stale by the time the link is back; there is nothing worth replaying. |
| clock sync (`timesync.py`) | nothing here interprets a timestamp. A wrong clock cannot misfire the relay. |
| tick scheduler | no sampling deadline. A 5 s network stall just delays the next poll. |
| background maintenance thread | with no real-time loop to protect, blocking `requests` on the main thread is fine. |
| batch upload | the server writes `ActuatorLog` itself when a command is issued. |

### Let it crash

Because systemd restarts it, `relay_control.py` does not need broad
`try/except` or retry ladders. An unexpected error should kill the process;
systemd brings it back in 10 s, and start-up converges the relay to OFF (§6).
Catch only what you intend to continue past — a failed poll, a failed report.

One consequence, and it is the right one: a crash mid-run turns the mister
**off** and does not resume it. Someone presses Start again. For a device that
can flood a dome, not resuming is the correct default.

---

## 3. The one thing the sensors do not have: the board toggles

- **The board is edge-triggered and latching.** No "set ON", no "set OFF".
  One input: *toggle*. Fire once and it flips to whatever it was not.
- **The dashboard is level-based.** `GET /api/actuatorCommand` returns the
  latest command, re-served on every poll. It is a level, not an edge.
- **There is no readback.** The Pi cannot ask the board what state it is in.

Polling naively strobes the mister at the poll rate. So the script keeps a
**believed state** on disk and fires only on a transition:

```
if desired != believed:
    fire()                 # exactly one pulse
    believed = desired     # write to disk BEFORE reporting
```

`mist_state.json`, next to the script:

```json
{ "believed": "OFF", "lastActionID": 412 }
```

Write to a temp file and `os.replace()`. A half-written state file after a
power cut is worse than none, because it would be trusted.

`lastActionID` is what makes polling a level endpoint safe: a command is
applied once and never re-applied, so the Pi's own auto-off is not undone on
the next poll by the stale `ON` still sitting at the top of the log.

**Drift** — a missed pulse, a power glitch, someone pressing the physical
button — cannot be detected with no readback. Rather than build UI for it,
`relay_control.py flip` sends one raw pulse from the command line and leaves
the stored belief alone — with two states a disagreement is always exactly one
toggle, so the pulse alone restores agreement, and it is the hardware that
moves. Pulsing *and* inverting the belief would move both and leave them just
as far apart. Stop the service, flip, start it. Rare enough that a
documented bench command beats an enum value and a dashboard button.

---

## 4. Database

### 4.1 Migration for the mist maker

`database/migration_mist.sql`, idempotent, following the
`information_schema` + `PREPARE` pattern already in
`dashboard/migration_timesync.sql`. Runs **after** `Database_v3af.sql`, which
creates the tables it builds on. Never re-run `Database_v3af.sql` against live
data — it opens with `DROP DATABASE`.

**Schema only — no `INSERT`s.** See §4.3.

```sql
-- A run has a length. There is nowhere to put one today.
ALTER TABLE ActuatorLog ADD COLUMN durationSeconds INT NULL AFTER pwmDutyPercent;

-- The command poll and the /api/actuators subqueries both hit this. The FK
-- gives an index on actuatorID alone, which is not enough once the log has a
-- year of rows in it.
CREATE INDEX idx_actuatorlog_lookup ON ActuatorLog (actuatorID, actionID);
```

Do **not** overload `pwmDutyPercent` to carry seconds. It is `DECIMAL(5,2)`,
so it caps at 999.99, and a duty column holding a duration reads fine today
and is unexplainable in six months.

Columns that do not apply to a mist maker stay `NULL` — `pwmDutyPercent`,
`pulseCount`, `rpm`, `powerDraw`. Do not backfill zeros; a zero duty means
something for a fan and nothing here.

### 4.2 Climate rules — database only

Nothing reads these yet. They go in now so that the next step is writing an
evaluator, not migrating a schema mid-feature. Two gaps to close first:

```sql
-- A rule says "humidity < 60" but not WHERE. Unusable across two domes.
ALTER TABLE ClimateRules ADD COLUMN locationID INT NULL AFTER ruleName;
ALTER TABLE ClimateRules ADD CONSTRAINT fk_rule_location
    FOREIGN KEY (locationID) REFERENCES Location(locationID) ON DELETE CASCADE;

-- A rule that turns the mister on has to say for how long, for the same
-- reason a manual run does.
ALTER TABLE ClimateRuleActuator ADD COLUMN durationSeconds INT NULL;
```

No rule is seeded. `ClimateRuleActuator.actuatorID` is `NOT NULL` with a
foreign key, so a rule cannot be linked to a device that has not registered
yet — and which `actuatorID` a device lands on depends on the order the Pis
come up. The migration carries the two statements as a comment, to run by hand
once `GET /api/actuators` shows the mister. Leave `isActive` false until an
evaluator exists.

The Pi needs no change when the evaluator arrives. It obeys the latest command
regardless of `triggerSource`, so an evaluator writing `AUTOMATION` rows into
`ActuatorLog` is picked up by the same poll that handles `MANUAL`. That is the
payoff for going through the database instead of calling the Pi directly.

### 4.3 Adding an actuator is a code path, not a SQL one

Nothing in the migration inserts a row, including the `MIST_MAKER` type. It
does not need to: `POST /api/registerActuator` is find-or-create the whole way
down, so a new device brings its own rows into existence on first contact.

| Table | How it gets its row |
|-------|---------------------|
| `ActuatorType` | looked up by `typeName`, inserted if absent |
| `Location` | looked up by `locationName`, inserted if absent |
| `Actuator` | upserted on `deviceUUID` (`UNIQUE`), so re-registering is a no-op |

`relay_control.py` sends `Type` and `Location` straight from its `config.txt`
and keeps calling until it gets an `actuatorID` back. Adding a mist maker is
therefore: write `config.txt`, start the service. No SQL, no dashboard step.

Seeding the type in the migration as well would make it a second source of
truth for the same data — correct on the day it runs, stale the first time
someone adds an actuator the normal way.

---

## 5. Backend

Three edits. The first is a **prerequisite, not polish.**

### 5.1 `GET /api/actuatorCommand` — order by `actionID`

`server.js:214` reads:

```sql
ORDER BY recordedAt DESC LIMIT 1
```

`ActuatorLog.recordedAt` is a plain `TIMESTAMP` — **one-second** precision.
Press OFF within the same second as ON and MySQL's row order is undefined. For
a fan that is a wrong duty for one poll. For a latching relay it leaves the
mister running with the dashboard showing OFF.

Change to `ORDER BY actionID DESC`, and add `actionID` and `durationSeconds`
to the `SELECT`. The Pi needs `actionID` for §3 — `commandedAtMs` cannot do
the job at one-second resolution either.

### 5.2 New: `POST /api/actuatorState`

`POST /api/actuatorStatus` hardcodes `action = 'SET_SPEED'` on the
`ActuatorLog` row it writes (`server.js:266`). For a mist maker every
heartbeat would append a meaningless row and bury the real ON/OFF history
within a day.

A sibling endpoint, about 20 lines, rather than branching inside the existing
one:

```
POST /api/actuatorState   { actuatorID, state: 'ON'|'OFF' }

  UPDATE Actuator SET status = ?, statusUpdatedAt = NOW() WHERE actuatorID = ?
  INSERT INTO ActuatorStatus (actuatorID, lastHeartbeat) VALUES (?, NOW())
```

No `ActuatorLog` row. The log stays a record of commands, which is what makes
it readable.

This changes what `Actuator.status` means. Today `POST /api/actuatorCommand`
writes it optimistically (`server.js:194`) — the dashboard says ON, the row
says ON, whether or not the Pi heard. Once the Pi reports, the column means
"what the hardware is doing". Leave the optimistic write alone; the Pi
overwrites it within one poll, and in the gap the dashboard shows intent.

### 5.3 `POST /api/actuatorCommand` — accept `durationSeconds`

Clamp to `MAX_MIST_SECONDS`, store it, ignore it on `OFF`.

```js
const MAX_MIST_SECONDS = 600   // server-side twin of the Pi's cap (section 6)
```

---

## 6. `relay_control.py`

### 6.1 `config.txt`

Same format and parser as the sensors:

```
Type: MIST_MAKER
Location: Inside Dome 1
GPIO: D17
description: mist maker, north bay
Poll: 5
MaxRun: 600
```

`Type` and `Location` are required and raise at startup if missing — a mister
that never registers would sit there polling nothing.

`GPIO` is read by `read_gpio()` — deliberately separate from `read_config()`
and forgiving, defaulting to `D17` if the key or the whole file is missing. It
is resolved for **every** mode, not just `serve`, because a bench run that
pulses a different pin than the service proves nothing.

`networkList.txt` and `device_uuid.txt` sit alongside it, both resolved
against `Path(__file__).parent` so launching from another cwd cannot create a
second identity.

### The UUID is shared with the sensors

Same filename, same read-or-create logic, same meaning: **one UUID per
physical Pi.** `sensorVPD/configReader.py` already shares one file between
`dht22.py` and `C5A.py`, and the mist maker joins that convention.

Nothing in the database joins `Actuator` to `Device` — `Actuator.deviceUUID`
has no foreign key — so this buys correlation for a human reading the
dashboard rather than anything the schema enforces. That is reason enough: one
box, one identifier, in both tables.

On a Pi that also runs sensors, point the actuator at the existing file rather
than letting it mint a second UUID:

```bash
ln -s "../PI sensor/device_uuid.txt" device_uuid.txt
```

On a mister-only Pi, skip that and it creates its own on first run. Same code
path either way — `device_uuid()` does not need to know which case it is in.

**The limit to know about:** the sensors get away with a shared UUID because a
sensor is identified by `(deviceUUID, typeID, locationID)` — a composite, so
one Pi can own several `Sensor` rows. `Actuator.deviceUUID` is `UNIQUE` on its
own, so **one Pi can own exactly one actuator row.** Fine today. The day this
Pi also drives the fan, the second `registerActuator` will silently no-op onto
the mist row and the two will fight over one `actuatorID`. The fix at that
point is a composite key on `Actuator`, not a second UUID file.

### 6.2 What gets added

`fire()` stays exactly as it is. `run_for(seconds)` is rewritten to go through
`set_state()` — same behaviour, same `try/finally`, but manual runs now update
the state file, so switching between bench and service mode does not leave a
stale belief.

| Function | Job |
|----------|-----|
| `load_state()` / `save_state()` | `mist_state.json`, atomic write |
| `set_state(target)` | the §3 rule. **The only thing allowed to call `fire()`** apart from `flip` |
| `read_config()` | `config.txt`, copied from `sensorVPD/configReader.py` |
| `device_uuid()` | read-or-create `device_uuid.txt`, same as the sensors |
| `find_backend()` | `networkSearch` over `networkList.txt` against `/api/time` |
| `register()` | `POST /api/registerActuator` → `actuatorID` |
| `report(state)` | `POST /api/actuatorState` |
| `serve()` | the loop |

### 6.3 The loop

```
on start:
    state = load_state()
    if state.believed == "ON":  set_state("OFF")     # converge, see below

every Poll seconds:
    backend = find_backend() if the current one stopped answering
    actuator_id = register() if we do not have one
    cmd = GET /api/actuatorCommand?actuatorID=...

    if cmd.actionID != state.lastActionID:
        state.lastActionID = cmd.actionID
        if cmd.action == "ON":
            set_state("ON")
            off_at = now + min(cmd.durationSeconds or MaxRun, MaxRun)
        elif cmd.action == "OFF":
            set_state("OFF"); off_at = None
        report(state.believed)

    if off_at and now >= off_at:
        set_state("OFF"); off_at = None
        report(state.believed)

    report(state.believed) at least once a minute      # heartbeat
```

`SET_SPEED` is not meaningful here — log it once and ignore it.

---

## 7. Safety

A stuck-on mist maker floods a dome. Three rules, and none of them need the
network.

1. **Every ON has an end time.** There is no run-forever mode. `off_at` is
   always set, from `durationSeconds` or from `MaxRun` (default 600 s),
   whichever is smaller. This one rule is also the network failure story: if
   the backend disappears mid-run, the timer still fires. No separate
   fail-off logic, no dead-man counter.
2. **Start-up converges to OFF.** If `mist_state.json` says `ON`, the board is
   probably still misting from before the restart — fire once, persist, report.
   This is what makes `Restart=always` safe.
3. **Clean shutdown turns it off.** SIGTERM/SIGINT: if believed is `ON`, fire,
   persist, best-effort report. The `try/finally` already in `run_for()` has
   the right instinct and must survive the edit.

Plus one operational rule: **do not run serve mode and a manual
`relay_control.py 60` at once.** Routing `run_for()` through `set_state()`
keeps the belief consistent, but two processes racing on one state file and
one relay is still a mess. `systemctl stop mist` first.

---

## 8. Frontend

`dashboard/frontend/js/actuators.js` plus one panel in `index.html`, above the
device table. Same shape as the schedule panel in `devices.js` — plain
`fetch`, no framework, status in a `.muted` span.

```
Mist maker — Inside Dome 1                    [ ● ON  since 14:32:10 ]
  Run for [  60 ] seconds   (Start)  (Stop)
  last seen 3s ago
```

- Poll `GET /api/actuators` every 5 s, filter `typeName === 'MIST_MAKER'`.
- Start → `POST /api/actuatorCommand` `{ action:'ON', durationSeconds }`.
- Stop → `{ action:'OFF' }`. Always enabled, even when the UI thinks it is
  already off — if the belief is wrong, Stop must still be reachable.
- Grey the panel and show "offline" when `lastHeartbeat` is older than three
  poll intervals. The dot must never claim ON or OFF for a Pi that is not
  reporting; that is exactly when the value is least trustworthy.
- `statusUpdatedAtMs` is already returned by `/api/actuators` — use it rather
  than parsing `statusUpdatedAt`.

---

## 9. Deploy

`Pi Actuator/deploy/mist.service`, modelled on `PI sensor/deploy/sensor.service`:

```ini
[Unit]
Description=Mist maker actuator client
After=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/sp_dashboard/Pi Actuator
ExecStart=/home/pi/venv/bin/python3 relay_control.py serve
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

- Same venv as the sensors. `adafruit-circuitpython-dht` already pulled in
  `board` and `digitalio`, and `requests` is there. No new dependency.
- If this Pi also runs sensors, symlink `device_uuid.txt` to the sensor
  folder's copy **before** the first start (§6.1). Do it after and the mister
  has already minted a second UUID and registered under it.
- `Restart=always` is safe because of §7.2, and it is what lets the script
  skip defensive error handling (§2).
- No `sensor-timesync.service` dependency — nothing here reads a timestamp.
  Order it after timesync anyway if this Pi also runs sensors, purely so the
  journal lines up.

---

## 10. Build order

Each step is testable before the next starts.

- [!] **1.** `database/migration_mist.sql` — written, **not run.** Blocked, see
      below.
- [x] **2.** Backend §5.1, §5.2, §5.3 — `dashboard/backend/server.js`.
      Syntax-checked; not yet exercised against a database.
- [ ] **3.** Register by hand: `POST /api/registerActuator` with
      `{ deviceUUID:'<uuid>', actuatorType:'MIST_MAKER', locationName:'Inside Dome 1' }`,
      confirm it appears in `GET /api/actuators`. Blocked on step 1.
- [x] **4.** `set_state()` + state file — `Pi Actuator/relay_control.py`.
      Logic covered by a stubbed-`fire()` test: transition-only firing, atomic
      persistence, duration clamping, `SET_SPEED` not clearing a live timer,
      `flip`, config parsing. **Still needs a run against the real board.**
- [x] **5.** `serve()` — written. Needs a live backend to exercise.
- [ ] **6.** Break each rule in §7 deliberately and confirm the mister ends up
      off. Hardware, and the one step that cannot be faked.
- [x] **7.** Frontend panel — `frontend/js/actuators.js`, wired into
      `index.html` after `devices.js` (it reuses `formatAge`).
- [x] **8.** `Pi Actuator/deploy/mist.service`, `config.txt`,
      `networkList.txt`, `README.md`.

### Blocker on step 1

`Database_v3af.sql` has never been loaded. The live server has one database,
`sensor_dashboard`, and it is still the old v2 shape:

```
actuator  actuatorlog  climaterules  devicestatus  errorlog
location  sensor  sensorlog  sensortype
```

`ActuatorLog` there is `(actionID, actuatorID, action ENUM('ON','OFF'),
triggerSource, recordedAt)` — no `pwmDutyPercent`, no `ActuatorType`, no
`ActuatorStatus`, no `ClimateRuleActuator`. `migration_mist.sql` is additive on
top of v3af and has nothing to attach to. The timesync work is missing from
this database too (`Device`, `SamplingConfig`, `DeviceSession`, `DeviceEvent`).

It holds 37 `SensorLog` rows and 0 `ActuatorLog` rows, so this is a scratch
database rather than collected data — but which way to go is still a decision:

1. **Fresh v3af.** Run `Database_v3af.sql` (it creates
   `sensor_dashboard_v3af`), then `migration_mist.sql`, then point `DB_NAME` at
   it. Cleanest. The 37 rows are abandoned.
2. **Carry the rows over.** Same as above, plus a one-off copy of `SensorLog`
   and its parents. Only worth it if those 37 rows matter.
3. **Migrate `sensor_dashboard` in place.** Additive migration from v2 to v3af.
   The most work by far, and pointless for a scratch database.

Until one of those happens, nothing in §5 or §6 can be tested end to end.

---

## 11. Pitfalls

1. **Polling a level endpoint with a toggle relay.** §3. Symptom: the mister
   strobes at the poll rate. Gate on `actionID`.
2. **Calling `fire()` from new code.** Only `set_state()` and `flip`. Anything
   else and the belief drifts silently.
3. **Belief in memory only.** Every restart becomes a coin flip. Persist it,
   and converge to OFF on start.
4. **Server-side auto-off.** Tempting: issue `ON`, `setTimeout`, issue `OFF`.
   It does not survive a backend restart and the mister keeps running with
   nothing tracking it. The timer lives on the Pi.
5. **`ORDER BY recordedAt` at one-second precision.** §5.1. The failure needs
   two commands in the same second — exactly what an operator does when they
   mis-click and correct.
6. **Reporting before persisting.** Report, then crash, and the dashboard says
   ON while the file says OFF. File first.
7. **`deinit()` in `mist_trigger.py`.** The file says not to. Believe it.
8. **`Actuator.deviceUUID` is UNIQUE on its own.** Sharing `device_uuid.txt`
   with the sensors is fine — they key on `(deviceUUID, typeID, locationID)`
   and can have many rows per Pi. Actuators cannot. One Pi, one actuator row,
   until `Actuator` gets a composite key. §6.1.
9. **Re-running `Database_v3af.sql`.** First line is `DROP DATABASE`. Use the
   migration.
10. **`.env` still says `DB_NAME=sensor_dashboard`.** The new schema creates
    `sensor_dashboard_v3af`. Nothing here works until that changes — and
    changing it points the backend at an empty database, so plan the data move
    separately.

---

## 12. Open questions

- **What is a sane `MaxRun`?** 600 s is a guess. It should come from how long
  the unit tolerates running dry and how long the dome takes to reach target
  humidity. Answer before shipping — it is the outer bound on every failure
  mode in §7.
- **Hysteresis for the rules.** Not in the schema, deliberately. A rule at
  "humidity < 60" will flap around the threshold and hammer the relay. The
  next step needs either a second threshold to switch off at, or a minimum
  interval between runs. Decide which before writing the evaluator, since it
  is another column either way.
- **Which Pi runs this?** Only affects the deploy notes and whether the
  timesync ordering in §9 matters.
