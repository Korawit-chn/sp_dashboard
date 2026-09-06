-- ============================================================================
-- M005 - one liveness concept per Pi
--
--     mysql -u root -p <your_database> < database/M005_device_liveness.sql
--
-- Needs ALTER/DROP, so run it as ROOT. The app user does not have them.
--
-- ----------------------------------------------------------------------------
-- THIS DROPS A TABLE AND THREE COLUMNS.
--
--     mysqldump -u root -p <your_database> > full_backup.sql
--
-- STOP THE PIs FIRST - the mist client writes to ActuatorStatus every 60 s.
--
--     sudo systemctl stop mist
--     sudo systemctl stop 'sensor@*'
--     ...run this...
-- ----------------------------------------------------------------------------
--
-- WHAT IT DOES AND WHY
--
-- Liveness now lives in ONE place: DeviceStatus, written by one device-agent
-- service that runs on every Pi and identifies itself by the device UUID.
-- ActuatorStatus was the second, per-actuator answer to the same question, and
-- it goes.
--
-- Nothing is lost. Measured on the live server: powerDraw and signalStrength
-- were 0 of 65 rows; pwmDutyPercent was written to ActuatorLog in the same
-- request that wrote it here; lastHeartbeat is what DeviceStatus now carries.
-- Actuator.status / statusUpdatedAt are NOT touched - actuator ON/OFF state
-- stays exactly where it has always been.
--
-- THE TRADE, stated plainly: a dead relay_control.py on a Pi whose agent is
-- still beating will read ONLINE. Restart=always in mist.service is the
-- mitigation. Per-actuator liveness was given up deliberately.
--
-- Actuator gains a real deviceID foreign key, replacing the bare deviceUUID
-- string. That is what lets the dashboard find an actuator's Pi - and dropping
-- deviceUUID removes its UNIQUE constraint, which was the thing limiting one
-- actuator per Pi. The fan and the mister can now share a box.
--
-- IDEMPOTENT. Every step is guarded on the current shape, so running this file
-- twice changes nothing the second time.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Step 0 - guards. A guard aborts by selecting from a table that does not
-- exist; the error message names it, and the name is the explanation.
-- ----------------------------------------------------------------------------
SET @s := IF(
  NOT EXISTS(SELECT 1 FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'),
  'SELECT * FROM `STOP_no_Actuator_table_run_Database_v3_5_sql_first`',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- An actuator whose Pi has no Device row cannot be linked, and after
-- deviceUUID is dropped there is nothing left to link it FROM. Stop before
-- writing anything and let the Pi register first: start the mist client, wait
-- one maintenance cycle, re-run this file.
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'
           AND COLUMN_NAME = 'deviceUUID')
  AND EXISTS(SELECT 1 FROM Actuator a
             LEFT JOIN Device d ON d.deviceUUID = a.deviceUUID
             WHERE d.deviceID IS NULL),
  'SELECT * FROM `STOP_an_Actuator_has_no_matching_Device_start_the_Pi_and_let_it_register_first`',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ----------------------------------------------------------------------------
-- Step 1 - Actuator.deviceID
-- ----------------------------------------------------------------------------
SET @s := IF(
  NOT EXISTS(SELECT 1 FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'
               AND COLUMN_NAME = 'deviceID'),
  'ALTER TABLE Actuator ADD COLUMN deviceID INT NULL AFTER actuatorID',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ----------------------------------------------------------------------------
-- Step 2 - backfill from the UUID already on the row.
--
-- Step 0 has already proved every actuator matches a Device, so this cannot
-- leave a NULL behind.
-- ----------------------------------------------------------------------------
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


-- ----------------------------------------------------------------------------
-- Step 3 - what identifies an actuator, mirroring uq_sensor_identity.
--
-- Includes deviceID, so an Actuator row's device never changes: a different
-- device is a different row. This replaces "deviceUUID is UNIQUE" and is what
-- registerActuator upserts on.
-- ----------------------------------------------------------------------------
SET @s := IF(
  NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'
               AND CONSTRAINT_NAME = 'uq_actuator_identity'),
  'ALTER TABLE Actuator
     ADD CONSTRAINT uq_actuator_identity UNIQUE (deviceID, typeID, locationID)',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s := IF(
  NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'
               AND CONSTRAINT_NAME = 'fk_actuator_device'),
  'ALTER TABLE Actuator
     ADD CONSTRAINT fk_actuator_device
     FOREIGN KEY (deviceID) REFERENCES Device(deviceID) ON DELETE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ----------------------------------------------------------------------------
-- Step 4 - drop deviceUUID.
--
-- Its UNIQUE constraint is what limited a Pi to exactly one actuator. The Pi
-- still SENDS a deviceUUID to /api/registerActuator - it is the lookup key for
-- the Device - it is simply no longer stored a second time on this row.
-- ----------------------------------------------------------------------------
SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Actuator'
           AND COLUMN_NAME = 'deviceUUID'),
  'ALTER TABLE Actuator DROP COLUMN deviceUUID',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ----------------------------------------------------------------------------
-- Step 5 - ActuatorStatus goes.
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS ActuatorStatus;


-- ----------------------------------------------------------------------------
-- Step 6 - DeviceStatus loses its two columns that nothing ever wrote.
--
-- batteryLevel: inapplicable. These are mains-powered Pis and there will be no
-- battery. It is the standard pair from a battery-powered wireless-mote schema
-- that this is not.
--
-- signalStrength: applicable and cheap, but deliberately out of scope - the
-- device agent is now the natural writer for it (one radio per Pi, so RSSI is a
-- device property), and adding it back is a one-line ALTER plus ~10 lines in
-- the agent reading /proc/net/wireless. What is not acceptable is keeping a
-- column with no writer: an always-NULL column is a promise the schema cannot
-- keep, and it misleads whoever inherits this.
--
-- Both were 0 of 2 rows, and GET /api/devices lists its columns explicitly, so
-- neither was ever even selected.
-- ----------------------------------------------------------------------------
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


-- ----------------------------------------------------------------------------
-- Step 7 - record it.
-- ----------------------------------------------------------------------------
INSERT INTO SchemaVersion (migrationID, description)
VALUES ('M005', 'Device-only liveness: ActuatorStatus dropped, Actuator.deviceID FK, dead DeviceStatus columns removed')
ON DUPLICATE KEY UPDATE migrationID = migrationID;


-- ----------------------------------------------------------------------------
-- Report
-- ----------------------------------------------------------------------------
SELECT '--- Actuator after M005 ---' AS '';
SELECT actuatorID, deviceID, typeID, locationID, actuatorName, status, statusUpdatedAt
FROM Actuator ORDER BY actuatorID;

SELECT '--- one Device row per Pi ---' AS '';
SELECT d.deviceID, d.deviceUUID, d.hostname,
       (SELECT COUNT(*) FROM Sensor s WHERE s.deviceID = d.deviceID)   AS sensors,
       (SELECT COUNT(*) FROM Actuator a WHERE a.deviceID = d.deviceID) AS actuators,
       st.connectionStatus, st.lastHeartbeat
FROM Device d
LEFT JOIN DeviceStatus st ON st.deviceID = d.deviceID
ORDER BY d.deviceID;

SELECT '--- migrations applied ---' AS '';
SELECT migrationID, description, appliedAt FROM SchemaVersion ORDER BY migrationID;
