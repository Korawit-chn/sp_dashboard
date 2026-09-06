-- ============================================================================
-- Migration: synchronised time & simultaneous sampling  (timeSyncPlan.md §7)
--
-- Run this against the EXISTING live database. Do NOT run database.sql -
-- that starts with DROP DATABASE and destroys all collected data.
--
--     mysql -u root -p sensor_dashboard < migration_timesync.sql
--
-- Everything here is additive: no column is dropped, renamed or retyped.
-- Each step checks information_schema first, so running the script twice is
-- harmless. It uses only prepared statements - no stored routines - so it
-- works for a user with plain ALTER rights and no CREATE ROUTINE privilege.
--
-- The new SensorLog columns are appended at the END of the table so MySQL
-- 8.0.12+ can use ALGORITHM=INSTANT and finish in milliseconds instead of
-- rebuilding ~8.4M rows. ALGORITHM=INSTANT fails closed: if the server does
-- not support it the statement errors and changes nothing.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. SensorLog - instrumentation columns (appended, INSTANT)
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


-- ----------------------------------------------------------------------------
-- 2. DeviceStatus - repurposed as "current state", one row per sensor.
--    The table exists but no code path has ever written to it, so it is empty
--    and safe to alter (including adding the UNIQUE key).
-- ----------------------------------------------------------------------------

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'DeviceStatus'
           AND COLUMN_NAME = 'lastSeen'),
  'SELECT 1',
  'ALTER TABLE DeviceStatus ADD COLUMN lastSeen TIMESTAMP(6) NULL');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

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
           AND COLUMN_NAME = 'isOnline'),
  'SELECT 1',
  'ALTER TABLE DeviceStatus ADD COLUMN isOnline BOOLEAN NOT NULL DEFAULT FALSE');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The heartbeat upserts on this key, so it is required, not an optimisation.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'DeviceStatus'
           AND INDEX_NAME = 'uq_devicestatus_sensor'),
  'SELECT 1',
  'ALTER TABLE DeviceStatus ADD UNIQUE KEY uq_devicestatus_sensor (sensorID)');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- lastHeartbeat was NOT NULL-by-default TIMESTAMP; allow NULL so a row can
-- exist before the first heartbeat lands.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'DeviceStatus'
           AND COLUMN_NAME = 'lastHeartbeat' AND IS_NULLABLE = 'YES'),
  'SELECT 1',
  'ALTER TABLE DeviceStatus MODIFY COLUMN lastHeartbeat TIMESTAMP NULL');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ----------------------------------------------------------------------------
-- 3. DeviceEvent - the on/off log.
--    occurredAt and detectedAt are separate because for OFFLINE they genuinely
--    differ: the server can only notice after the watchdog timeout expires.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS DeviceEvent (
    eventID    BIGINT AUTO_INCREMENT PRIMARY KEY,
    sensorID   INT NULL,                       -- NULL for SERVER_START
    eventType  ENUM('BOOT','ONLINE','OFFLINE','SHUTDOWN','SERVER_START') NOT NULL,
    occurredAt TIMESTAMP(6) NOT NULL,
    detectedAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    bootID     CHAR(36) NULL,
    source     ENUM('HEARTBEAT','BOOT_REPORT','WATCHDOG','BACKLOG_GAP','SHUTDOWN_HOOK') NOT NULL,
    detail     VARCHAR(255) NULL,

    FOREIGN KEY (sensorID)
        REFERENCES Sensor(sensorID)
        ON DELETE CASCADE,

    INDEX idx_deviceevent_sensor_time (sensorID, occurredAt)
);


-- ----------------------------------------------------------------------------
-- 4. SamplingConfig - PC-controlled sampling interval.
--    Append-only: each change inserts a row, preserving the history of the
--    sampling rate for analysing data that spans a config change.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS SamplingConfig (
    configID      INT AUTO_INCREMENT PRIMARY KEY,
    periodSeconds INT NOT NULL,
    effectiveFrom TIMESTAMP(6) NOT NULL,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    createdAt     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX idx_samplingconfig_effective (effectiveFrom)
);

-- Seed a starting period only if the table is empty.
INSERT INTO SamplingConfig (periodSeconds, effectiveFrom, active)
SELECT 5, CURRENT_TIMESTAMP(6), TRUE
WHERE NOT EXISTS (SELECT 1 FROM SamplingConfig);


SELECT 'timesync migration complete' AS status, VERSION() AS mysql_version;


-- ============================================================================
-- OPTIONAL - run separately, see timeSyncPlan.md §7a
--
-- On the spinning-disk server /api/logs scans ~8.4M rows on every dashboard
-- refresh (7-10 s). This index takes it to 50-200 ms, and also keeps Node's
-- event loop from stalling /api/time - which would show up as clock error on
-- the sensors. Build cost is a one-off 5-15 minutes and it can be run at any
-- time: the Pis cache locally, so nothing is lost while the table is busy.
--
--   ALTER TABLE SensorLog ADD INDEX idx_sensorlog_sensor_time (sensorID, datetime);
--
-- Largest win of all, and no schema change - in my.ini on the server:
--
--   [mysqld]
--   innodb_buffer_pool_size = 2G
--
-- (the default is 128 MB while SensorLog is near 1 GB, so the working set is
-- re-read from disk constantly). Roughly 25-50% of that machine's RAM.
--
-- Facts to check on the server (timeSyncPlan.md §12):
--
--   SELECT VERSION();                     -- need 8.0.12+ for INSTANT
--   SELECT @@innodb_buffer_pool_size;     -- 134217728 means still the default
--   SELECT TABLE_NAME,
--          ROUND((DATA_LENGTH + INDEX_LENGTH)/1024/1024) AS mb,
--          TABLE_ROWS
--   FROM information_schema.TABLES
--   WHERE TABLE_SCHEMA = 'sensor_dashboard';
--
-- If ALGORITHM=INSTANT was rejected (MySQL < 8.0.12), remove the
-- ', ALGORITHM=INSTANT' clauses above and expect a full table rebuild.
-- ============================================================================
