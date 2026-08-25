-- ============================================================================
-- Clear collected sensor data
--
--     mysql -u seniordashboard -p sensor_dashboard_v3af < database/clear_sensor_data.sql
--
-- AS WRITTEN, this deletes readings only (level 1). Sensors keep their IDs and
-- the Pis keep working. Levels 2 and 3 are commented out - running this file
-- blind does the least damage on purpose, and the wider resets have to be
-- uncommented deliberately.
--
-- BACK UP FIRST if the rows might matter:
--     mysqldump -u root -p sensor_dashboard_v3af SensorLog > sensorlog_backup.sql
--
-- STOP THE PIs BEFORE LEVEL 2 OR 3. BackendClient caches sensorID in memory
-- and only re-registers when it is None, so deleting the row under a running
-- Pi makes every upload fail with a foreign-key error until it is restarted.
-- It does not recover on its own. Level 1 is safe with the Pis running,
-- because sensorID still exists.
--
--     sudo systemctl stop sensor-dht22
--     ...run this...
--     sudo systemctl start sensor-dht22
--
-- Actuators are untouched by every level here - Actuator has no foreign key
-- to Device, so the mist maker and the fan keep their IDs and their history.
-- ============================================================================


SELECT '--- before ---' AS '';

SELECT 'SensorLog' AS table_, COUNT(*) AS rows_ FROM SensorLog
UNION ALL SELECT 'Sensor',        COUNT(*) FROM Sensor
UNION ALL SELECT 'Device',        COUNT(*) FROM Device
UNION ALL SELECT 'DeviceEvent',   COUNT(*) FROM DeviceEvent
UNION ALL SELECT 'DeviceSession', COUNT(*) FROM DeviceSession
UNION ALL SELECT 'DeviceStatus',  COUNT(*) FROM DeviceStatus
UNION ALL SELECT 'ErrorLog',      COUNT(*) FROM ErrorLog;


-- ----------------------------------------------------------------------------
-- LEVEL 1 - readings only  (active)
--
-- Sensors, devices and their registration history all survive. Charts go empty
-- and nothing has to be restarted.
--
-- DELETE rather than TRUNCATE because TRUNCATE needs the DROP privilege, which
-- the app user does not have. The trade-off is that logID keeps counting from
-- where it was; see the note at the bottom if you want it reset.
-- ----------------------------------------------------------------------------

DELETE FROM SensorLog;


-- ----------------------------------------------------------------------------
-- LEVEL 2 - readings and sensor registrations
--
-- Cascades to SensorLog and SensorOffset. Sensors re-register on next contact
-- and get NEW sensorIDs. ErrorLog.sensorID is SET NULL rather than cascaded,
-- so error rows survive as orphans - deliberate, an error is worth keeping
-- even once the sensor that raised it is gone.
--
-- Uncomment to use. Stop the Pis first.
-- ----------------------------------------------------------------------------

-- DELETE FROM Sensor;


-- ----------------------------------------------------------------------------
-- LEVEL 3 - full device reset
--
-- Cascades through Sensor to SensorLog, plus DeviceEvent, DeviceSession and
-- DeviceStatus. Each Pi re-registers from its existing device_uuid.txt and
-- starts a fresh identity with a new deviceID.
--
-- Location and SensorType are NOT touched. They are lookup tables, they are
-- reused on re-registration, and clearing them would only churn the IDs.
--
-- Uncomment to use. Stop the Pis first.
-- ----------------------------------------------------------------------------

-- DELETE FROM Device;


SELECT '--- after ---' AS '';

SELECT 'SensorLog' AS table_, COUNT(*) AS rows_ FROM SensorLog
UNION ALL SELECT 'Sensor',        COUNT(*) FROM Sensor
UNION ALL SELECT 'Device',        COUNT(*) FROM Device
UNION ALL SELECT 'DeviceEvent',   COUNT(*) FROM DeviceEvent
UNION ALL SELECT 'DeviceSession', COUNT(*) FROM DeviceSession
UNION ALL SELECT 'DeviceStatus',  COUNT(*) FROM DeviceStatus
UNION ALL SELECT 'ErrorLog',      COUNT(*) FROM ErrorLog;


-- ----------------------------------------------------------------------------
-- Resetting the auto-increment counters
--
-- Only worth doing on an empty table, and only as root - TRUNCATE and
-- ALTER ... AUTO_INCREMENT both need privileges the app user does not have.
-- Cosmetic: nothing in the schema or the code cares whether logID starts at 1.
--
--     TRUNCATE TABLE SensorLog;                  -- instead of the DELETE above
--     ALTER TABLE SensorLog AUTO_INCREMENT = 1;  -- after a DELETE
--
-- TRUNCATE works on SensorLog because no table has a foreign key pointing AT
-- it. It would fail on Sensor or Device for exactly that reason, so levels 2
-- and 3 have to stay DELETEs.
-- ----------------------------------------------------------------------------
