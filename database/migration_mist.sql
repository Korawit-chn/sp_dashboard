-- ============================================================================
-- Migration: mist maker control  (AI Assistant/plan.md §4)
--
-- Run this AFTER Database_v3af.sql, which creates the database and the
-- actuator tables this builds on:
--
--     mysql -u root -p < database/Database_v3af.sql
--     mysql -u root -p sensor_dashboard_v3af < database/migration_mist.sql
--
-- Needs ALTER and INDEX rights, so run it as root - the app user only has
-- SELECT/INSERT/UPDATE/DELETE. Remember to grant the app user access to the
-- new database afterwards, or the backend cannot connect to it.
--
-- Everything here is additive: no column is dropped, renamed or retyped.
-- Each step checks information_schema first, so running the script twice is
-- harmless. It uses only prepared statements - no stored routines - so it
-- works for a user with plain ALTER rights and no CREATE ROUTINE privilege.
--
-- SCHEMA ONLY - no INSERTs. Actuators, their types and their locations are
-- all created by POST /api/registerActuator when a device first reports in
-- (see the note at the bottom). A migration that seeds rows would be a second
-- source of truth for the same data, and would go stale the moment someone
-- adds an actuator the normal way.
--
-- Two halves:
--   1-2  what the mist maker needs to work now
--   3-4  climate-rule groundwork, DB only - nothing reads these yet
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. ActuatorLog.durationSeconds
--
-- A mist run has a length. There is nowhere to put one today. NOT overloaded
-- onto pwmDutyPercent: that is DECIMAL(5,2), so it caps at 999.99, and a duty
-- column holding a duration reads fine today and is unexplainable later.
-- ----------------------------------------------------------------------------

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ActuatorLog'
           AND COLUMN_NAME = 'durationSeconds'),
  'SELECT 1',
  'ALTER TABLE ActuatorLog ADD COLUMN durationSeconds INT NULL AFTER pwmDutyPercent');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ----------------------------------------------------------------------------
-- 2. ActuatorLog lookup index
--
-- The Pi's command poll (ORDER BY actionID DESC WHERE actuatorID = ?) and the
-- two correlated MAX() subqueries in /api/actuators all hit this. The foreign
-- key gives an index on actuatorID alone, which stops being enough once the
-- log has a year of rows in it.
-- ----------------------------------------------------------------------------

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ActuatorLog'
           AND INDEX_NAME = 'idx_actuatorlog_lookup'),
  'SELECT 1',
  'CREATE INDEX idx_actuatorlog_lookup ON ActuatorLog (actuatorID, actionID)');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ============================================================================
-- Climate rules - groundwork only
--
-- Nothing reads any of this yet. There is no evaluator in the backend and no
-- rule logic on the Pi. It is here so the next step is writing an evaluator
-- rather than migrating a schema half way through the feature.
--
-- The Pi needs no change when that evaluator lands: it obeys the latest
-- command regardless of triggerSource, so AUTOMATION rows written into
-- ActuatorLog are picked up by exactly the same poll that handles MANUAL.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 3. ClimateRules.locationID
--
-- A rule currently says "humidity < 60" but not WHERE. With two domes that is
-- not a rule, it is an ambiguity. NULL is allowed and means "any location",
-- which is the only sane reading of any rows that exist before this runs.
-- ----------------------------------------------------------------------------

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


-- ----------------------------------------------------------------------------
-- 4. ClimateRuleActuator.durationSeconds
--
-- A rule that turns the mister on has to say for how long, for the same reason
-- a manual run does: the Pi refuses to run without an end time.
-- ----------------------------------------------------------------------------

SET @s := IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ClimateRuleActuator'
           AND COLUMN_NAME = 'durationSeconds'),
  'SELECT 1',
  'ALTER TABLE ClimateRuleActuator ADD COLUMN durationSeconds INT NULL');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ============================================================================
-- Adding an actuator - there is nothing to do here
--
-- POST /api/registerActuator is find-or-create the whole way down, so a new
-- device brings its own rows into existence on first contact:
--
--   ActuatorType   looked up by typeName, inserted if absent
--   Location       looked up by locationName, inserted if absent
--   Actuator       upserted on deviceUUID (UNIQUE), so re-registering is a
--                  no-op rather than a duplicate
--
-- The Pi sends Type and Location from its own config.txt and calls this on
-- every maintenance cycle until it gets an actuatorID back. So adding a mist
-- maker is: write config.txt, start the service. No SQL.
--
-- The one thing that still needs a hand is linking a climate rule to an
-- actuator, because ClimateRuleActuator.actuatorID is NOT NULL with a foreign
-- key and cannot be written before the device exists. Once GET /api/actuators
-- shows it:
--
--   INSERT INTO ClimateRules (ruleName, locationID, parameter, thresholdValue,
--                             conditionType, isActive)
--   VALUES ('Dome 1 dry - mist on',
--           (SELECT locationID FROM Location WHERE locationName = 'Inside Dome 1'),
--           'humidity', 60.00, 'LESS', FALSE);
--
--   INSERT INTO ClimateRuleActuator (ruleID, actuatorID, action, durationSeconds)
--   VALUES (LAST_INSERT_ID(), <actuatorID>, 'ON', 60);
--
-- Leave isActive FALSE until an evaluator exists, and settle hysteresis before
-- writing one: a bare "humidity < 60" flaps around the threshold and hammers
-- the relay. It needs either a second threshold to switch off at or a minimum
-- interval between runs, and either is another column. (plan.md §12)
-- ============================================================================


SELECT 'migration_mist.sql complete' AS status;
