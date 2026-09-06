-- ============================================================
-- sensor_system database
-- ============================================================

CREATE DATABASE IF NOT EXISTS sensor_system;
USE sensor_system;


-- ============================================================
-- LOCATION
-- ============================================================

CREATE TABLE Location (
    locationID   INT          AUTO_INCREMENT PRIMARY KEY,
    locationName VARCHAR(100) NOT NULL,
    latitude     DECIMAL(9,6),
    longitude    DECIMAL(9,6),
    description  VARCHAR(255),
    createdAt    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- SENSOR
-- ============================================================

CREATE TABLE Sensor (
    sensorID   INT                                              AUTO_INCREMENT PRIMARY KEY,
    sensorType ENUM('Weather','Temperature','Humidity','Wind') NOT NULL,
    locationID INT,
    createdAt  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (locationID)
        REFERENCES Location(locationID)
        ON DELETE SET NULL
);

CREATE INDEX idx_sensor_locationid ON Sensor(locationID);


-- ============================================================
-- SENSOR LOG
-- ============================================================

CREATE TABLE SensorLog (
    logID         BIGINT       AUTO_INCREMENT PRIMARY KEY,
    sensorID      INT          NOT NULL,
    recordedAt    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,   
    temperature   DECIMAL(5,2) CHECK (temperature  BETWEEN -50 AND 100),
    humidity      DECIMAL(5,2) CHECK (humidity     BETWEEN 0   AND 100),
    windspeed     DECIMAL(5,2) CHECK (windspeed    >= 0),
    windDirection INT          CHECK (windDirection BETWEEN 0   AND 360),
    VPD           DECIMAL(6,2),

    FOREIGN KEY (sensorID)
        REFERENCES Sensor(sensorID)
        ON DELETE CASCADE
);

CREATE INDEX idx_sensorlog_sensorid    ON SensorLog(sensorID);
CREATE INDEX idx_sensorlog_sensor_time ON SensorLog(sensorID, recordedAt DESC);


-- ============================================================
-- DEVICE STATUS
-- ============================================================

CREATE TABLE DeviceStatus (
    statusID       BIGINT       AUTO_INCREMENT PRIMARY KEY,
    sensorID       INT          NOT NULL,
    batteryLevel   DECIMAL(5,2) CHECK (batteryLevel BETWEEN 0 AND 100),
    signalStrength INT,
    lastHeartbeat  TIMESTAMP,
    recordedAt     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,       -- [IMPROVED] added

    FOREIGN KEY (sensorID)
        REFERENCES Sensor(sensorID)
        ON DELETE CASCADE
);

CREATE INDEX idx_devicestatus_sensorid ON DeviceStatus(sensorID);


-- ============================================================
-- ERROR LOG
-- ============================================================

CREATE TABLE ErrorLog (
    errorID      BIGINT       AUTO_INCREMENT PRIMARY KEY,
    sensorID     INT,
    errorType    VARCHAR(50),
    errorMessage TEXT,
    severity     ENUM('LOW','MEDIUM','HIGH','CRITICAL') DEFAULT 'LOW',
    createdAt    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (sensorID)
        REFERENCES Sensor(sensorID)
        ON DELETE SET NULL
);

CREATE INDEX idx_errorlog_sensorid ON ErrorLog(sensorID);


-- ============================================================
-- ACTUATOR
-- ============================================================

CREATE TABLE Actuator (
    actuatorID   INT                                                    AUTO_INCREMENT PRIMARY KEY,
    actuatorType ENUM('Ventilation Fan','Irrigation','Heater','Light') NOT NULL,
    locationID   INT,
    status       ENUM('ON','OFF','IDLE') DEFAULT 'IDLE',
    createdAt    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (locationID)
        REFERENCES Location(locationID)
        ON DELETE SET NULL
);

CREATE INDEX idx_actuator_locationid ON Actuator(locationID);


-- ============================================================
-- ACTUATOR LOG
-- ============================================================

CREATE TABLE ActuatorLog (
    actionID     BIGINT AUTO_INCREMENT PRIMARY KEY,
    actuatorID   INT,
    action       ENUM('ON','OFF'),
    triggerSource ENUM('MANUAL','AUTOMATION','SYSTEM'),
    recordedAt   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (actuatorID)
        REFERENCES Actuator(actuatorID)
        ON DELETE CASCADE
);

CREATE INDEX idx_actuatorlog_actuatorid ON ActuatorLog(actuatorID);


-- ============================================================
-- CLIMATE RULES
-- ============================================================

CREATE TABLE ClimateRules (
    ruleID         INT AUTO_INCREMENT PRIMARY KEY,
    sensorID       INT  NULL,                                   
    parameter      ENUM('temperature','humidity','windspeed','VPD') NOT NULL,
    thresholdValue DECIMAL(6,2),
    conditionType  ENUM('GREATER','LESS'),
    actuatorID     INT,
    action         ENUM('ON','OFF'),

    FOREIGN KEY (actuatorID)
        REFERENCES Actuator(actuatorID)
        ON DELETE CASCADE,

    FOREIGN KEY (sensorID)                                       
        REFERENCES Sensor(sensorID)
        ON DELETE SET NULL
);

CREATE INDEX idx_climaterules_sensorid ON ClimateRules(sensorID);


-- ============================================================
-- TEST / SEED DATA
-- [NOTE] Consider moving this section to a separate seed.sql
--        file to keep schema and test data cleanly separated.
-- ============================================================

-- Test: Location
INSERT INTO Location (locationName, latitude, longitude, description)
VALUES ('Greenhouse Zone A', 13.7563, 100.5018, 'Main greenhouse monitoring area');

SELECT * FROM Location;

-- Test: Sensor
INSERT INTO Sensor (sensorType, locationID)
VALUES ('Weather', 1);

SELECT * FROM Sensor;

-- Test: Sensor logs
INSERT INTO SensorLog (sensorID, temperature, humidity, windspeed, windDirection, VPD)
VALUES (1, 30.5, 75.2, 3.5, 120, 1.20);

INSERT INTO SensorLog (sensorID, temperature, humidity, windspeed, windDirection, VPD)
VALUES (1, 32.1, 72.8, 4.1, 110, 1.35);

SELECT * FROM SensorLog;

-- Test: Device status
INSERT INTO DeviceStatus (sensorID, batteryLevel, signalStrength, lastHeartbeat)
VALUES (1, 88.5, -60, NOW());

SELECT * FROM DeviceStatus;

-- Test: Error log
INSERT INTO ErrorLog (sensorID, errorType, errorMessage, severity)
VALUES (1, 'SENSOR_FAILURE', 'Wind sensor temporarily disconnected', 'HIGH');

SELECT * FROM ErrorLog;

-- Test: Actuator
INSERT INTO Actuator (actuatorType, locationID)
VALUES ('Ventilation Fan', 1);

SELECT * FROM Actuator;

-- Test: Climate rule
INSERT INTO ClimateRules (parameter, thresholdValue, conditionType, actuatorID, action)
VALUES ('temperature', 32, 'GREATER', 1, 'ON');

SELECT * FROM ClimateRules;

-- Test: Actuator activation
INSERT INTO ActuatorLog (actuatorID, action, triggerSource)
VALUES (1, 'ON', 'AUTOMATION');

SELECT * FROM ActuatorLog;


-- ============================================================
-- EXAMPLE QUERIES
-- ============================================================

-- Monitoring: latest readings with location context
SELECT
    l.locationName,
    s.sensorType,
    sl.temperature,
    sl.humidity,
    sl.windspeed,
    sl.recordedAt                            
FROM SensorLog sl
JOIN Sensor   s ON sl.sensorID   = s.sensorID
JOIN Location l ON s.locationID  = l.locationID
ORDER BY sl.recordedAt DESC;

-- Automation decision: latest reading per sensor only
SELECT
    sl.sensorID,
    sl.temperature,
    cr.thresholdValue,
    cr.action
FROM (
    SELECT * FROM SensorLog
    WHERE (sensorID, recordedAt) IN (
        SELECT sensorID, MAX(recordedAt)
        FROM SensorLog
        GROUP BY sensorID
    )
) sl
JOIN ClimateRules cr ON cr.parameter = 'temperature'
WHERE sl.temperature > cr.thresholdValue;