-- ============================================================================
-- sensor_dashboard v3.6 - complete schema AND full migration history
--
-- ONE FILE, ONE RUN. Build a database from nothing, or bring any v3-family
-- database up to v3.6. Same file, same command, either way. Run it twice and
-- the second run changes nothing.
--
--   FRESH INSTALL
--     mysql -u root -p -e "CREATE DATABASE sensor_dashboard_v3af"
--     mysql -u root -p sensor_dashboard_v3af < database/Database_v3.6.sql
--
--   UPGRADE AN EXISTING DATABASE (this is the live one - it already holds data)
--     mysql -u root -p sensor_dashboard_v3af < database/Database_v3.6.sql
--
-- ----------------------------------------------------------------------------
-- READ THIS BEFORE RUNNING IT ON A DATABASE THAT HOLDS DATA
--
-- v3.5 promised "nothing here is destructive, point it at the live database
-- freely". v3.6 CANNOT make that promise. M005 in Section 3 DROPS the
-- ActuatorStatus table and three columns:
--
--     ActuatorStatus             the whole table - liveness moved to
--                                DeviceStatus, reported by the device agent
--     Actuator.deviceUUID        replaced by a real deviceID foreign key
--     DeviceStatus.batteryLevel  never had a writer
--     DeviceStatus.signalStrength           "
--
-- M005 also CREATES rows: a Device for any actuator whose Pi never registered
-- one, reconstructed from the UUID already stored on the Actuator.
--
-- Nothing of value is lost - M005 in Section 3 gives the row-by-row reasoning -
-- but it is a one-way change, so:
--
--     mysqldump -u root -p <your_database> > full_backup.sql
--
-- AND STOP THE PIs FIRST. On the old code the mist client writes to
-- ActuatorStatus every 60 s, and a write landing mid-migration is an error in
-- its journal.
--
--     sudo systemctl stop mist fan "sensor@*"
-- ----------------------------------------------------------------------------
--
-- The database name is NOT written into this file. It comes from the command
-- line, and every check below uses DATABASE(), so the same file works against
-- any name you choose. Run it with no database selected and MySQL stops with
-- "No database selected" rather than doing something surprising.
--
-- There is still NO "DROP DATABASE" here, unlike Database_v3af.sql - the drops
-- M005 performs are surgical and named above. To rebuild from scratch, drop it
-- yourself first, deliberately:
--     mysql -u root -p -e "DROP DATABASE sensor_dashboard_v3af"
--
-- Needs ALTER, INDEX and CREATE rights, so run it as root. The app user
-- (seniordashboard) has only SELECT/INSERT/UPDATE/DELETE. After a fresh
-- install, grant it access or the backend cannot connect:
--     GRANT SELECT, INSERT, UPDATE, DELETE
--       ON sensor_dashboard_v3af.* TO 'seniordashboard'@'%';
--     FLUSH PRIVILEGES;
--
-- HOW IT IS PUT TOGETHER
--   Section 0  safety guards - stop early on a database this cannot upgrade
--   Section 1  the schema, every table, CREATE TABLE IF NOT EXISTS
--   Section 2  seed data, inserted only if absent
--   Section 3  migration history, every migration, each one idempotent
--   Section 4  optional performance work, commented out on purpose
--   Section 5  report - prints what you ended up with
--
-- Section 1 handles a MISSING TABLE. Section 3 handles a table that exists in
-- an older shape and is missing COLUMNS or INDEXES - or, in M005, one that is
-- the wrong shape entirely. Together they cover every v3-family database.
-- Which migrations actually did something is recorded in the SchemaVersion
-- table, so a second run tells you where you stand.
--
-- WHAT CHANGED FROM v3.5: M005, which v3.5 refused to run - it stopped against
-- a pre-M005 database and told you to run database/M005_device_liveness.sql
-- yourself first. That separate file is folded in here and archived. And M006,
-- one additive column carrying the upload interval.
--
-- NO SEED DATA beyond one SamplingConfig default. Devices, sensors, actuators,
-- types and locations are created by their register endpoints on first contact
-- (POST /api/registerSensor, POST /api/registerActuator). Seeding them here
-- would be a second source of truth that goes stale the moment someone adds
-- hardware the normal way.
-- ============================================================================


-- ============================================================================
-- SECTION 0 - GUARDS
--
-- Two database shapes exist that this file CANNOT upgrade in place. Both are
-- caught here, before anything is written, because the alternative is worse:
-- CREATE TABLE IF NOT EXISTS silently accepts a table of the wrong shape, and
-- you would end up with a half-migrated database that appears to have worked.
--
-- A guard aborts by selecting from a table that does not exist. The error
-- message names it, and the name is the explanation. Nothing has been changed
-- at that point.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Guard 1: a v2 database (`sensor_dashboard`, and `dashboard/database.sql`)
--
-- In v2 a sensor carried its own deviceUUID and there was no Device table at
-- all. v3 introduced Device because a power cut takes out a whole Pi, not one
-- sensor, so DeviceStatus / DeviceEvent / DeviceSession all had to be re-keyed
-- from sensorID to deviceID.
--
-- That is a data migration, not a column addition: every Sensor row has to be
-- matched to a Device row that does not exist yet. It is deliberately not
-- attempted here. See "The v2 lineage" at the bottom of Section 3.
-- ----------------------------------------------------------------------------

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Sensor')
  AND NOT EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Sensor'
           AND COLUMN_NAME = 'deviceID'),
  'SELECT * FROM `STOP_v2_database_Sensor_has_no_deviceID_see_section_0_guard_1`',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ----------------------------------------------------------------------------
-- Guard 2: a pre-v3af database (`database/Database_v3.sql`)
--
-- There, Actuator carried `actuatorType VARCHAR(50)` inline. v3af replaced it
-- with a typeID foreign key into a new ActuatorType table, which means reading
-- every distinct actuatorType, creating a row per type, and rewriting each
-- Actuator to point at it - again a data migration, and one that was never
-- needed because v3 was never deployed. The live server went straight to v3af.
-- ----------------------------------------------------------------------------

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'
           AND COLUMN_NAME = 'actuatorType'),
  'SELECT * FROM `STOP_v3_database_Actuator_has_actuatorType_see_guard_2`',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- There is no Guard 3. An actuator whose Pi has no Device row - the normal
-- state of a mist Pi before this upgrade, because the old registerActuator
-- never created one - is HANDLED, not refused. See M005 step 1.
--
-- Refusing would have deadlocked: the new backend creates that Device row, but
-- it cannot talk to the old schema, and the old backend never creates it. The
-- UUID is already on the Actuator row, so the migration reconstructs the Device
-- from it instead.


-- ============================================================================
-- SECTION 1 - SCHEMA
--
-- Every table, in dependency order (a foreign key needs its parent to exist).
-- IF NOT EXISTS throughout, so this section is a no-op on a database that
-- already has them and creates the missing ones on a database that does not.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Bookkeeping. Not application data - the backend never reads this. It records
-- which migrations in Section 3 have run, so re-running this file tells you
-- what state the database is in instead of just succeeding silently.
--
-- clear_all_data.sql must NOT empty this table: losing it would make every
-- migration look unapplied.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS SchemaVersion (
    migrationID VARCHAR(16) PRIMARY KEY,
    description VARCHAR(255) NOT NULL,
    appliedAt   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);


-- ----------------------------------------------------------------------------
-- Identity: where things are, what they are, which box they run on
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS Location (
    locationID INT AUTO_INCREMENT PRIMARY KEY,
    locationName VARCHAR(100) NOT NULL,
    latitude DECIMAL(9,6),
    longitude DECIMAL(9,6),
    description VARCHAR(255),
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS SensorType (
    typeID INT AUTO_INCREMENT PRIMARY KEY,
    sensorType VARCHAR(50)
);

-- A Pi, not a sensor. One device owns several Sensor rows, and a power cut
-- takes out the whole box - which is why status, events and sessions all key
-- on deviceID rather than sensorID.
CREATE TABLE IF NOT EXISTS Device (
    deviceID INT AUTO_INCREMENT PRIMARY KEY,

    deviceUUID CHAR(36) NOT NULL UNIQUE,

    hostname VARCHAR(100) NULL,
    description VARCHAR(255) NULL,

    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Sensor (
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

CREATE TABLE IF NOT EXISTS SensorOffset (
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

CREATE TABLE IF NOT EXISTS SensorLog (
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
CREATE TABLE IF NOT EXISTS DeviceStatus (
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
CREATE TABLE IF NOT EXISTS DeviceEvent (
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
CREATE TABLE IF NOT EXISTS DeviceSession (
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

CREATE TABLE IF NOT EXISTS SamplingConfig (
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

CREATE TABLE IF NOT EXISTS ErrorLog (
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

CREATE TABLE IF NOT EXISTS ActuatorType (
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
CREATE TABLE IF NOT EXISTS Actuator (
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
CREATE TABLE IF NOT EXISTS ActuatorLog (
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
CREATE TABLE IF NOT EXISTS ClimateRules (
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
CREATE TABLE IF NOT EXISTS ClimateRuleActuator (
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
-- Inserted only when absent, so re-running this file does not stack up
-- duplicate defaults. SamplingConfig is append-only and the backend reads the
-- newest row, so a duplicate here would not be harmless.
-- ============================================================================

INSERT INTO SamplingConfig (periodSeconds, sendSeconds, effectiveFrom, active, note)
SELECT 5, 60, 0, TRUE, 'initial default'
WHERE NOT EXISTS (SELECT 1 FROM SamplingConfig);


-- ============================================================================
-- SECTION 3 - MIGRATION HISTORY
--
-- Every migration this schema has ever had, kept rather than folded away, so
-- one file can upgrade a database as well as build one.
--
-- Each step checks information_schema before it acts, so running this twice is
-- harmless. Only prepared statements are used - no stored routines - so it
-- works for a user with plain ALTER rights and no CREATE ROUTINE privilege.
--
-- On a database Section 1 just created, every one of these is already
-- satisfied and does nothing. They earn their place on a database that was
-- created by an older version of this schema.
--
--   M001  timesync instrumentation on SensorLog
--   M002  clock health and boot tracking on DeviceStatus
--   M003  v3af actuator rework                    - see the note under M002
--   M004  mist maker: durations, rule locations, the command-poll index
--   M005  device-only liveness - THE DESTRUCTIVE ONE, see the header
--   M006  SamplingConfig.sendSeconds - the upload interval
-- ============================================================================


-- ----------------------------------------------------------------------------
-- M001 - SensorLog instrumentation  (timeSyncPlan.md §5, §7)
--
-- Appended at the END of the table on purpose so MySQL 8.0.12+ can use
-- ALGORITHM=INSTANT and finish in milliseconds instead of rebuilding the whole
-- table. ALGORITHM=INSTANT fails closed: on an older server the statement
-- errors and changes nothing, and you should drop the clause and expect a
-- rebuild.
-- ----------------------------------------------------------------------------

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SensorLog'
           AND COLUMN_NAME = 'timeConfidence'),
  'SELECT 1',
  'ALTER TABLE SensorLog ADD COLUMN timeConfidence
     ENUM(''SYNCED'',''CORRECTED'',''ESTIMATED'',''UNKNOWN'')
     NOT NULL DEFAULT ''UNKNOWN'', ALGORITHM=INSTANT');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SensorLog'
           AND COLUMN_NAME = 'readLatencyMs'),
  'SELECT 1',
  'ALTER TABLE SensorLog ADD COLUMN readLatencyMs INT NULL, ALGORITHM=INSTANT');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SensorLog'
           AND COLUMN_NAME = 'tickJitterMs'),
  'SELECT 1',
  'ALTER TABLE SensorLog ADD COLUMN tickJitterMs INT NULL, ALGORITHM=INSTANT');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SensorLog'
           AND COLUMN_NAME = 'queueDelayMs'),
  'SELECT 1',
  'ALTER TABLE SensorLog ADD COLUMN queueDelayMs INT NULL, ALGORITHM=INSTANT');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- syncRttMs is the round-trip delay of the clock sync in force for THAT
-- reading, captured at the tick. Added in v3, after migration_timesync.sql.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SensorLog'
           AND COLUMN_NAME = 'syncRttMs'),
  'SELECT 1',
  'ALTER TABLE SensorLog ADD COLUMN syncRttMs INT NULL, ALGORITHM=INSTANT');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- recordedAt has a DEFAULT, so pre-migration rows get the value at ALTER time.
-- That is expected: rows collected before this work have no meaningful insert
-- time. Only rows written afterwards carry a real end-to-end delay.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SensorLog'
           AND COLUMN_NAME = 'recordedAt'),
  'SELECT 1',
  'ALTER TABLE SensorLog ADD COLUMN recordedAt TIMESTAMP(6) NOT NULL
     DEFAULT CURRENT_TIMESTAMP(6), ALGORITHM=INSTANT');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Exactly-once uploads depend on this key. NOTE: if the table already holds
-- two rows with the same (sensorID, datetime) - possible on a database that
-- predates it - this ALTER fails and names the duplicate. Deduplicate first;
-- do not drop the constraint, the Pi's retry logic relies on it.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SensorLog'
           AND INDEX_NAME = 'uq_sensorlog_reading'),
  'SELECT 1',
  'ALTER TABLE SensorLog ADD CONSTRAINT uq_sensorlog_reading
     UNIQUE (sensorID, datetime)');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SensorLog'
           AND INDEX_NAME = 'idx_sensorlog_datetime'),
  'SELECT 1',
  'CREATE INDEX idx_sensorlog_datetime ON SensorLog (datetime)');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT INTO SchemaVersion (migrationID, description)
VALUES ('M001', 'SensorLog time-confidence and latency instrumentation')
ON DUPLICATE KEY UPDATE appliedAt = appliedAt;


-- ----------------------------------------------------------------------------
-- M002 - DeviceStatus: boot tracking and clock health  (timeSyncPlan.md §6b)
--
-- Per device, not per sensor: it lets the dashboard show a Pi drifting before
-- its data is affected.
-- ----------------------------------------------------------------------------

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'DeviceStatus'
           AND COLUMN_NAME = 'bootID'),
  'SELECT 1',
  'ALTER TABLE DeviceStatus ADD COLUMN bootID CHAR(36) NULL');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'DeviceStatus'
           AND COLUMN_NAME = 'bootAt'),
  'SELECT 1',
  'ALTER TABLE DeviceStatus ADD COLUMN bootAt TIMESTAMP(6) NULL');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'DeviceStatus'
           AND COLUMN_NAME = 'lastSyncAt'),
  'SELECT 1',
  'ALTER TABLE DeviceStatus ADD COLUMN lastSyncAt TIMESTAMP(6) NULL');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'DeviceStatus'
           AND COLUMN_NAME = 'lastSyncOffsetMs'),
  'SELECT 1',
  'ALTER TABLE DeviceStatus ADD COLUMN lastSyncOffsetMs INT NULL');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'DeviceStatus'
           AND COLUMN_NAME = 'lastSyncRttMs'),
  'SELECT 1',
  'ALTER TABLE DeviceStatus ADD COLUMN lastSyncRttMs INT NULL');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- A row has to be able to exist before the first heartbeat lands.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'DeviceStatus'
           AND COLUMN_NAME = 'lastHeartbeat' AND IS_NULLABLE = 'YES'),
  'SELECT 1',
  'ALTER TABLE DeviceStatus MODIFY COLUMN lastHeartbeat TIMESTAMP NULL');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT INTO SchemaVersion (migrationID, description)
VALUES ('M002', 'DeviceStatus boot tracking and clock health')
ON DUPLICATE KEY UPDATE appliedAt = appliedAt;


-- ----------------------------------------------------------------------------
-- M003 - v3af actuator rework
--
-- NOT EXPRESSIBLE AS AN ADDITIVE MIGRATION, and deliberately not attempted.
--
-- v3af split Actuator's inline `actuatorType VARCHAR(50)` into an ActuatorType
-- table with a typeID foreign key, and added ActuatorStatus and
-- ClimateRuleActuator alongside it. Turning an existing v3 Actuator table into
-- that shape means reading every distinct actuatorType, creating a row per
-- type, rewriting each Actuator to point at it, and only then making typeID
-- NOT NULL - a data migration with a failure mode (a NULL typeID on a NOT NULL
-- column) that is worse than not starting.
--
-- It was never needed: v3 was never deployed. The live server went from v2
-- straight to v3af, built fresh.
--
-- Guard 2 in Section 0 stops this file rather than half-applying it. If you
-- ever do meet a v3 database, the honest path is: dump it, build a new one
-- with this file, and copy the rows across with an explicit type mapping.
--
-- The tables themselves are in Section 1 and are created there on any database
-- that lacks them, which covers every case except the one above.
-- ----------------------------------------------------------------------------

INSERT INTO SchemaVersion (migrationID, description)
VALUES ('M003', 'v3af actuator rework - schema in section 1, no in-place path')
ON DUPLICATE KEY UPDATE appliedAt = appliedAt;


-- ----------------------------------------------------------------------------
-- M004 - mist maker  (was database/migration_mist.sql, plan.md §4)
--
-- Two halves: 1-2 are what the mist maker needs to work, 3-4 are climate-rule
-- groundwork that nothing reads yet.
-- ----------------------------------------------------------------------------

-- 1. A mist run has a length, and there was nowhere to put one.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ActuatorLog'
           AND COLUMN_NAME = 'durationSeconds'),
  'SELECT 1',
  'ALTER TABLE ActuatorLog ADD COLUMN durationSeconds INT NULL AFTER pwmDutyPercent');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. The command poll and the two correlated MAX() subqueries in
--    GET /api/actuators all hit this.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ActuatorLog'
           AND INDEX_NAME = 'idx_actuatorlog_lookup'),
  'SELECT 1',
  'CREATE INDEX idx_actuatorlog_lookup ON ActuatorLog (actuatorID, actionID)');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. A rule has to say WHERE. NULL means "any location", which is the only
--    sane reading of any rows that exist before this runs.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ClimateRules'
           AND COLUMN_NAME = 'locationID'),
  'SELECT 1',
  'ALTER TABLE ClimateRules ADD COLUMN locationID INT NULL AFTER ruleName');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ClimateRules'
           AND CONSTRAINT_NAME = 'fk_rule_location'),
  'SELECT 1',
  'ALTER TABLE ClimateRules ADD CONSTRAINT fk_rule_location
     FOREIGN KEY (locationID) REFERENCES Location(locationID) ON DELETE CASCADE');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. A rule that turns the mister on has to say for how long.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ClimateRuleActuator'
           AND COLUMN_NAME = 'durationSeconds'),
  'SELECT 1',
  'ALTER TABLE ClimateRuleActuator ADD COLUMN durationSeconds INT NULL');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT INTO SchemaVersion (migrationID, description)
VALUES ('M004', 'Mist maker: run durations, rule locations, command-poll index')
ON DUPLICATE KEY UPDATE appliedAt = appliedAt;


-- ----------------------------------------------------------------------------
-- M005 - one liveness concept per Pi   (AI Assistant/deviceAgentPlan.md)
--
-- THE ONLY DESTRUCTIVE MIGRATION IN THIS FILE. It drops a table and three
-- columns. Read the warning at the top before running this on real data.
--
-- Liveness now lives in ONE place: DeviceStatus, written by the device-agent
-- service that runs on every Pi and identifies itself by the device UUID.
-- ActuatorStatus was a second, per-actuator answer to the same question.
--
-- WHAT IS LOST: nothing that was ever written. Measured on the live server
-- before removal - powerDraw and signalStrength were 0 of 65 rows;
-- pwmDutyPercent was written to ActuatorLog in the same request that wrote it
-- to ActuatorStatus; lastHeartbeat is what DeviceStatus now carries.
-- Actuator.status / statusUpdatedAt are NOT touched - what the hardware is
-- doing stays exactly where it has always been.
--
-- WHAT IS GIVEN UP, stated so it is not rediscovered as a bug: a dead
-- relay_control.py on a Pi whose agent is still beating will read ONLINE.
-- Restart=always in mist.service is the mitigation.
--
-- Dropping Actuator.deviceUUID also removes its UNIQUE constraint, which was
-- the thing limiting one actuator per Pi. The fan and the mister can now share
-- a box, keyed on (deviceID, typeID, locationID) like Sensor.
-- ----------------------------------------------------------------------------

-- 1. Reconstruct any missing Device row from the UUID on the Actuator.
--
--    The old registerActuator created an Actuator but never a Device, so the
--    mist Pi has an actuator pointing at a machine the database has never heard
--    of. Everything needed to fix that is already on the row: Actuator.deviceUUID
--    IS the Pi's device_uuid.txt, the same value registerSensor would have used.
--
--    This is a one-time reconstruction of a row the old code should have
--    written, not registration - hostname and description stay NULL and the
--    Pi fills them in on its next contact.
--
--    Doing it here rather than refusing in Section 0 is what avoids a deadlock:
--    the new backend WOULD create the Device, but it cannot run against the old
--    schema, and the old backend never creates it. Neither side can go first.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'
           AND COLUMN_NAME = 'deviceUUID'),
  'INSERT INTO Device (deviceUUID)
   SELECT DISTINCT a.deviceUUID
     FROM Actuator a
     LEFT JOIN Device d ON d.deviceUUID = a.deviceUUID
    WHERE d.deviceID IS NULL
      AND a.deviceUUID IS NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Actuator.deviceID
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'
           AND COLUMN_NAME = 'deviceID'),
  'SELECT 1',
  'ALTER TABLE Actuator ADD COLUMN deviceID INT NULL AFTER actuatorID');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Backfill deviceID. Step 1 guarantees every deviceUUID now matches a
--    Device, so this cannot leave a NULL behind.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'
           AND COLUMN_NAME = 'deviceUUID'),
  'UPDATE Actuator a
     JOIN Device d ON d.deviceUUID = a.deviceUUID
      SET a.deviceID = d.deviceID
    WHERE a.deviceID IS NULL',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. NOT NULL, so an upgraded database ends up in the same shape Section 1
--    builds on a fresh one. Skipped if any row is still NULL rather than
--    failing - a clear column state beats a confusing ALTER error.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'
           AND COLUMN_NAME = 'deviceID' AND IS_NULLABLE = 'YES')
  AND NOT EXISTS(SELECT 1 FROM Actuator WHERE deviceID IS NULL),
  'ALTER TABLE Actuator MODIFY COLUMN deviceID INT NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 5. What identifies an actuator, mirroring uq_sensor_identity. Includes
--    deviceID, so an Actuator row's device never changes: a different device
--    is a different row.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'
           AND CONSTRAINT_NAME = 'uq_actuator_identity'),
  'SELECT 1',
  'ALTER TABLE Actuator
     ADD CONSTRAINT uq_actuator_identity UNIQUE (deviceID, typeID, locationID)');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'
           AND CONSTRAINT_NAME = 'fk_actuator_device'),
  'SELECT 1',
  'ALTER TABLE Actuator
     ADD CONSTRAINT fk_actuator_device
     FOREIGN KEY (deviceID) REFERENCES Device(deviceID) ON DELETE CASCADE');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 6. Drop deviceUUID. The Pi still SENDS one to /api/registerActuator - it is
--    the lookup key for the Device - it is simply no longer stored twice.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'
           AND COLUMN_NAME = 'deviceUUID'),
  'ALTER TABLE Actuator DROP COLUMN deviceUUID',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 7. ActuatorStatus goes. No IF-guard needed - IF EXISTS is the guard, and on
--    a fresh install Section 1 never created it.
DROP TABLE IF EXISTS ActuatorStatus;

-- 8. DeviceStatus loses the two columns nothing ever wrote.
--
--    batteryLevel: inapplicable. Mains-powered Pis, and there will be no
--    battery. It is the standard pair from a battery-powered wireless-mote
--    schema, which this is not.
--
--    signalStrength: applicable and cheap, but deliberately out of scope. The
--    device agent is the natural writer for it - one radio per Pi makes RSSI a
--    device property - and adding it back is this ALTER reversed plus ~10 lines
--    reading /proc/net/wireless. What is not acceptable is keeping a column
--    with no writer: an always-NULL column is a promise the schema cannot keep.
--
--    Both were 0 of 2 rows, and GET /api/devices lists its columns explicitly,
--    so neither was ever even selected.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'DeviceStatus'
           AND COLUMN_NAME = 'batteryLevel'),
  'ALTER TABLE DeviceStatus DROP COLUMN batteryLevel',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'DeviceStatus'
           AND COLUMN_NAME = 'signalStrength'),
  'ALTER TABLE DeviceStatus DROP COLUMN signalStrength',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT INTO SchemaVersion (migrationID, description)
VALUES ('M005', 'Device-only liveness: ActuatorStatus dropped, Actuator.deviceID FK, dead DeviceStatus columns removed')
ON DUPLICATE KEY UPDATE appliedAt = appliedAt;


-- ----------------------------------------------------------------------------
-- M006 - the upload interval  (AI Assistant/samplingIntervalPlan.md)
--
-- One additive column, so this is an ordinary migration: nothing is dropped and
-- nothing is rewritten. Existing rows take the DEFAULT 60, which is exactly the
-- interval the Pi clients had hardcoded before this, so a database upgraded
-- here behaves identically until someone changes the number.
--
-- Appended at the end of the table for ALGORITHM=INSTANT, same reasoning as
-- M001 - though SamplingConfig has a handful of rows and would rebuild in
-- milliseconds either way.
-- ----------------------------------------------------------------------------

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SamplingConfig'
           AND COLUMN_NAME = 'sendSeconds'),
  'SELECT 1',
  'ALTER TABLE SamplingConfig ADD COLUMN sendSeconds INT NOT NULL DEFAULT 60');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT INTO SchemaVersion (migrationID, description)
VALUES ('M006', 'SamplingConfig.sendSeconds: upload interval, separate from the sampling period')
ON DUPLICATE KEY UPDATE appliedAt = appliedAt;


-- ----------------------------------------------------------------------------
-- M007 - unique names on the two lookup tables
--
-- helpers.js findOrCreate() resolves Location and SensorType by NAME using an
-- upsert: INSERT ... ON DUPLICATE KEY UPDATE. Device.deviceUUID and
-- ActuatorType.typeName have always carried the unique key that makes that
-- work. Location.locationName and SensorType.sensorType never did, and with no
-- key to collide on the upsert is simply an INSERT - so every registration
-- added another 'Inside Dome' row. Measured on an empty database: four
-- registrations, four Location rows.
--
-- The damage is not just clutter. The follow-up SELECT takes rows[0] with no
-- ORDER BY, so once duplicates exist the locationID a sensor is handed is no
-- longer stable - and uq_sensor_identity (deviceID, typeID, locationID) reads a
-- shifted locationID as a DIFFERENT sensor, splitting one physical sensor's
-- readings across two sensorIDs.
--
-- Unlike M001-M006 this cannot be a bare ALTER: a database that has been
-- running the refactored backend may ALREADY hold duplicates, and ADD UNIQUE
-- fails on those. Each half therefore repoints every reference onto the lowest
-- id for that name, deletes the rest, and only then adds the key. All three
-- steps are no-ops on a database that has no duplicates.
--
-- The MIN(id) survivor is the row every existing FK already points at in
-- practice, so the repointing below normally updates zero rows - it is there
-- for the database that drifted, not the one that did not.
-- ----------------------------------------------------------------------------

-- Location: repoint Sensor, Actuator and ClimateRules onto the surviving row.
UPDATE Sensor s
  JOIN Location l ON l.locationID = s.locationID
  JOIN (SELECT locationName, MIN(locationID) AS keepID
        FROM Location GROUP BY locationName) k ON k.locationName = l.locationName
SET s.locationID = k.keepID
WHERE s.locationID <> k.keepID;

UPDATE Actuator a
  JOIN Location l ON l.locationID = a.locationID
  JOIN (SELECT locationName, MIN(locationID) AS keepID
        FROM Location GROUP BY locationName) k ON k.locationName = l.locationName
SET a.locationID = k.keepID
WHERE a.locationID <> k.keepID;

UPDATE ClimateRules c
  JOIN Location l ON l.locationID = c.locationID
  JOIN (SELECT locationName, MIN(locationID) AS keepID
        FROM Location GROUP BY locationName) k ON k.locationName = l.locationName
SET c.locationID = k.keepID
WHERE c.locationID <> k.keepID;

-- Nothing references the losers now. The extra SELECT * wrapper materialises
-- the derived table so MySQL does not refuse to read Location while deleting
-- from it.
DELETE l FROM Location l
  JOIN (SELECT * FROM (SELECT locationName, MIN(locationID) AS keepID
                       FROM Location GROUP BY locationName) x) k
    ON k.locationName = l.locationName
WHERE l.locationID <> k.keepID;

-- SensorType: names first. A NULL name cannot take a unique key usefully -
-- MySQL treats every NULL as distinct - and it is also not something the
-- register route can ever look up again, so it is given a stable placeholder
-- rather than deleted, which would break Sensor's FK.
UPDATE SensorType SET sensorType = CONCAT('unknown-', typeID) WHERE sensorType IS NULL;

UPDATE Sensor s
  JOIN SensorType t ON t.typeID = s.typeID
  JOIN (SELECT sensorType, MIN(typeID) AS keepID
        FROM SensorType GROUP BY sensorType) k ON k.sensorType = t.sensorType
SET s.typeID = k.keepID
WHERE s.typeID <> k.keepID;

DELETE t FROM SensorType t
  JOIN (SELECT * FROM (SELECT sensorType, MIN(typeID) AS keepID
                       FROM SensorType GROUP BY sensorType) x) k
    ON k.sensorType = t.sensorType
WHERE t.typeID <> k.keepID;

-- Now the keys themselves, guarded the same way as every other step here.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Location'
           AND INDEX_NAME = 'uq_location_name'),
  'SELECT 1',
  'ALTER TABLE Location ADD CONSTRAINT uq_location_name UNIQUE (locationName)');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SensorType'
           AND COLUMN_NAME = 'sensorType' AND IS_NULLABLE = 'NO'),
  'SELECT 1',
  'ALTER TABLE SensorType MODIFY sensorType VARCHAR(50) NOT NULL');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SensorType'
           AND INDEX_NAME = 'uq_sensortype_name'),
  'SELECT 1',
  'ALTER TABLE SensorType ADD CONSTRAINT uq_sensortype_name UNIQUE (sensorType)');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT INTO SchemaVersion (migrationID, description)
VALUES ('M007', 'Location.locationName and SensorType.sensorType UNIQUE - findOrCreate() upserts need a key to collide on')
ON DUPLICATE KEY UPDATE appliedAt = appliedAt;


-- ----------------------------------------------------------------------------
-- The v2 lineage - kept as history, deliberately NOT executed here
--
-- dashboard/migration_timesync.sql migrated the ORIGINAL v2 database
-- (`sensor_dashboard`). It is not folded into this file and must never be run
-- against a v3-family database, because v3 re-keyed the tables it touches:
--
--   DeviceStatus     v2+timesync: UNIQUE KEY on sensorID, plus lastSeen and
--                    isOnline columns.        v3.6: PRIMARY KEY deviceID,
--                    with connectionStatus instead.
--   DeviceEvent      v2+timesync: sensorID with an FK to Sensor.
--                    v3.6: deviceID with an FK to Device.
--   SamplingConfig   v2+timesync: effectiveFrom TIMESTAMP(6).
--                    v3.6: effectiveFrom BIGINT, a Unix epoch in ms, because
--                    every Pi derives its tick grid from that number.
--
-- Run it here and it would try to add a UNIQUE key on DeviceStatus(sensorID) -
-- a column v3.6 does not have - and stop with a confusing error partway
-- through. Guard 1 catches the reverse mistake, pointing this file at a v2
-- database.
--
-- The file stays in the repo as the record of how the live v2 database was
-- brought up to the timesync design. It is not part of any install path now.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- SECTION 4 - OPTIONAL PERFORMANCE WORK
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
-- SECTION 5 - REPORT
-- ============================================================================

SELECT 'Database_v3.6.sql complete' AS status,
       DATABASE() AS applied_to,
       VERSION()  AS mysql_version;

SELECT migrationID, description, appliedAt
FROM SchemaVersion
ORDER BY migrationID;

SELECT TABLE_NAME AS table_name, TABLE_ROWS AS approx_rows
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME;

-- Sanity check. The four M004 additions and the M006 column should report 1;
-- every M005 removal should report 0. Any other combination means this file
-- did not finish.
SELECT
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ActuatorLog'
      AND COLUMN_NAME = 'durationSeconds')          AS m004_actuatorlog_duration,
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ActuatorLog'
      AND INDEX_NAME = 'idx_actuatorlog_lookup')    AS m004_actuatorlog_index,
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ClimateRules'
      AND COLUMN_NAME = 'locationID')               AS m004_climaterules_location,
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ClimateRuleActuator'
      AND COLUMN_NAME = 'durationSeconds')          AS m004_ruleactuator_duration;

SELECT
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'
      AND COLUMN_NAME = 'deviceID')                 AS m005_actuator_deviceid_present,
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'
      AND COLUMN_NAME = 'deviceUUID')               AS m005_actuator_uuid_gone,
  (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ActuatorStatus')
                                                    AS m005_actuatorstatus_gone,
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'DeviceStatus'
      AND COLUMN_NAME IN ('batteryLevel','signalStrength'))
                                                    AS m005_dead_columns_gone,
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SamplingConfig'
      AND COLUMN_NAME = 'sendSeconds')              AS m006_sendseconds_present;

-- M007. Both keys should report 1, and both duplicate counts 0.
SELECT
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Location'
      AND INDEX_NAME = 'uq_location_name')          AS m007_location_key,
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SensorType'
      AND INDEX_NAME = 'uq_sensortype_name')        AS m007_sensortype_key,
  (SELECT COUNT(*) FROM (SELECT locationName FROM Location
                          GROUP BY locationName HAVING COUNT(*) > 1) d)
                                                    AS m007_location_dupes,
  (SELECT COUNT(*) FROM (SELECT sensorType FROM SensorType
                          GROUP BY sensorType HAVING COUNT(*) > 1) d)
                                                    AS m007_sensortype_dupes;

-- One row per Pi, with what is attached to it. After M005 every actuator has a
-- deviceID, so nothing here should show a NULL device.
SELECT d.deviceID, d.deviceUUID, d.hostname,
       (SELECT COUNT(*) FROM Sensor s   WHERE s.deviceID = d.deviceID) AS sensors,
       (SELECT COUNT(*) FROM Actuator a WHERE a.deviceID = d.deviceID) AS actuators,
       st.connectionStatus, st.lastHeartbeat
FROM Device d
LEFT JOIN DeviceStatus st ON st.deviceID = d.deviceID
ORDER BY d.deviceID;

-- Next: point the backend at this database in dashboard/backend/.env
--       (DB_NAME=...), grant the app user, restart the backend, then restart
--       every Pi - both clients cache their sensorID / actuatorID in memory.
