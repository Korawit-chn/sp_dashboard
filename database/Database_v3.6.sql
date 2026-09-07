-- ============================================================================
-- sensor_dashboard v3.6 - fresh install
--
-- A BRAND NEW DATABASE. This file builds `sensor_dashboard_v3_6` from nothing,
-- in one command:
--
--     mysql -u root -p < database/Database_v3.6.sql
--
-- ----------------------------------------------------------------------------
-- IT DROPS THE DATABASE FIRST
--
-- The first statement is DROP DATABASE IF EXISTS sensor_dashboard_v3_6. Point
-- it at a database that holds readings and every one of them is gone, with no
-- prompt and no way back. This file is for building a new database, not for
-- upgrading one that already exists.
--
-- To UPGRADE an existing v3-family database in place - your live
-- `sensor_dashboard_v3af` is one - use the other file:
--
--     mysql -u root -p sensor_dashboard_v3af < database/archive/Database_v3.6_upgrade.sql
--
-- That one is idempotent, takes its database name from the command line, and
-- carries the full M001-M006 migration history. It is the only path that
-- preserves data. Back up before either:
--
--     mysqldump -u root -p sensor_dashboard_v3af > full_backup.sql
-- ----------------------------------------------------------------------------
--
-- The M-numbers in the comments below (M004, M005, M006) name migrations in
-- the history that produced this shape. Nothing here replays them - a new
-- database is created at v3.6 directly - but the reasoning is worth keeping
-- next to the columns it explains. The migrations themselves live in
-- database/archive/Database_v3.6_upgrade.sql.
--
-- AFTER RUNNING IT. The backend connects as `seniordashboard`, which has only
-- SELECT/INSERT/UPDATE/DELETE and is not created here. Grant it access, or the
-- backend cannot connect:
--
--     GRANT SELECT, INSERT, UPDATE, DELETE
--       ON sensor_dashboard_v3_6.* TO 'seniordashboard'@'%';
--     FLUSH PRIVILEGES;
--
-- Then point the backend at it in dashboard/backend/.env:
--
--     DB_NAME=sensor_dashboard_v3_6
--
-- and restart the backend, then every Pi - both clients cache their sensorID /
-- actuatorID in memory and only re-register on start.
--
-- HOW IT IS PUT TOGETHER
--   Section 1  the schema, every table, in dependency order
--   Section 2  seed data - one SamplingConfig row, and the version stamp
--   Section 3  optional performance work, commented out on purpose
--   Section 4  report - prints what you ended up with
--
-- NO SEED DATA beyond the one SamplingConfig default. Devices, sensors,
-- actuators, types and locations are created by their register endpoints on
-- first contact (POST /api/registerSensor, POST /api/registerActuator).
-- Seeding them here would be a second source of truth that goes stale the
-- moment someone adds hardware the normal way. A database built by this file
-- is empty and stays empty until a Pi talks to it.
-- ============================================================================

DROP DATABASE IF EXISTS sensor_dashboard_v3_6;
CREATE DATABASE sensor_dashboard_v3_6;
USE sensor_dashboard_v3_6;


-- ============================================================================
-- SECTION 1 - SCHEMA
--
-- Every table, in dependency order (a foreign key needs its parent to exist).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Bookkeeping. Not application data - the backend never reads this. It records
-- which migrations the database has had applied. A database built by this file
-- starts life at v3.6, so Section 2 stamps M001-M006 as already applied: they
-- describe how an older database reaches this shape, and none of them has any
-- work to do on one created here.
--
-- clear_all_data.sql must NOT empty this table: losing it would make every
-- migration look unapplied.
-- ----------------------------------------------------------------------------
CREATE TABLE SchemaVersion (
    migrationID VARCHAR(16) PRIMARY KEY,
    description VARCHAR(255) NOT NULL,
    appliedAt   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);


-- ----------------------------------------------------------------------------
-- Identity: where things are, what they are, which box they run on
-- ----------------------------------------------------------------------------

CREATE TABLE Location (
    locationID INT AUTO_INCREMENT PRIMARY KEY,
    locationName VARCHAR(100) NOT NULL,
    latitude DECIMAL(9,6),
    longitude DECIMAL(9,6),
    description VARCHAR(255),
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE SensorType (
    typeID INT AUTO_INCREMENT PRIMARY KEY,
    sensorType VARCHAR(50)
);

-- A Pi, not a sensor. One device owns several Sensor rows, and a power cut
-- takes out the whole box - which is why status, events and sessions all key
-- on deviceID rather than sensorID.
CREATE TABLE Device (
    deviceID INT AUTO_INCREMENT PRIMARY KEY,

    deviceUUID CHAR(36) NOT NULL UNIQUE,

    hostname VARCHAR(100) NULL,
    description VARCHAR(255) NULL,

    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE Sensor (
    sensorID INT AUTO_INCREMENT PRIMARY KEY,

    deviceID INT NOT NULL,
    typeID INT NOT NULL,
    locationID INT NOT NULL,

    sensorDescription TEXT NULL,

    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_sensor_device
        FOREIGN KEY (deviceID)
        REFERENCES Device(deviceID)
        ON DELETE CASCADE,

    CONSTRAINT fk_sensor_type
        FOREIGN KEY (typeID)
        REFERENCES SensorType(typeID),

    CONSTRAINT fk_sensor_location
        FOREIGN KEY (locationID)
        REFERENCES Location(locationID),

    -- What identifies a sensor. Includes deviceID, so a Sensor row's device
    -- never changes: a different device is a different row.
    CONSTRAINT uq_sensor_identity
        UNIQUE (
            deviceID,
            typeID,
            locationID
        )
);

CREATE TABLE SensorOffset (
    offsetID        INT AUTO_INCREMENT PRIMARY KEY,
    sensorID        INT NOT NULL,
    tempOffset      DECIMAL(5,2) DEFAULT 0.00,
    humidityOffset  DECIMAL(5,2) DEFAULT 0.00,
    windspeedOffset DECIMAL(5,2) DEFAULT 0.00,
    windDirOffset   INT DEFAULT 0,
    vpdOffset       DECIMAL(6,2) DEFAULT 0.00,
    appliedAt       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    appliedBy       VARCHAR(100) NULL,
    notes           TEXT NULL,
    CONSTRAINT fk_offset_sensor FOREIGN KEY (sensorID) REFERENCES Sensor(sensorID) ON DELETE CASCADE
);


-- ----------------------------------------------------------------------------
-- Readings
-- ----------------------------------------------------------------------------

CREATE TABLE SensorLog (
    logID BIGINT AUTO_INCREMENT PRIMARY KEY,
    sensorID INT NOT NULL,

    datetime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    temperature DECIMAL(5,2),
    humidity DECIMAL(5,2),
    windspeed DECIMAL(5,2),
    windDirection INT,
    VPD DECIMAL(6,2),

    timeConfidence ENUM(
        'SYNCED',
        'CORRECTED',
        'ESTIMATED',
        'UNKNOWN'
    ) NOT NULL DEFAULT 'UNKNOWN',

    tickJitterMs INT NULL,
    readLatencyMs INT NULL,
    queueDelayMs INT NULL,
    syncRttMs INT NULL,

    recordedAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    CONSTRAINT fk_sensorlog_sensor
        FOREIGN KEY (sensorID)
        REFERENCES Sensor(sensorID)
        ON DELETE CASCADE,

    -- Ticks are deterministic, so this is what makes an upload retry
    -- exactly-once: a replayed backlog is absorbed instead of duplicated.
    CONSTRAINT uq_sensorlog_reading
        UNIQUE (sensorID, datetime),

    INDEX idx_sensorlog_datetime (datetime)
);


-- ----------------------------------------------------------------------------
-- Device on/off tracking
-- ----------------------------------------------------------------------------

-- Written ONLY by the device-agent service (pi_common/device_agent.py), which
-- runs on every Pi and identifies itself by deviceUUID. Nothing else writes
-- liveness any more.
--
-- batteryLevel and signalStrength were removed in M005: both were the standard
-- pair from a battery-powered wireless-mote schema, which these mains-powered
-- LAN Pis are not, and neither ever had a writer. RSSI is worth adding back one
-- day - one radio per Pi makes it a device property, and it is what separates a
-- link outage from a power cut - but as an ALTER plus an agent change, not as a
-- column sitting always-NULL.
CREATE TABLE DeviceStatus (
    deviceID INT PRIMARY KEY,

    connectionStatus ENUM(
        'ONLINE',
        'OFFLINE',
        'UNKNOWN'
    ) DEFAULT 'UNKNOWN',

    lastHeartbeat TIMESTAMP NULL,

    bootID CHAR(36) NULL,
    bootAt TIMESTAMP(6) NULL,

    lastSyncAt TIMESTAMP(6) NULL,
    lastSyncOffsetMs INT NULL,
    lastSyncRttMs INT NULL,

    updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_device_status_device
        FOREIGN KEY (deviceID)
        REFERENCES Device(deviceID)
        ON DELETE CASCADE
);

-- deviceID is NULLable on purpose: SERVER_START belongs to the backend, not
-- to any one Pi.
CREATE TABLE DeviceEvent (
    eventID BIGINT AUTO_INCREMENT PRIMARY KEY,

    deviceID INT NULL,

    eventType ENUM(
        'BOOT',
        'ONLINE',
        'OFFLINE',
        'SHUTDOWN',
        'SERVER_START'
    ) NOT NULL,

    occurredAt TIMESTAMP(6) NOT NULL,
    detectedAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    bootID CHAR(36) NULL,

    source ENUM(
        'HEARTBEAT',
        'BOOT_REPORT',
        'WATCHDOG',
        'BACKLOG_GAP',
        'SHUTDOWN_HOOK'
    ) NOT NULL,

    detail VARCHAR(255) NULL,

    CONSTRAINT fk_device_event_device
        FOREIGN KEY (deviceID)
        REFERENCES Device(deviceID)
        ON DELETE CASCADE,

    INDEX idx_device_event_device_time (deviceID, occurredAt)
);

-- One powered-on period. UNIQUE (deviceID, bootID) is what makes opening a
-- session idempotent - a repeated boot report produces one row, not several -
-- and it is also what lets the backend reopen a session the watchdog closed
-- by mistake, when the device comes back on the same bootID.
CREATE TABLE DeviceSession (
    sessionID BIGINT AUTO_INCREMENT PRIMARY KEY,

    deviceID INT NOT NULL,
    bootID CHAR(36) NULL,

    startedAt TIMESTAMP(6) NOT NULL,
    endedAt TIMESTAMP(6) NULL,

    endReason ENUM(
        'POWER_LOSS',
        'SHUTDOWN',
        'UNKNOWN'
    ) NULL,

    -- Kept separate from endReason so a rough watchdog estimate is never
    -- mistaken for the exact time a clean shutdown reports.
    endAccuracy ENUM(
        'SHUTDOWN_HOOK',
        'BACKLOG_GAP',
        'WATCHDOG',
        'UNKNOWN'
    ) NULL,

    durationSeconds INT
        GENERATED ALWAYS AS (TIMESTAMPDIFF(SECOND, startedAt, endedAt)) VIRTUAL,

    CONSTRAINT uq_device_session_boot
        UNIQUE (deviceID, bootID),

    CONSTRAINT fk_device_session_device
        FOREIGN KEY (deviceID)
        REFERENCES Device(deviceID)
        ON DELETE CASCADE,

    INDEX idx_device_session_device_start (deviceID, startedAt)
);


-- ----------------------------------------------------------------------------
-- Sampling schedule
--
-- Append-only: each change inserts a row, so the sampling rate in force at any
-- past instant stays recoverable. effectiveFrom is a Unix epoch in ms, not a
-- datetime - every Pi derives its own tick instants from it and they must all
-- land on the same grid.
-- ----------------------------------------------------------------------------

CREATE TABLE SamplingConfig (
    configID INT AUTO_INCREMENT PRIMARY KEY,

    periodSeconds INT NOT NULL DEFAULT 5,

    -- How often a Pi UPLOADS what it has sampled (M006). Separate from
    -- periodSeconds because they are answers to different questions: the
    -- sampling period must be identical on every Pi and switch on a shared
    -- instant, which is what effectiveFrom below is for; uploads need no
    -- agreement at all, so this column has no effectiveFrom and Pis
    -- deliberately stagger.
    --
    -- It is NOT the heartbeat interval. The Pis heartbeat every 60 s and the
    -- backend marks a device OFFLINE after three misses, so a Pi uploading
    -- every 5 minutes is still online. Both sides keep those cadences apart on
    -- purpose - see DEFAULT_MAINTENANCE_SECONDS in pi_common/client.py.
    sendSeconds INT NOT NULL DEFAULT 60,

    effectiveFrom BIGINT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,

    note VARCHAR(255) NULL,

    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- ----------------------------------------------------------------------------
-- Errors
--
-- occurredAt is the device's own time; createdAt is server insert time. A read
-- failure on an offline Pi is only reported once the network returns, so
-- without both a 2am fault gets stamped 8am.
-- ----------------------------------------------------------------------------

CREATE TABLE ErrorLog (
    errorID BIGINT AUTO_INCREMENT PRIMARY KEY,
    sensorID INT,
    errorType VARCHAR(50),
    errorMessage TEXT,
    severity ENUM('LOW','MEDIUM','HIGH','CRITICAL') DEFAULT 'LOW',

    occurredAt TIMESTAMP NULL,

    timeConfidence ENUM(
        'SYNCED',
        'CORRECTED',
        'ESTIMATED',
        'UNKNOWN'
    ) NOT NULL DEFAULT 'UNKNOWN',

    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (sensorID)
        REFERENCES Sensor(sensorID)
        ON DELETE SET NULL,

    INDEX idx_errorlog_occurred (sensorID, occurredAt)
);


-- ----------------------------------------------------------------------------
-- Actuators
-- ----------------------------------------------------------------------------

CREATE TABLE ActuatorType (
    typeID      INT AUTO_INCREMENT PRIMARY KEY,
    typeName    VARCHAR(50) NOT NULL UNIQUE
);

-- Keyed on (deviceID, typeID, locationID), exactly like Sensor. It used to
-- carry a bare `deviceUUID CHAR(36) UNIQUE` with no foreign key, which meant a
-- Pi could own exactly ONE actuator - the fan and the mister could not share a
-- box. M005 replaced that with the deviceID FK below.
--
-- status/statusUpdatedAt live HERE, not in a separate table. What the hardware
-- is doing is a property of the actuator; whether the Pi reporting it is alive
-- is a property of the Device, and that lives in DeviceStatus.
CREATE TABLE Actuator (
    actuatorID      INT AUTO_INCREMENT PRIMARY KEY,
    deviceID        INT NOT NULL,
    typeID          INT NOT NULL,
    locationID      INT,
    actuatorName    VARCHAR(100),
    description     TEXT NULL,
    status          ENUM('ON','OFF','IDLE') DEFAULT 'IDLE',
    statusUpdatedAt TIMESTAMP NULL,
    isActive        BOOLEAN DEFAULT TRUE,
    createdAt       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_actuator_device FOREIGN KEY (deviceID) REFERENCES Device(deviceID) ON DELETE CASCADE,
    CONSTRAINT fk_actuator_type FOREIGN KEY (typeID) REFERENCES ActuatorType(typeID),
    CONSTRAINT fk_actuator_location FOREIGN KEY (locationID) REFERENCES Location(locationID) ON DELETE SET NULL,

    -- What identifies an actuator. Includes deviceID, so an Actuator row's
    -- device never changes: a different device is a different row.
    CONSTRAINT uq_actuator_identity UNIQUE (deviceID, typeID, locationID)
);

-- There is deliberately NO ActuatorStatus table. It existed to answer "is this
-- actuator's control loop alive", which DeviceStatus now answers for the whole
-- Pi - one liveness concept, written by one device-agent service per box.
--
-- The trade, stated so it is not rediscovered as a bug: a dead relay_control.py
-- on a Pi whose agent is still beating reads ONLINE. Restart=always in
-- mist.service is the mitigation.
--
-- See AI Assistant/deviceAgentPlan.md.

-- Commands and telemetry share this table, told apart by triggerSource:
-- MANUAL / AUTOMATION rows are commands the Pi polls for, SYSTEM rows are
-- feedback the Pi pushed back and are never served as a command.
--
-- durationSeconds (M004): how long a run should last. Carried by the two
-- actions that START one - ON, the mist relay, and SET_SPEED, the fan - and
-- never by OFF, which IS the end of a run. The cap differs by action and lives
-- in the backend's config.js: 600 s for a mister, because over-misting floods
-- the dome, and 3600 s for a fan, which has no equivalent hazard.
--
-- The Pi holds the deadline, not the server, and that is the point: a run has
-- to end on time even if the dashboard disappears halfway through it.
--
-- Deliberately NOT overloaded onto pwmDutyPercent - that is DECIMAL(5,2), so it
-- caps at 999.99, and a duty column holding a duration reads fine today and is
-- unexplainable later.
CREATE TABLE ActuatorLog (
    actionID        BIGINT AUTO_INCREMENT PRIMARY KEY,
    actuatorID      INT NOT NULL,
    action          ENUM('ON','OFF','SET_SPEED') NOT NULL,
    pwmDutyPercent  DECIMAL(5,2) NULL,
    durationSeconds INT NULL,
    pulseCount      INT NULL,
    rpm             INT NULL,
    triggerSource   ENUM('MANUAL','AUTOMATION','SYSTEM'),
    recordedAt      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_actuatorlog_actuator FOREIGN KEY (actuatorID) REFERENCES Actuator(actuatorID) ON DELETE CASCADE,

    -- M004. The Pi's command poll (WHERE actuatorID = ? ORDER BY actionID
    -- DESC) and the two correlated MAX() subqueries in GET /api/actuators all
    -- hit this. The foreign key gives an index on actuatorID alone, which
    -- stops being enough once the log has a year of rows in it.
    INDEX idx_actuatorlog_lookup (actuatorID, actionID)
);


-- ----------------------------------------------------------------------------
-- Climate rules - groundwork only
--
-- Nothing reads any of this yet: there is no evaluator in the backend and no
-- rule logic on the Pi. It is here so the next step is writing an evaluator
-- rather than migrating a schema half way through the feature.
--
-- The Pi needs no change when that lands. It obeys the latest command
-- regardless of triggerSource, so AUTOMATION rows written into ActuatorLog
-- are picked up by exactly the same poll that handles MANUAL.
--
-- Settle hysteresis before writing the evaluator: a bare "humidity < 60" flaps
-- around the threshold and hammers the relay. It needs either a second
-- threshold to switch off at or a minimum interval between runs, and either is
-- another column here.
-- ----------------------------------------------------------------------------

-- locationID (M004): a rule saying "humidity < 60" without saying WHERE is not
-- a rule, it is an ambiguity, once there are two domes. NULL means "any".
CREATE TABLE ClimateRules (
    ruleID          INT AUTO_INCREMENT PRIMARY KEY,
    ruleName        VARCHAR(100),
    locationID      INT NULL,
    parameter       VARCHAR(50) NOT NULL,
    thresholdValue  DECIMAL(6,2) NOT NULL,
    conditionType   ENUM('GREATER','LESS') NOT NULL,
    isActive        BOOLEAN DEFAULT TRUE,
    CONSTRAINT fk_rule_location FOREIGN KEY (locationID) REFERENCES Location(locationID) ON DELETE CASCADE
);

-- durationSeconds (M004): a rule that turns the mister on has to say for how
-- long, for the same reason a manual run does - the Pi refuses to run without
-- an end time.
CREATE TABLE ClimateRuleActuator (
    ruleID          INT NOT NULL,
    actuatorID      INT NOT NULL,
    action          ENUM('ON','OFF','SET_SPEED') NOT NULL,
    pwmDutyPercent  DECIMAL(5,2) NULL,
    durationSeconds INT NULL,
    PRIMARY KEY (ruleID, actuatorID),
    CONSTRAINT fk_ruleactuator_rule FOREIGN KEY (ruleID) REFERENCES ClimateRules(ruleID) ON DELETE CASCADE,
    CONSTRAINT fk_ruleactuator_actuator FOREIGN KEY (actuatorID) REFERENCES Actuator(actuatorID) ON DELETE CASCADE
);



-- ============================================================================
-- SECTION 2 - SEED DATA
--
-- One SamplingConfig row and the version stamp. Nothing else - see the note in
-- the header about why hardware is not seeded here.
-- ============================================================================

-- SamplingConfig is append-only and the backend reads the newest row, so this
-- must be the only row in a new database. 5 s sampling, 60 s uploads.
INSERT INTO SamplingConfig (periodSeconds, sendSeconds, effectiveFrom, active, note)
VALUES (5, 60, 0, TRUE, 'initial default');

-- The version stamp. Every migration up to v3.6, recorded as applied, because
-- the schema above IS their result. Without this a database built here would
-- look unmigrated, and the next migration file added to the project would try
-- to redo work that was never needed.
INSERT INTO SchemaVersion (migrationID, description) VALUES
  ('M001', 'SensorLog time-confidence and latency instrumentation'),
  ('M002', 'DeviceStatus boot tracking and clock health'),
  ('M003', 'v3af actuator rework - schema in section 1, no in-place path'),
  ('M004', 'Mist maker: run durations, rule locations, command-poll index'),
  ('M005', 'Device-only liveness: ActuatorStatus dropped, Actuator.deviceID FK, dead DeviceStatus columns removed'),
  ('M006', 'SamplingConfig.sendSeconds: upload interval, separate from the sampling period');


-- ============================================================================
-- SECTION 3 - OPTIONAL PERFORMANCE WORK
--
-- Not run automatically. Both matter once SensorLog is large, and the index
-- build is a one-off 5-15 minutes on a multi-million-row table. It can be run
-- at any time: the Pis cache locally, so nothing is lost while the table is
-- busy.
--
--   ALTER TABLE SensorLog ADD INDEX idx_sensorlog_sensor_time (sensorID, datetime);
--
-- On the spinning-disk server /api/logs was scanning ~8.4M rows on every
-- dashboard refresh (7-10 s). That index takes it to 50-200 ms, and also keeps
-- Node's event loop from stalling /api/time - which would show up as clock
-- error on the sensors.
--
-- Bigger win still, and no schema change at all - in my.ini on the server:
--
--   [mysqld]
--   innodb_buffer_pool_size = 2G
--
-- The default is 128 MB while SensorLog approaches 1 GB, so the working set is
-- re-read from disk constantly. Roughly 25-50% of that machine's RAM.
--
-- Worth checking on any new server:
--   SELECT VERSION();                  -- need 8.0.12+ for ALGORITHM=INSTANT
--   SELECT @@innodb_buffer_pool_size;  -- 134217728 means still the default
-- ============================================================================


-- ============================================================================
-- SECTION 4 - REPORT
-- ============================================================================

SELECT 'Database_v3.6.sql complete - fresh install' AS status,
       DATABASE() AS created,
       VERSION()  AS mysql_version;

SELECT migrationID, description, appliedAt
FROM SchemaVersion
ORDER BY migrationID;

-- Seventeen tables, all empty except SamplingConfig (1 row) and SchemaVersion
-- (6 rows). Anything else means this file did not finish.
SELECT TABLE_NAME AS table_name, TABLE_ROWS AS approx_rows
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME;

-- Next: grant the app user, point dashboard/backend/.env at this database
--       (DB_NAME=sensor_dashboard_v3_6), restart the backend, then restart
--       every Pi. Both clients register themselves on start, which is what
--       fills Device, Sensor and Actuator.
