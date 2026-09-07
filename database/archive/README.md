# Archived SQL — history, and the one upgrade path

Everything here is superseded, with **one exception**:
`Database_v3.6_upgrade.sql` is still live. It is kept in this folder rather
than beside the install file because it is not how you build a database — it is
how you move an existing one.

| | build a new database | upgrade the one you have |
|---|---|---|
| file | `database/Database_v3.6.sql` | `database/archive/Database_v3.6_upgrade.sql` |
| database name | `sensor_dashboard_v3_6`, written into the file | taken from the command line |
| starts by | `DROP DATABASE IF EXISTS` | nothing — it inspects first |
| existing data | destroyed | preserved |
| re-runnable | yes, by rebuilding from empty | yes, second run is a no-op |

```bash
# new
mysql -u root -p < database/Database_v3.6.sql

# existing — the live one, back it up first
mysql -u root -p sensor_dashboard_v3af < database/archive/Database_v3.6_upgrade.sql
```

Both produce the same v3.6 schema. `Database_v3.6.sql` was split out of the
upgrade file because one file doing both jobs had to be written defensively
throughout — `CREATE TABLE IF NOT EXISTS` everywhere, two guards, and 470 lines
of migration history — none of which means anything on an empty database.

## Everything else here is history

Kept because `ERD.md`, `Weather ERD.md` and the plan documents in
`AI Assistant/` describe them, and the project report may want the lineage.
**None of these is an install path.**

| File | What it was | Superseded by |
|---|---|---|
| `database_v2.sql` | the v2 schema; was `dashboard/database.sql` | `Database_v3.6.sql` |
| `migration_timesync.sql` | v2 → v2+timesync | **nothing — a dead end, see below** |
| `Database_v3.sql` | first v3 schema, never deployed | `Database_v3.6.sql` |
| `Database_v3af.sql` | v3 actuator rework; the schema the live database was built from | `Database_v3.6.sql` |
| `migration_mist.sql` | v3af → v3.5, mist maker | M004 in the upgrade file |
| `M005_device_liveness.sql` | the standalone opt-in M005, **never run** | M005 in the upgrade file |
| `Database_v3.5.sql` | schema + M001-M004; refused to run on a pre-M005 database | `Database_v3.6_upgrade.sql` |
| `weather.sql` | a separate `sensor_system` database, referenced by nothing in this codebase | — |

`database_v2.sql`, `Database_v3.sql` and `Database_v3af.sql` all begin with
`DROP DATABASE`, like `Database_v3.6.sql` does — but each names an *older*
database, and `Database_v3af.sql` names the live one. Running that file is how
you destroy every reading the project has.

`M005_device_liveness.sql` was written, never run, and superseded before it
was. The upgrade file folds it in and improves it: the standalone version
aborted when an actuator's Pi had no `Device` row, which deadlocked — the new
backend creates that row but cannot run against the old schema. M005 as it
ships now reconstructs the `Device` from the UUID already on the `Actuator`
row instead.

## `migration_timesync.sql` is a dead end

It cannot be folded into the upgrade file and **must never run against a
v3-family database**, because v3 re-keyed all three tables it touches:

| | `migration_timesync.sql` (v2) | v3.6 |
|---|---|---|
| `DeviceStatus` | `UNIQUE KEY` on `sensorID`, plus `lastSeen` / `isOnline` | `PRIMARY KEY deviceID`, `connectionStatus` |
| `DeviceEvent` | `sensorID` → FK to `Sensor` | `deviceID` → FK to `Device` |
| `SamplingConfig` | `effectiveFrom TIMESTAMP(6)` | `effectiveFrom BIGINT`, epoch ms |

Run it on v3.6 and it tries to add a unique key on `DeviceStatus(sensorID)` —
a column that does not exist — and stops partway through, leaving the database
half-migrated. The upgrade file's guard 1 catches the reverse mistake
(pointing it at a v2 database).

It is kept as the record of how the live v2 database was brought up to the
timesync design.
