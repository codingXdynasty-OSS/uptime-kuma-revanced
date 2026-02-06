process.env.NODE_ENV = "development";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const TestDB = require("../mock-testdb");
const { R } = require("redbean-node");
const { Prometheus } = require("../../server/prometheus");

describe("Config File Monitors", () => {
    let testDB;
    let configFileMonitors;
    let testDataDir = path.join(__dirname, "../data-test-config");
    let yamlFile = path.join(testDataDir, "monitors.yaml");
    let userId;

    before(async () => {
        // Create test data dir
        if (!fs.existsSync(testDataDir)) {
            fs.mkdirSync(testDataDir, { recursive: true });
        }

        // Setup test database
        testDB = new TestDB(testDataDir);
        await testDB.create();

        // Initialize Prometheus metrics for the test environment
        await Prometheus.init();

        // Create a test user
        const user = R.dispense("user");
        user.username = "testuser";
        user.password = "password";
        userId = await R.store(user);

        // Required by the module
        configFileMonitors = require("../../server/config-file-monitors");
    });

    after(async () => {
        // Stop all monitors that might be running
        require("../../server/model/monitor");
        const list = await R.find("monitor");
        for (const monitor of list) {
            try {
                await monitor.stop();
            } catch (e) {}
        }

        if (testDB) {
            await testDB.destroy();
        }
        if (fs.existsSync(testDataDir)) {
            fs.rmSync(testDataDir, { recursive: true, force: true });
        }
    });

    test("Get config file path should be correct", () => {
        const filePath = configFileMonitors.getConfigFilePath();
        assert.ok(filePath.endsWith("monitors.yaml"));
    });

    test("Validate monitor config", () => {
        // Valid config
        const validConfig = {
            name: "Test Monitor",
            type: "http",
            url: "https://example.com"
        };
        const res1 = configFileMonitors.validateMonitorConfig(validConfig, 0);
        assert.strictEqual(res1.valid, true);

        // Missing name
        const invalidConfig1 = {
            type: "http",
            url: "https://example.com"
        };
        const res2 = configFileMonitors.validateMonitorConfig(invalidConfig1, 0);
        assert.strictEqual(res2.valid, false);
        assert.ok(res2.errors[0].includes("'name' is required"));

        // Missing required field for type
        const invalidConfig2 = {
            name: "Test Monitor",
            type: "http"
        };
        const res3 = configFileMonitors.validateMonitorConfig(invalidConfig2, 0);
        assert.strictEqual(res3.valid, false);
        assert.ok(res3.errors[0].includes('Field "url" is required'));
    });

    test("Sync monitors from YAML", async () => {
        // Create YAML file
        const yamlContent = `
monitors:
  - name: "YAML Monitor 1"
    type: "http"
    url: "https://test1.com"
    interval: 60
  - name: "YAML Monitor 2"
    type: "ping"
    hostname: "1.1.1.1"
    interval: 30
    `;
        fs.writeFileSync(yamlFile, yamlContent);

        // Mock server object
        const mockServer = {
            monitorList: {},
            io: {
                to: () => ({ emit: () => {} }),
                emit: () => {}
            }
        };

        const result = await configFileMonitors.syncConfigMonitors(userId, mockServer);
        
        assert.strictEqual(result.added, 2);
        assert.strictEqual(result.errors.length, 0);

        // Verify in database
        const monitors = await R.find("monitor", " user_id = ? ", [userId]);
        assert.strictEqual(monitors.length, 2);
        assert.strictEqual(monitors[0].config_managed, 1);
        assert.strictEqual(monitors[1].config_managed, 1);
        
        const monitor1 = monitors.find(m => m.name === "YAML Monitor 1");
        assert.strictEqual(monitor1.type, "http");
        assert.strictEqual(monitor1.url, "https://test1.com");

        // Update YAML file (modify one, remove one, add one)
        const updatedYamlContent = `
monitors:
  - name: "YAML Monitor 1"
    type: "http"
    url: "https://test1-updated.com"
    interval: 90
  - name: "YAML Monitor 3"
    type: "port"
    hostname: "localhost"
    port: 8080
    `;
        fs.writeFileSync(yamlFile, updatedYamlContent);

        const result2 = await configFileMonitors.syncConfigMonitors(userId, mockServer);
        
        assert.strictEqual(result2.added, 1);   // Monitor 3
        assert.strictEqual(result2.updated, 1); // Monitor 1
        assert.strictEqual(result2.removed, 1); // Monitor 2
        
        // Verify in database
        const finalMonitors = await R.find("monitor", " user_id = ? ", [userId]);
        assert.strictEqual(finalMonitors.length, 2);
        
        const m1 = finalMonitors.find(m => m.name === "YAML Monitor 1");
        assert.strictEqual(m1.url, "https://test1-updated.com");
        assert.strictEqual(m1.interval, 90);
        
        const m3 = finalMonitors.find(m => m.name === "YAML Monitor 3");
        assert.strictEqual(m3.type, "port");
        assert.strictEqual(m3.hostname, "localhost");
    });
});
