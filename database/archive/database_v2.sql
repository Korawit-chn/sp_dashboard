drop database if exists sensor_dashboard;
CREATE DATABASE sensor_dashboard;
USE sensor_dashboard;

-- Location table
CREATE TABLE Location (
    locationID INT AUTO_INCREMENT PRIMARY KEY,
    locationName VARCHAR(100) NOT NULL,
    latitude DECIMAL(9,6),
    longitude DECIMAL(9,6),
    description VARCHAR(255),
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sensor List table
CREATE TABLE SensorType(
	typeID INT AUTO_INCREMENT PRIMARY KEY,
    sensorType VARCHAR(50)
);

-- Sensor table
CREATE TABLE Sensor (
    sensorID INT AUTO_INCREMENT PRIMARY KEY,

    typeID INT NOT NULL,
    locationID INT NOT NULL,

    deviceUUID CHAR(36) NOT NULL,

    sensorDescription TEXT NULL,

    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_sensor_type
        FOREIGN KEY (typeID)
        REFERENCES SensorType(typeID),

    CONSTRAINT fk_sensor_location
        FOREIGN KEY (locationID)
        REFERENCES Location(locationID),

    CONSTRAINT uq_sensor_identity
        UNIQUE (
            deviceUUID,
            typeID,
            locationID
        )
);

-- Sensor log table
CREATE TABLE SensorLog (
    logID BIGINT AUTO_INCREMENT PRIMARY KEY,
    sensorID INT NOT NULL,
    datetime TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    temperature DECIMAL(5,2),
    humidity DECIMAL(5,2),
    windspeed DECIMAL(5,2),
    windDirection INT,
    VPD DECIMAL(6,2),

    -- Time sync / latency instrumentation (see timeSyncPlan.md §5, §7).
    -- Appended at the end of the table on purpose: on the live database the
    -- same columns are added with ALGORITHM=INSTANT, which only works for
    -- columns added at the end.
    timeConfidence ENUM('SYNCED','CORRECTED','ESTIMATED','UNKNOWN')
        NOT NULL DEFAULT 'UNKNOWN',
    readLatencyMs INT NULL,
    tickJitterMs INT NULL,
    queueDelayMs INT NULL,
    recordedAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    FOREIGN KEY (sensorID)
        REFERENCES Sensor(sensorID)
        ON DELETE CASCADE
);

-- Dashboard reads default to the last 6 hours of one sensor; without this the
-- query scans the whole (multi-million row) table.
CREATE INDEX idx_sensorlog_sensor_time ON SensorLog (sensorID, datetime);

-- Device status table - one row per sensor, upserted by the heartbeat
CREATE TABLE DeviceStatus (
    statusID BIGINT AUTO_INCREMENT PRIMARY KEY,
    sensorID INT NOT NULL,
    batteryLevel DECIMAL(5,2),
    signalStrength INT,
    lastHeartbeat TIMESTAMP NULL,

    lastSeen TIMESTAMP(6) NULL,
    bootID CHAR(36) NULL,
    bootAt TIMESTAMP(6) NULL,
    isOnline BOOLEAN NOT NULL DEFAULT FALSE,

    UNIQUE KEY uq_devicestatus_sensor (sensorID),

    FOREIGN KEY (sensorID)
        REFERENCES Sensor(sensorID)
        ON DELETE CASCADE
);

-- Device power/connectivity event log.
-- occurredAt = when it actually happened, detectedAt = when the server noticed.
-- For OFFLINE these genuinely differ by the watchdog timeout.
CREATE TABLE DeviceEvent (
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

-- Sampling schedule pushed from the PC. Append-only: every interval change
-- inserts a row, so data spanning a change can be interpreted correctly.
CREATE TABLE SamplingConfig (
    configID      INT AUTO_INCREMENT PRIMARY KEY,
    periodSeconds INT NOT NULL,
    effectiveFrom TIMESTAMP(6) NOT NULL,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    createdAt     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX idx_samplingconfig_effective (effectiveFrom)
);

INSERT INTO SamplingConfig (periodSeconds, effectiveFrom, active)
VALUES (5, CURRENT_TIMESTAMP(6), TRUE);

-- Error log table
CREATE TABLE ErrorLog (
    errorID BIGINT AUTO_INCREMENT PRIMARY KEY,
    sensorID INT,
    errorType VARCHAR(50),
    errorMessage TEXT,
    severity ENUM('LOW','MEDIUM','HIGH','CRITICAL') DEFAULT 'LOW',
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (sensorID)
        REFERENCES Sensor(sensorID)
        ON DELETE SET NULL
);

-- Actuator table
CREATE TABLE Actuator (
    actuatorID INT AUTO_INCREMENT PRIMARY KEY,
    actuatorType VARCHAR(50),
    locationID INT,
    status ENUM('ON','OFF','IDLE') DEFAULT 'IDLE',
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (locationID)
        REFERENCES Location(locationID)
        ON DELETE SET NULL
);

-- Actuator log table
CREATE TABLE ActuatorLog (
    actionID BIGINT AUTO_INCREMENT PRIMARY KEY,
    actuatorID INT,
    action ENUM('ON','OFF'),
    triggerSource ENUM('MANUAL','AUTOMATION','SYSTEM'),
    recordedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (actuatorID)
        REFERENCES Actuator(actuatorID)
        ON DELETE CASCADE
);

-- Climate rules table
CREATE TABLE ClimateRules (
    ruleID INT AUTO_INCREMENT PRIMARY KEY,
    parameter VARCHAR(50),
    thresholdValue DECIMAL(6,2),
    conditionType ENUM('GREATER','LESS'),
    actuatorID INT,
    action ENUM('ON','OFF'),

    FOREIGN KEY (actuatorID)
        REFERENCES Actuator(actuatorID)
        ON DELETE CASCADE
);
