const { log } = require("../../src/util");
const { Settings } = require("../settings");
const { sendInfo } = require("../client");
const { checkLogin } = require("../util-server");
const { games } = require("gamedig");
const { testChrome } = require("../monitor-types/real-browser-monitor-type");
const fsAsync = require("fs").promises;
const path = require("path");
const { syncConfigMonitors, configFileExists, getConfigFilePath } = require("../config-file-monitors");

/**
 * Get a game list via GameDig
 * @returns {object} list of games supported by GameDig
 */
function getGameList() {
    let gameList = [];
    gameList = Object.keys(games).map((key) => {
        const item = games[key];
        return {
            keys: [key],
            pretty: item.name,
            options: item.options,
            extra: item.extra || {},
        };
    });
    gameList.sort((a, b) => {
        if (a.pretty < b.pretty) {
            return -1;
        }
        if (a.pretty > b.pretty) {
            return 1;
        }
        return 0;
    });
    return gameList;
}

/**
 * Handler for general events
 * @param {Socket} socket Socket.io instance
 * @param {UptimeKumaServer} server Uptime Kuma server
 * @returns {void}
 */
module.exports.generalSocketHandler = (socket, server) => {
    socket.on("initServerTimezone", async (timezone) => {
        try {
            checkLogin(socket);
            log.debug("generalSocketHandler", "Timezone: " + timezone);
            await Settings.set("initServerTimezone", true);
            await server.setTimezone(timezone);
            await sendInfo(socket);
        } catch (e) {
            log.warn("initServerTimezone", e.message);
        }
    });

    socket.on("getGameList", async (callback) => {
        try {
            checkLogin(socket);
            callback({
                ok: true,
                gameList: getGameList(),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("testChrome", (executable, callback) => {
        try {
            checkLogin(socket);
            // Just noticed that await call could block the whole socket.io server!!! Use pure promise instead.
            testChrome(executable)
                .then((version) => {
                    callback({
                        ok: true,
                        msg: {
                            key: "foundChromiumVersion",
                            values: [version],
                        },
                        msgi18n: true,
                    });
                })
                .catch((e) => {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getPushExample", async (language, callback) => {
        try {
            checkLogin(socket);
            if (!/^[a-z-]+$/.test(language)) {
                throw new Error("Invalid language");
            }
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
            return;
        }

        try {
            let dir = path.join("./extra/push-examples", language);
            let files = await fsAsync.readdir(dir);

            for (let file of files) {
                if (file.startsWith("index.")) {
                    callback({
                        ok: true,
                        code: await fsAsync.readFile(path.join(dir, file), "utf8"),
                    });
                    return;
                }
            }
        } catch (e) {}

        callback({
            ok: false,
            msg: "Not found",
        });
    });

    // Disconnect all other socket clients of the user
    socket.on("disconnectOtherSocketClients", async () => {
        try {
            checkLogin(socket);
            server.disconnectAllSocketClients(socket.userID, socket.id);
        } catch (e) {
            log.warn("disconnectAllSocketClients", e.message);
        }
    });

    // Get config file monitors status
    socket.on("getConfigFileStatus", async (callback) => {
        try {
            checkLogin(socket);
            callback({
                ok: true,
                exists: configFileExists(),
                path: getConfigFilePath(),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    // Manually sync config file monitors
    socket.on("syncConfigMonitors", async (callback) => {
        try {
            checkLogin(socket);
            const result = await syncConfigMonitors(socket.userID, server);
            
            // Refresh monitor list for the user after sync
            await server.sendMonitorList(socket);
            
            callback({
                ok: result.errors.length === 0,
                added: result.added,
                updated: result.updated,
                removed: result.removed,
                errors: result.errors,
                msg: result.errors.length > 0 
                    ? `Sync completed with ${result.errors.length} errors` 
                    : `Sync complete: Added ${result.added}, Updated ${result.updated}, Removed ${result.removed}`,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
