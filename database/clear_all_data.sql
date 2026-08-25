-- ============================================================================
-- Clear ALL data - every table emptied, schema untouched
--
--     mysql -u seniordashboard -p sensor_dashboard_v3af < database/clear_all_data.sql
--
-- This is the full reset. Tables, columns, indexes and foreign keys all
-- survive; every row goes. Use Database_v3af.sql only if you want the schema
-- rebuilt too - it starts with DROP DATABASE.
--
-- BACK UP FIRST if anything might matter:
--     mysqldump -u root -p sensor_dashboard_v3af > full_backup.sql
--
-- STOP THE PIs FIRST, for two reasons:
--   1. Both clients cache their sensorID / actuatorID in memory and only
--      re-register when it is None. Deleting the row underneath a running
--      client makes every write fail on a foreign key until it is restarted;
--      it does not recover on its own.
--   2. They re-register within one maintenance cycle, so a running Pi will
--      start refilling Device, Location and Sensor before you have finished
--      reading the output.
--
--     sudo systemctl stop sensor-dht22
--     sudo systemctl stop mist
--
-- DELETE rather than TRUNCATE: TRUNCATE needs the DROP privilege, which the
-- app user does not have, and it is refused outright on any table another
-- table points at - which here is most of them.
--
-- FOREIGN_KEY_CHECKS is disabled for the duration so the order below does not
-- have to be a correct topological sort of seventeen tables. It is restored at
-- the end, and it is session-scoped, so nothing outside this script is
-- affected even if it aborts halfway.
-- ============================================================================


SET FOREIGN_KEY_CHECKS = 0;

-- Actuators
DELETE FROM ClimateRuleActuator;
DELETE FROM ClimateRules;
DELETE FROM ActuatorLog;
DELETE FROM ActuatorStatus;
DELETE FROM Actuator;
DELETE FROM ActuatorType;

-- Sensors and their readings
DELETE FROM SensorLog;
DELETE FROM SensorOffset;
DELETE FROM ErrorLog;
DELETE FROM Sensor;
DELETE FROM SensorType;

-- Devices and their on/off history
DELETE FROM DeviceEvent;
DELETE FROM DeviceSession;
DELETE FROM DeviceStatus;
DELETE FROM Device;

-- Shared lookups and config
DELETE FROM Location;
DELETE FROM SamplingConfig;

SET FOREIGN_KEY_CHECKS = 1;


-- Auto-increment counters keep climbing after a DELETE, so the next actuator
-- registers as #4 rather than #1. Purely cosmetic - nothing in the schema or
-- the code cares where the numbering starts - but actuatorID is what you quote
-- in the dashboard dropdown and in every curl, so a fresh start reading #1 is
-- easier to live with.
--
-- Left commented because ALTER is a privilege the app user does not have; run
-- this block as root if you want it:
--
--   ALTER TABLE Actuator    AUTO_INCREMENT = 1;
--   ALTER TABLE Sensor      AUTO_INCREMENT = 1;
--   ALTER TABLE Device      AUTO_INCREMENT = 1;
--   ALTER TABLE Location    AUTO_INCREMENT = 1;
--   ALTER TABLE SensorLog   AUTO_INCREMENT = 1;
--   ALTER TABLE ActuatorLog AUTO_INCREMENT = 1;


SELECT '--- after ---' AS '';

SELECT 'Actuator' AS table_, COUNT(*) AS rows_ FROM Actuator
UNION ALL SELECT 'ActuatorType',        COUNT(*) FROM ActuatorType
UNION ALL SELECT 'ActuatorLog',         COUNT(*) FROM ActuatorLog
UNION ALL SELECT 'ActuatorStatus',      COUNT(*) FROM ActuatorStatus
UNION ALL SELECT 'ClimateRules',        COUNT(*) FROM ClimateRules
UNION ALL SELECT 'ClimateRuleActuator', COUNT(*) FROM ClimateRuleActuator
UNION ALL SELECT 'Sensor',              COUNT(*) FROM Sensor
UNION ALL SELECT 'SensorType',          COUNT(*) FROM SensorType
UNION ALL SELECT 'SensorLog',           COUNT(*) FROM SensorLog
UNION ALL SELECT 'SensorOffset',        COUNT(*) FROM SensorOffset
UNION ALL SELECT 'ErrorLog',            COUNT(*) FROM ErrorLog
UNION ALL SELECT 'Device',              COUNT(*) FROM Device
UNION ALL SELECT 'DeviceEvent',         COUNT(*) FROM DeviceEvent
UNION ALL SELECT 'DeviceSession',       COUNT(*) FROM DeviceSession
UNION ALL SELECT 'DeviceStatus',        COUNT(*) FROM DeviceStatus
UNION ALL SELECT 'Location',            COUNT(*) FROM Location
UNION ALL SELECT 'SamplingConfig',      COUNT(*) FROM SamplingConfig;


-- ----------------------------------------------------------------------------
-- What comes back on its own, and what does not
--
-- Registration is find-or-create on both clients, so most of this refills the
-- moment a Pi reconnects: Device, SensorType, Location, Sensor, ActuatorType,
-- Actuator. IDs will be different from before.
--
-- What does NOT come back:
--   SamplingConfig  - GET /api/schedule falls back to 5 s with nothing stored.
--                     Set the interval again from the dashboard if you had it
--                     on something else.
--   Actuator.locationID - registerActuator's upsert is
--                     ON DUPLICATE KEY UPDATE actuatorID = actuatorID, a no-op,
--                     so an actuator that already exists never has its location
--                     updated. After a full wipe the row is new, so this one is
--                     fine - it only bites when you clear Location alone.
--   ClimateRules    - nothing writes these yet; re-seed by hand if you had any.
-- ----------------------------------------------------------------------------
