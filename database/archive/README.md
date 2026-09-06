# Archived SQL — history, not install paths

**Nothing in this folder is part of any install.** The only install path is
`database/Database_v3.6.sql`, which is the complete v3.6 schema *and* every
migration in one idempotent file: it builds a database from nothing or
upgrades an existing one, and running it twice changes nothing the second
time.

```
mysql -u root -p <your_database> < database/Database_v3.5.sql
```

These files are kept because `ERD.md`, `Weather ERD.md` and the plan documents
in `AI Assistant/` describe them, and the project report may want the history.

| File | What it was | Superseded by |
|---|---|---|
| `database_v2.sql` | the v2 schema; was `dashboard/database.sql` | `Database_v3.5.sql` §1 |
| `migration_timesync.sql` | v2 → v2+timesync | **nothing — a dead end, see below** |
| `Database_v3.sql` | first v3 schema | `Database_v3.5.sql` §1 |
| `Database_v3af.sql` | v3 actuator rework | `Database_v3.5.sql` §1 + M003 |
| `migration_mist.sql` | v3af → v3.5, mist maker | `Database_v3.5.sql` M004 |
| `weather.sql` | a separate `sensor_system` database, referenced by nothing in this codebase | — |
| `Database_v3.5.sql` | schema + M001-M004; refused to run on a pre-M005 database | `Database_v3.6.sql` |
| `M005_device_liveness.sql` | the standalone opt-in M005, **never run** | folded into `Database_v3.6.sql` as M005 |

`database_v2.sql`, `Database_v3.sql` and `Database_v3af.sql` all begin with
`DROP DATABASE`. That is why they are here and not on the install path:
running any of them against the live database destroys every reading it holds.

`Database_v3.5.sql` is safe to run but incomplete - it stops with a
`STOP_run_database_M005...` guard on any database that has not had M005
applied, which is now every database. Use v3.6.

`M005_device_liveness.sql` was written, never run, and superseded before it
was. v3.6 folds it in and improves it: the standalone version aborted when an
actuator's Pi had no `Device` row, which deadlocked - the new backend creates
that row but cannot run against the old schema. v3.6 reconstructs it from the
UUID already on the `Actuator` row instead.

## `migration_timesync.sql` is a dead end

It cannot be folded into `Database_v3.5.sql` and **must never run against a
v3-family database**, because v3 re-keyed all three tables it touches:

| | `migration_timesync.sql` (v2) | v3.5 |
|---|---|---|
| `DeviceStatus` | `UNIQUE KEY` on `sensorID`, plus `lastSeen` / `isOnline` | `PRIMARY KEY deviceID`, `connectionStatus` |
| `DeviceEvent` | `sensorID` → FK to `Sensor` | `deviceID` → FK to `Device` |
| `SamplingConfig` | `effectiveFrom TIMESTAMP(6)` | `effectiveFrom BIGINT`, epoch ms |

Run it on v3.5 and it tries to add a unique key on `DeviceStatus(sensorID)` —
a column that does not exist — and stops partway through, leaving the database
half-migrated. `Database_v3.5.sql` guard 1 catches the reverse mistake
(pointing the v3.5 file at a v2 database).

It is kept as the record of how the live v2 database was brought up to the
timesync design.
