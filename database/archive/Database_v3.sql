-- sensor_dashboard v3
-- Schema only. See databaseChanges.md for what changed, why, and how to deploy.

DROP DATABASE IF EXISTS sensor_dashboard_v3;
CREATE DATABASE sensor_dashboard_v3;
USE sensor_dashboard_v3;

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

-- Device table
CREATE TABLE Device (
    deviceID INT AUTO_INCREMENT PRIMARY KEY,

    deviceUUID CHAR(36) NOT NULL UNIQUE,

    hostname VARCHAR(100) NULL,
    description VARCHAR(255) NULL,

    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sensor table
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

    CONSTRAINT uq_sensor_identity
        UNIQUE (
            deviceID,
            typeID,
            locationID
        )
);

-- Sensor log table
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

    CONSTRAINT uq_sensorlog_reading
        UNIQUE (sensorID, datetime),

    INDEX idx_sensorlog_datetime (datetime)
);

-- Device status table
CREATE TABLE DeviceStatus (
    deviceID INT PRIMARY KEY,

    batteryLevel DECIMAL(5,2),
    signalStrength INT,

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

-- Device event table
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

-- Device session table
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

-- Sampling config table
CREATE TABLE SamplingConfig (
    configID INT AUTO_INCREMENT PRIMARY KEY,

    periodSeconds INT NOT NULL DEFAULT 5,
    effectiveFrom BIGINT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,

    note VARCHAR(255) NULL,

    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO SamplingConfig (periodSeconds, effectiveFrom, active, note)
VALUES (5, 0, TRUE, 'initial default');

-- Error log table
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
