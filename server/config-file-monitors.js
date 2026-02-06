/**
 * Config File Monitors
 * 
 * This module allows monitors to be defined via a YAML configuration file
 * instead of (or in addition to) the UI.
 * 
 * The config file should be placed at: data/monitors.yaml
 * 
 * Example config file format:
 * ```yaml
 * monitors:
 *   - name: "Google"
 *     type: "http"
 *     url: "https://google.com"
 *     interval: 60
 *     retryInterval: 60
 *     maxretries: 3
 *     
 *   - name: "Example Ping"
 *     type: "ping"
 *     hostname: "example.com"
 *     interval: 60
 *     
 *   - name: "My TCP Service"
 *     type: "port"
 *     hostname: "localhost"
 *     port: 8080
 *     interval: 60
 * ```
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { R } = require("redbean-node");
const { log } = require("../src/util");
const Database = require("./database");

/**
 * Default values for monitor fields
 */
const MONITOR_DEFAULTS = {
    active: true,
    interval: 60,
    retryInterval: 60,
    maxretries: 0,
    timeout: 48,
    resendInterval: 0,
    upsideDown: false,
    ignoreTls: false,
    maxredirects: 10,
    accepted_statuscodes: ["200-299"],
    method: "GET",
    httpBodyEncoding: "json",
    kafkaProducerBrokers: "[]",
    kafkaProducerSaslOptions: "{}",
    rabbitmqNodes: "[]",
    conditions: "[]",
};

/**
 * Mapping of monitor type to required fields
 */
const REQUIRED_FIELDS_BY_TYPE = {
    http: ["url"],
    keyword: ["url", "keyword"],
    "json-query": ["url", "jsonPath", "expectedValue"],
    ping: ["hostname"],
    port: ["hostname", "port"],
    dns: ["hostname", "dns_resolve_server"],
    push: [],
    steam: ["hostname", "port"],
    gamedig: ["hostname", "port", "game"],
    mqtt: ["hostname", "port", "mqttTopic"],
    sqlserver: ["databaseConnectionString"],
    postgres: ["databaseConnectionString"],
    mysql: ["databaseConnectionString"],
    mongodb: ["databaseConnectionString"],
    radius: ["hostname", "radiusUsername", "radiusPassword", "radiusSecret"],
    redis: ["databaseConnectionString"],
    group: [],
    docker: ["docker_container", "docker_host"],
    grpc: ["grpcUrl", "grpcServiceName", "grpcMethod"],
    "real-browser": ["url"],
    snmp: ["hostname", "snmpOid"],
    smtp: ["hostname", "port"],
    rabbitmq: ["rabbitmqNodes"],
};

/**
 * Config file path
 * @type {string}
 */
let configFilePath = null;

/**
 * File watcher instance
 * @type {fs.FSWatcher | null}
 */
let fileWatcher = null;

/**
 * Debounce timer for file changes
 * @type {NodeJS.Timeout | null}
 */
let debounceTimer = null;

/**
 * Get the config file path
 * @returns {string} Path to the monitors config file
 */
function getConfigFilePath() {
    if (!configFilePath) {
        // Only use the config file if explicitly pointed to by environment variable
        if (process.env.uptime_kuma_revanced_MONITORS_YAML_PATH) {
            configFilePath = process.env.uptime_kuma_revanced_MONITORS_YAML_PATH;
        } else {
            // Return null to indicate no config file should be used
            return null;
        }
    }
    return configFilePath;
}

/**
 * Check if the config file exists
 * @returns {boolean} True if config file exists
 */
function configFileExists() {
    const filePath = getConfigFilePath();
    return filePath && fs.existsSync(filePath);
}

/**
 * Read and parse the config file
 * @returns {object|null} Parsed config or null if file doesn't exist
 */
function readConfigFile() {
    const filePath = getConfigFilePath();
    
    if (!filePath || !fs.existsSync(filePath)) {
        if (filePath) {
            log.debug("config-file", "Config file not found at: " + filePath);
        }
        return null;
    }
    
    try {
        const fileContents = fs.readFileSync(filePath, "utf8");
        const config = yaml.load(fileContents);
        
        if (!config || !config.monitors) {
            log.warn("config-file", "Config file found but no 'monitors' section defined");
            return { monitors: [] };
        }
        
        return config;
    } catch (e) {
        log.error("config-file", "Error parsing config file: " + e.message);
        return null;
    }
}

/**
 * Validate a monitor configuration
 * @param {object} monitorConfig Monitor configuration object
 * @param {number} index Index in the array (for error messages)
 * @returns {object} Validation result with 'valid' and 'errors' properties
 */
function validateMonitorConfig(monitorConfig, index) {
    const errors = [];
    
    // Name is always required
    if (!monitorConfig.name) {
        errors.push(`Monitor at index ${index}: 'name' is required`);
    }
    
    // Type is always required
    if (!monitorConfig.type) {
        errors.push(`Monitor at index ${index}: 'type' is required`);
    } else {
        // Check required fields for the monitor type
        const requiredFields = REQUIRED_FIELDS_BY_TYPE[monitorConfig.type];
        if (!requiredFields) {
            errors.push(`Monitor "${monitorConfig.name}": Unknown monitor type "${monitorConfig.type}"`);
        } else {
            for (const field of requiredFields) {
                if (monitorConfig[field] === undefined || monitorConfig[field] === null || monitorConfig[field] === "") {
                    errors.push(`Monitor "${monitorConfig.name}": Field "${field}" is required for type "${monitorConfig.type}"`);
                }
            }
        }
    }
    
    // Validate interval bounds
    if (monitorConfig.interval !== undefined) {
        if (monitorConfig.interval < 20) {
            errors.push(`Monitor "${monitorConfig.name}": interval must be at least 20 seconds`);
        }
        if (monitorConfig.interval > 86400) {
            errors.push(`Monitor "${monitorConfig.name}": interval must be at most 86400 seconds (24 hours)`);
        }
    }
    
    // Validate retry interval bounds
    if (monitorConfig.retryInterval !== undefined) {
        if (monitorConfig.retryInterval < 20) {
            errors.push(`Monitor "${monitorConfig.name}": retryInterval must be at least 20 seconds`);
        }
        if (monitorConfig.retryInterval > 86400) {
            errors.push(`Monitor "${monitorConfig.name}": retryInterval must be at most 86400 seconds (24 hours)`);
        }
    }
    
    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Convert config monitor object to database monitor bean format
 * @param {object} config Monitor config from YAML
 * @param {number} userId User ID to assign the monitor to
 * @returns {object} Monitor data ready for database
 */
function configToMonitorBean(config, userId) {
    // Apply defaults
    const monitor = {
        ...MONITOR_DEFAULTS,
        ...config
    };
    
    // Convert accepted_statuscodes to JSON if it's an array
    if (Array.isArray(monitor.accepted_statuscodes)) {
        monitor.accepted_statuscodes_json = JSON.stringify(monitor.accepted_statuscodes);
    } else if (typeof monitor.accepted_statuscodes === "string") {
        monitor.accepted_statuscodes_json = monitor.accepted_statuscodes;
    }
    delete monitor.accepted_statuscodes;
    
    // Handle JSON fields
    const jsonFields = ["kafkaProducerBrokers", "kafkaProducerSaslOptions", "rabbitmqNodes", "conditions"];
    for (const field of jsonFields) {
        if (monitor[field] !== undefined) {
            if (typeof monitor[field] !== "string") {
                monitor[field] = JSON.stringify(monitor[field]);
            }
        }
    }
    
    // Set user_id
    monitor.user_id = userId;
    
    // Mark as config-managed
    monitor.config_managed = true;
    
    return monitor;
}

/**
 * Find or create a monitor from config
 * @param {object} monitorConfig Monitor configuration
 * @param {number} userId User ID
 * @returns {Promise<object>} The monitor bean
 */
async function findOrCreateMonitor(monitorConfig, userId) {
    // Try to find existing config-managed monitor with the same name
    let bean = await R.findOne("monitor", " name = ? AND user_id = ? AND config_managed = 1 ", [
        monitorConfig.name,
        userId
    ]);
    
    if (!bean) {
        bean = R.dispense("monitor");
    }
    
    return bean;
}

/**
 * Sync monitors from config file to database
 * @param {number} userId User ID to use for the monitors
 * @param {object} server UptimeKumaServer instance
 * @returns {Promise<{added: number, updated: number, removed: number, errors: string[]}>} Sync result
 */
async function syncConfigMonitors(userId, server) {
    const result = {
        added: 0,
        updated: 0,
        removed: 0,
        errors: []
    };
    
    const config = readConfigFile();
    
    if (!config) {
        log.info("config-file", "No config file found or config file is invalid, skipping sync");
        return result;
    }
    
    const monitors = config.monitors || [];
    log.info("config-file", `Found ${monitors.length} monitors in config file`);
    
    // Validate all monitors first
    for (let i = 0; i < monitors.length; i++) {
        const validation = validateMonitorConfig(monitors[i], i);
        if (!validation.valid) {
            result.errors.push(...validation.errors);
        }
    }
    
    if (result.errors.length > 0) {
        log.error("config-file", "Config validation errors:");
        for (const error of result.errors) {
            log.error("config-file", "  - " + error);
        }
        return result;
    }
    
    // Get all existing config-managed monitors
    const existingMonitors = await R.find("monitor", " user_id = ? AND config_managed = 1 ", [userId]);
    const configMonitorNames = new Set(monitors.map(m => m.name));
    
    // Process each monitor from config
    for (const monitorConfig of monitors) {
        try {
            const bean = await findOrCreateMonitor(monitorConfig, userId);
            const isNew = !bean.id;
            
            const monitorData = configToMonitorBean(monitorConfig, userId);
            
            // Import data to bean
            for (const key in monitorData) {
                if (key !== "id") {
                    bean[key] = monitorData[key];
                }
            }
            
            // Validate the monitor
            bean.validate();
            
            // Store the monitor
            await R.store(bean);
            
            if (isNew) {
                result.added++;
                log.info("config-file", `Added monitor: ${bean.name}`);
            } else {
                result.updated++;
                log.info("config-file", `Updated monitor: ${bean.name}`);
            }
            
            // Start the monitor if active
            if (bean.active && server) {
                if (bean.id in server.monitorList) {
                    await server.monitorList[bean.id].stop();
                }
                server.monitorList[bean.id] = bean;
                await bean.start(server.io);
            }
            
        } catch (e) {
            const errorMsg = `Error processing monitor "${monitorConfig.name}": ${e.message}`;
            result.errors.push(errorMsg);
            log.error("config-file", errorMsg);
        }
    }
    
    // Remove monitors that are no longer in config
    for (const existingMonitor of existingMonitors) {
        if (!configMonitorNames.has(existingMonitor.name)) {
            try {
                // Stop the monitor if running
                if (existingMonitor.id in server.monitorList) {
                    await server.monitorList[existingMonitor.id].stop();
                    delete server.monitorList[existingMonitor.id];
                }
                
                // Delete from database
                await R.trash(existingMonitor);
                result.removed++;
                log.info("config-file", `Removed monitor: ${existingMonitor.name}`);
            } catch (e) {
                const errorMsg = `Error removing monitor "${existingMonitor.name}": ${e.message}`;
                result.errors.push(errorMsg);
                log.error("config-file", errorMsg);
            }
        }
    }
    
    log.info("config-file", `Sync complete: Added ${result.added}, Updated ${result.updated}, Removed ${result.removed}`);
    if (result.errors.length > 0) {
        log.warn("config-file", `Sync completed with ${result.errors.length} errors`);
    }
    
    return result;
}

/**
 * Start watching the config file for changes
 * @param {number} userId User ID
 * @param {object} server UptimeKumaServer instance
 * @returns {void}
 */
function startFileWatcher(userId, server) {
    const filePath = getConfigFilePath();
    
    if (!filePath) {
        return;
    }
    
    if (fileWatcher) {
        fileWatcher.close();
        fileWatcher = null;
    }
    
    // Only watch if the file exists
    if (!fs.existsSync(filePath)) {
        log.info("config-file", "Config file not found, file watcher not started");
        
        // Watch the directory for file creation
        const dirPath = path.dirname(filePath);
        try {
            fs.watch(dirPath, (eventType, filename) => {
                if (filename === "monitors.yaml" && eventType === "rename") {
                    if (fs.existsSync(filePath)) {
                        log.info("config-file", "Config file created, starting sync and file watcher");
                        syncConfigMonitors(userId, server).then(() => {
                            startFileWatcher(userId, server);
                        });
                    }
                }
            });
        } catch (e) {
            log.warn("config-file", "Could not watch data directory: " + e.message);
        }
        return;
    }
    
    log.info("config-file", "Starting file watcher for: " + filePath);
    
    try {
        fileWatcher = fs.watch(filePath, (eventType, filename) => {
            // Debounce to avoid multiple rapid syncs
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            
            debounceTimer = setTimeout(async () => {
                log.info("config-file", `Config file changed (${eventType}), re-syncing monitors...`);
                
                // Check if file still exists (might have been deleted)
                if (!fs.existsSync(filePath)) {
                    log.warn("config-file", "Config file was deleted, removing all config-managed monitors");
                    // Remove all config-managed monitors
                    const existingMonitors = await R.find("monitor", " user_id = ? AND config_managed = 1 ", [userId]);
                    for (const monitor of existingMonitors) {
                        try {
                            if (monitor.id in server.monitorList) {
                                await server.monitorList[monitor.id].stop();
                                delete server.monitorList[monitor.id];
                            }
                            await R.trash(monitor);
                            log.info("config-file", `Removed monitor: ${monitor.name}`);
                        } catch (e) {
                            log.error("config-file", `Error removing monitor: ${e.message}`);
                        }
                    }
                    
                    // Restart directory watching
                    fileWatcher.close();
                    fileWatcher = null;
                    startFileWatcher(userId, server);
                    return;
                }
                
                await syncConfigMonitors(userId, server);
            }, 1000); // 1 second debounce
        });
        
        fileWatcher.on("error", (error) => {
            log.error("config-file", "File watcher error: " + error.message);
        });
        
    } catch (e) {
        log.error("config-file", "Could not start file watcher: " + e.message);
    }
}

/**
 * Stop the file watcher
 * @returns {void}
 */
function stopFileWatcher() {
    if (fileWatcher) {
        fileWatcher.close();
        fileWatcher = null;
        log.info("config-file", "File watcher stopped");
    }
    
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
}

/**
 * Create a sample config file if it doesn't exist
 * @returns {void}
 */
function createSampleConfigFile() {
    const filePath = getConfigFilePath();
    if (!filePath) {
        return;
    }
    const samplePath = filePath + ".sample";
    
    if (fs.existsSync(samplePath)) {
        return;
    }
    
    const sampleConfig = `# Uptime Kuma Revanced Config File Monitors
# 
# Place this file at: data/monitors.yaml
# Monitors defined here will be automatically synced with the database.
# Changes to this file will be detected and applied automatically.
#
# IMPORTANT: Monitors created via this config file are marked as "config_managed"
# and will be controlled exclusively by this file. To edit them, modify this file.

monitors:
  # HTTP Monitor Example
  - name: "Google"
    type: "http"
    url: "https://google.com"
    interval: 60
    retryInterval: 60
    maxretries: 3
    active: true
    # Optional fields:
    # method: "GET"
    # timeout: 48
    # ignoreTls: false
    # maxredirects: 10
    # accepted_statuscodes:
    #   - "200-299"
    # headers: '{"Content-Type": "application/json"}'
    # body: '{"key": "value"}'
    
  # Keyword Monitor Example  
  # - name: "Example Keyword Check"
  #   type: "keyword"
  #   url: "https://example.com/status"
  #   keyword: "All systems operational"
  #   interval: 60
    
  # Ping Monitor Example
  # - name: "Example Ping"
  #   type: "ping"
  #   hostname: "example.com"
  #   interval: 60
  
  # TCP Port Monitor Example
  # - name: "My Service Port"
  #   type: "port"
  #   hostname: "localhost"
  #   port: 8080
  #   interval: 60
  
  # DNS Monitor Example
  # - name: "DNS Check"
  #   type: "dns"
  #   hostname: "example.com"
  #   dns_resolve_server: "8.8.8.8"
  #   dns_resolve_type: "A"
  #   interval: 300
  
  # Docker Container Monitor Example
  # - name: "My Container"
  #   type: "docker"
  #   docker_container: "container_name"
  #   docker_host: 1  # Docker host ID from UI
  #   interval: 60
  
  # Push Monitor Example (for external heartbeats)
  # - name: "Backup Job"
  #   type: "push"
  #   interval: 86400  # Expected heartbeat every 24 hours
  
  # MySQL Monitor Example
  # - name: "MySQL Database"
  #   type: "mysql"
  #   databaseConnectionString: "mysql://user:password@host:3306/database"
  #   interval: 60
  #   databaseQuery: "SELECT 1"
  
  # PostgreSQL Monitor Example
  # - name: "PostgreSQL Database"
  #   type: "postgres"
  #   databaseConnectionString: "postgres://user:password@host:5432/database"
  #   interval: 60
  
  # Redis Monitor Example
  # - name: "Redis Cache"
  #   type: "redis"
  #   databaseConnectionString: "redis://localhost:6379"
  #   interval: 60
  
  # MongoDB Monitor Example
  # - name: "MongoDB"
  #   type: "mongodb"
  #   databaseConnectionString: "mongodb://localhost:27017"
  #   interval: 60

# Available monitor types: 
# http, keyword, json-query, ping, port, dns, push, steam, gamedig, mqtt,
# sqlserver, postgres, mysql, mongodb, radius, redis, group, docker, grpc,
# real-browser, snmp, smtp, rabbitmq
`;
    
    try {
        fs.writeFileSync(samplePath, sampleConfig, "utf8");
        log.info("config-file", "Created sample config file at: " + samplePath);
    } catch (e) {
        log.warn("config-file", "Could not create sample config file: " + e.message);
    }
}

/**
 * Initialize config file monitors system
 * @param {number} userId User ID (usually the first user)
 * @param {object} server UptimeKumaServer instance
 * @returns {Promise<void>}
 */
async function initConfigFileMonitors(userId, server) {
    log.info("config-file", "Initializing config file monitors");
    
    // Create sample config file
    createSampleConfigFile();
    
    // Initial sync
    await syncConfigMonitors(userId, server);
    
    // Start file watcher
    startFileWatcher(userId, server);
}

module.exports = {
    initConfigFileMonitors,
    syncConfigMonitors,
    stopFileWatcher,
    configFileExists,
    readConfigFile,
    validateMonitorConfig,
    getConfigFilePath,
};
