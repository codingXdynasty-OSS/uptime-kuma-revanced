# Config File Monitors Feature

This feature allows you to define monitors in a YAML configuration file instead of (or in addition to) adding them through the UI.

## How It Works

1. **Config File Location**: Place your monitors configuration at `data/monitors.yaml`
2. **Auto-Sync**: Monitors defined in the config file are automatically synced to the database on startup
3. **Hot Reload**: Changes to the config file are detected and applied automatically
4. **Config Managed**: Monitors created via config file are marked as "config_managed" and cannot be edited/deleted through the UI

## Config File Format

The config file uses YAML format. Example:

```yaml
monitors:
  # HTTP Monitor
  - name: "Google"
    type: "http"
    url: "https://google.com"
    interval: 60
    retryInterval: 60
    maxretries: 3
    active: true
    
  # Ping Monitor
  - name: "Example Ping"
    type: "ping"
    hostname: "example.com"
    interval: 60
    
  # TCP Port Monitor
  - name: "My Service Port"
    type: "port"
    hostname: "localhost"
    port: 8080
    interval: 60
    
  # DNS Monitor
  - name: "DNS Check"
    type: "dns"
    hostname: "example.com"
    dns_resolve_server: "8.8.8.8"
    dns_resolve_type: "A"
    interval: 300
```

## Supported Monitor Types

All Uptime Kuma monitor types are supported:

| Type | Required Fields |
|------|----------------|
| `http` | `url` |
| `keyword` | `url`, `keyword` |
| `json-query` | `url`, `jsonPath`, `expectedValue` |
| `ping` | `hostname` |
| `port` | `hostname`, `port` |
| `dns` | `hostname`, `dns_resolve_server` |
| `push` | (none) |
| `steam` | `hostname`, `port` |
| `gamedig` | `hostname`, `port`, `game` |
| `mqtt` | `hostname`, `port`, `mqttTopic` |
| `sqlserver` | `databaseConnectionString` |
| `postgres` | `databaseConnectionString` |
| `mysql` | `databaseConnectionString` |
| `mongodb` | `databaseConnectionString` |
| `radius` | `hostname`, `radiusUsername`, `radiusPassword`, `radiusSecret` |
| `redis` | `databaseConnectionString` |
| `group` | (none) |
| `docker` | `docker_container`, `docker_host` |
| `grpc` | `grpcUrl`, `grpcServiceName`, `grpcMethod` |
| `real-browser` | `url` |
| `snmp` | `hostname`, `snmpOid` |
| `smtp` | `hostname`, `port` |
| `rabbitmq` | `rabbitmqNodes` |

## Common Optional Fields

All monitor types support these optional fields with default values:

| Field | Default | Description |
|-------|---------|-------------|
| `active` | `true` | Whether the monitor is active |
| `interval` | `60` | Check interval in seconds (20-86400) |
| `retryInterval` | `60` | Retry interval in seconds (20-86400) |
| `maxretries` | `0` | Maximum number of retries |
| `timeout` | `48` | Timeout in seconds |
| `resendInterval` | `0` | Notification resend interval |
| `upsideDown` | `false` | Inverse monitoring mode |
| `ignoreTls` | `false` | Ignore TLS certificate errors |
| `maxredirects` | `10` | Maximum redirects for HTTP |
| `accepted_statuscodes` | `["200-299"]` | Accepted HTTP status codes |
| `method` | `"GET"` | HTTP method |
| `description` | `null` | Monitor description |

## HTTP-Specific Fields

| Field | Description |
|-------|-------------|
| `headers` | JSON string of HTTP headers |
| `body` | HTTP request body |
| `httpBodyEncoding` | Body encoding: `json`, `form`, or `xml` |
| `basic_auth_user` | Basic auth username |
| `basic_auth_pass` | Basic auth password |

## Behavior

### On Startup
- Creates a sample config file at `data/monitors.yaml.sample` if it doesn't exist
- Syncs monitors from `data/monitors.yaml` to the database
- Starts a file watcher for hot reload

### On Config File Change
- Detects file modifications automatically
- Adds new monitors defined in the config
- Updates existing config-managed monitors
- Removes monitors no longer in the config

### Protection
- Config-managed monitors cannot be edited through the UI
- Config-managed monitors cannot be deleted through the UI
- A badge/indicator shows which monitors are config-managed

## Socket Events

Two new socket events are available:

1. `getConfigFileStatus` - Returns config file status (exists, path)
2. `syncConfigMonitors` - Manually triggers a config file sync

## Files Added/Modified

### New Files
- `server/config-file-monitors.js` - Main config file handling module
- `db/knex_migrations/2026-02-06-0000-add-config-managed-column.js` - Database migration
- `docs/config-file-monitors.md` - This documentation

### Modified Files
- `server/server.js` - Integration of config file monitors
- `server/model/monitor.js` - Added `configManaged` field to JSON output
- `server/socket-handlers/general-socket-handler.js` - Added socket events
- `package.json` - Added `js-yaml` dependency

## Getting Started

1. Install the new dependency: `npm install js-yaml`
2. Start Uptime Kuma - it will create a sample config file
3. Copy `data/monitors.yaml.sample` to `data/monitors.yaml`
4. Edit `data/monitors.yaml` with your monitors
5. The monitors will be automatically synced

## Environment Variables

No new environment variables are required. The config file uses the existing `DATA_DIR` setting.
