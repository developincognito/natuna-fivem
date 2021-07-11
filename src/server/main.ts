import mysql from "mysql2";

import fs from "fs";
import path from "path";
import util from "util";

import figlet from "figlet";
import standard from "figlet/importable-fonts/Doom";

import * as Database from "@server/wrapper/database-wrapper";
import * as Crypter from "@server/wrapper/crypter-wrapper";
import * as Command from "@server/wrapper/command-wrapper";

import pkg from "@/package.json";
const cfg: Config = require("@/koi.config");

interface Config {
    core: {
        whitelistedSteamID: Array<string>;
        mysql: {
            host: string;
            port: number;
            user: string;
            password: string;
            database: string;
        };
        crypter: {
            algorithm: string;
            secretKey: string;
        };
        client: {
            noDispatchService?: boolean;
            noWantedLevel?: boolean;
            autoRespawnDisabled?: boolean;
        };
    };
    plugins: {
        [key: string]: {
            [key: string]: any;
            client: any;
            server: any;
        };
    };
}

class Server {
    /**
     * MySQL database wrapper
     */
    db: (table: string) => Database.Wrapper;

    /**
     * Crypter to Encrypt or Decrypt your secret data
     */
    crypter: (algorithm: string, secretKey: string) => Crypter.Wrapper;

    /**
     * List of Server Plugins
     */
    plugins: { [key: string]: any };

    /**
     * List of Registered Commands
     */
    commands: { [key: string]: Command.Wrapper };

    constructor() {
        this.plugins = {};
        this.commands = {};

        this.db = (table: string) => new Database.Wrapper(mysql.createConnection(cfg.core.mysql), table);
        this.crypter = (algorithm: string = cfg.core.crypter.algorithm, secretKey: string = cfg.core.crypter.secretKey) => new Crypter.Wrapper(algorithm, secretKey);

        this.addSharedEventHandler("koi:server:requestClientSettings", this._events.requestClientSettings);
        this.addSharedEventHandler("koi:server:registerCommand", this.registerCommand);
        this.addSharedEventHandler("koi:server:executeCommand", this.executeCommand);

        this.addServerEventHandler("playerConnecting", this._events.playerConnecting);
        this.addServerEventHandler("onServerResourceStart", this._events.onServerResourceStart);
        this.addServerEventHandler("onServerResourceStop", this._events.onServerResourceStop);

        // Test database connection (on startup) <-- check if connection success or not, also making an automated database creation 👍
        this.db("").utils.executeQuery(`CREATE DATABASE IF NOT EXISTS \`${cfg.core.mysql.database}\``);
    }

    /**
     * Add server only event and listen for it, only can be triggered from server
     * @author Rafly Maulana
     *
     * @param name Name of the event
     * @param args Arguments to send
     *
     * @example
     * addServerEventHandler("someEvent", (playerID) => console.log(playerID))
     */
    addServerEventHandler = (name: string | Array<string>, handler: Function) => {
        if (typeof name == "object" && Array.isArray(name)) {
            for (const alias of name) {
                on(alias, handler);
            }
        } else if (typeof name == "string") {
            on(name, handler);
        } else {
            throw new Error(`Invalid Server Event Name Properties for ${name}`);
        }
    };

    /**
     * Add shared event and listen from both server or client
     * @author Rafly Maulana
     *
     * @param name Name of the event
     * @param args Arguments to send
     *
     * @example
     * addSharedEventHandler("someEvent", (playerID) => console.log(playerID))
     */
    addSharedEventHandler = (name: string | Array<string>, handler: Function) => {
        if (typeof name == "object" && Array.isArray(name)) {
            for (const alias of name) {
                onNet(alias, handler);
            }
        } else if (typeof name == "string") {
            onNet(name, handler);
        } else {
            throw new Error(`Invalid Shared Event Name Properties for ${name}`);
        }
    };

    /**
     * Trigger a registered server event
     * @author Rafly Maulana
     *
     * @param name Name of the event
     * @param args Arguments to send
     *
     * @example
     * triggerServerEvent("someEvent", true)
     */
    triggerServerEvent = (name: string | Array<string>, ...args: any) => {
        if (typeof name == "object" && Array.isArray(name)) {
            for (const alias of name) {
                emit(alias, ...args);
            }
        } else if (typeof name == "string") {
            emit(name, ...args);
        } else {
            throw new Error(`Invalid Server Trigger Name Properties for ${name}`);
        }
    };

    /**
     * Trigger shared event between client and server, only event registered as shared event that can be triggered
     * @author Rafly Maulana
     *
     * @param name Name of the event
     * @param target Target of the player ID (Server ID)
     * @param args Arguments to send
     *
     * @example
     * triggerSharedEvent("someEvent", 1, true)
     */
    triggerSharedEvent = (name: string | Array<string>, target: number, ...args: any) => {
        if (typeof name == "object" && Array.isArray(name)) {
            for (const alias of name) {
                emitNet(alias, target, ...args);
            }
        } else if (typeof name == "string") {
            emitNet(name, target, ...args);
        } else {
            throw new Error(`Invalid Shared Trigger Name Properties for ${name}`);
        }
    };

    /**
     * Use this function to hold next script below this from executing before it finish the timeout itself
     * @author Rafly Maulana
     * @source https://docs.fivem.net/docs/scripting-manual/introduction/creating-your-first-script-javascript/
     *
     * @param ms Milisecond to wait
     *
     * @example
     * const one = () => true; // Always use ES6 for better practice
     * const two = () => true;
     *
     * setTimeout(async() => { // Always do it on async
     *      one();
     *      await wait(5000); // Wait 5s (5000ms) before executing next function, always await it
     *      two(); // Executed after 5 second after wait before
     * });
     */
    wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

    /**
     * Execute a registrated command on Koi Framework only
     * @author Rafly Maulana
     *
     * @param src Source of the player ID (Server ID)
     * @param name The registered command name (Example: tp)
     * @param validate Validate the command using the command configuration or not
     * @param args Command arguments
     *
     * @example
     * executeComamnd(1, 'tp', [100, 200, 300], true) // Validate the command execution
     */
    executeCommand = (name: string, src: number, args: Array<any>, validate: boolean = false) => {
        if (!validate || (validate && this.commands[name].validateExecution(src, args, name) == true)) {
            this.commands[name].handler(src, args, name);
        }
    };

    /**
     * Registrating a command. If isClientCommand was set true, the handler would just triggering a client registered command
     * @author Rafly Maulana
     *
     * @param name Name of the command
     * @param handler Function to executed
     * @param config Configuration of the command
     * @param isClientCommand Whether if the command was sent from client or not
     *
     * @example
     * registerCommand(
     *      'hello',
     *      (src, args) => console.log('Hello!'),
     *      {
     *          description: "Say Hello"
     *      }
     * });
     */
    registerCommand = (name: string | Array<string>, handler: Command.Handler, config: Command.Config = {}, isClientCommand: boolean = false) => {
        const commandRegistration = (name: string) => {
            // Throws an error when same server command was registered twice
            if (this.commands[name] && !isClientCommand) throw new Error(`Command "${name}" had already been registered before!`);

            emitNet("koi:client:setCommandDescription", -1, name, config);

            // Return if client command was already registered before
            if (this.commands[name] && isClientCommand) return;
            this.commands[name] = new Command.Wrapper(this, name, handler, config, isClientCommand);
        };

        if (Array.isArray(name)) {
            for (const alias of name) {
                commandRegistration(alias);
            }
        } else {
            commandRegistration(name);
        }

        return true;
    };

    /**
     * Get all set of player ID and return it on JSON format
     * @author Rafly Maulana
     *
     * @param src Server ID of the Player
     *
     * @example
     * const steamID: getPlayerIds(1).steam;
     * console.log(steamID)
     */
    getPlayerIds = (src: any) => {
        const playerIds: any = {};

        for (let i = 0; i < GetNumPlayerIdentifiers(src); i++) {
            const id = GetPlayerIdentifier(src, i).split(":");
            playerIds[id[0]] = id[1];
        }

        playerIds.steam = !playerIds.steam || typeof playerIds.steam == "undefined" ? false : BigInt(`0x${playerIds.steam}`);
        return playerIds;
    };

    /**
     * Logger to Console
     * @author Rafly Maulana
     *
     * @param text Text to logs
     */
    _logger = (...text: any) => {
        console.log("\x1b[33m%s\x1b[0m", "[🎏 Koi Framework]", ...text);
    };

    /**
     * Loops through folder and retrieve every plugins file
     * @author Rafly Maulana
     *
     * @param type Type of the plugin (Client or Server)
     */
    _getPlugins = async (type: string) => {
        let resourceList: Array<{ resourceName: string; file: string; config: any }> = [];

        const readDirAsync = util.promisify(fs.readdir);
        const pluginsPath = path.join(GetResourcePath(GetCurrentResourceName()), "plugins");

        const resources = await readDirAsync(pluginsPath);

        for (const resourceName of resources) {
            try {
                const files = await readDirAsync(path.join(pluginsPath, resourceName, type));
                const config = cfg.plugins[resourceName] && cfg.plugins[resourceName][type] ? cfg.plugins[resourceName][type] : {};

                for (const file of files) {
                    resourceList.push({ resourceName, file, config });
                }
            } catch (error) {
                // Keep it empty to make sure the file finding process is still working on
            }
        }

        return resourceList;
    };

    /**
     * This function is to init a plugin, differs from the client ones, it's triggered whenever the script was ready
     * @author Rafly Maulana
     */
    _initPlugins = async () => {
        this._logger(`Intializing Server Plugins`);
        const plugins = await this._getPlugins("server");

        let count = 1; // Start from 1
        for (const plugin of plugins) {
            this._logger(`Ensuring Plugins: ${count}. ${plugin.resourceName}`);

            this.plugins[plugin.resourceName] = require(`../../plugins/${plugin.resourceName}/server/${plugin.file}`);
            this.plugins[plugin.resourceName]._handler(this, plugin.config);

            count += 1;
        }

        this._logger("Server Plugins Ready!");
    };

    /**
     * List of events on server
     * @author Various Developer
     */
    _events = {
        /**
         * Listen on whenever a player joining a session also validating that player before joining the session
         * @author Rafly Maulana
         *
         * @param name The display name of the player connecting
         * @param setKickReason A function used to set a reason message for when the event is canceled.
         * @param deferrals An object to control deferrals.
         */
        playerConnecting: async (name: string, setKickReason: (reason: string) => void, deferrals: { defer: any; done: any; handover: any; presentCard: any; update: any }) => {
            deferrals.defer();
            const player = (global as any).source;

            deferrals.update(`[🎏 Koi] Hello ${name}! Please wait until we verify your account.`);

            const playerIds = this.getPlayerIds(player);

            if (!playerIds.steam || typeof playerIds.steam == "undefined") {
                return deferrals.done("[🎏 Koi] You are not connected to Steam!");
            }

            if (cfg.core.whitelistedSteamID && Array.isArray(cfg.core.whitelistedSteamID) && cfg.core.whitelistedSteamID.length > 0) {
                if (!cfg.core.whitelistedSteamID.find(playerIds.steam)) {
                    return deferrals.done("[🎏 Koi] You are not whitelisted!");
                }
            }

            deferrals.update(`[🎏 Koi] Finding your account in our database.`);

            const user = await this.db("users").findFirst({
                where: {
                    id: playerIds.steam,
                },
            });

            let userCheck: any = false;
            const newCheckpointData = {
                last_ip: playerIds.ip.toString(),
                last_login: new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }).toString(),
            };

            // Help saving two times query execution for a new player
            if (!user) {
                userCheck = await this.db("users").write({
                    data: {
                        id: playerIds.steam,
                        ...newCheckpointData,
                    },
                });
            } else {
                if (user.banned) {
                    return deferrals.done(`[🎏 Koi] ⛔ You are banned from the server, Reason: ${user.banned_reason}`);
                }

                userCheck = await this.db("users").update({
                    data: {
                        ...newCheckpointData,
                    },
                    where: {
                        id: playerIds.steam,
                    },
                });
            }

            if (userCheck) return deferrals.done();
        },

        /**
         * Listen on whenever a player requested plugins to be setup on their client
         * @author Rafly Maulana
         */
        requestClientSettings: async () => {
            const player = (global as any).source;
            const plugins = await this._getPlugins("client");

            this.triggerSharedEvent("koi:client:retrieveClientSettings", player, {
                plugins,
                config: cfg.core.client,
            });
        },

        /**
         * Listen when Koi Framework is starting
         * @author Rafly Maulana
         *
         * @param resourceName Name of the resource that's starting
         */
        onServerResourceStart: (resourceName: string) => {
            if (GetCurrentResourceName() == resourceName) {
                /**
                 * Event: Starting Process
                 */
                figlet.parseFont("Standard", standard);
                figlet.text(
                    "KOI Framework",
                    {
                        font: "Standard",
                    },
                    (err, data) => {
                        console.log(data);
                    }
                );
                this._logger(`Welcome! You are using version ${pkg.version}.`);
                this.triggerServerEvent("koi:server:starting");

                /**
                 * Event: Initializing
                 */
                this._logger("Starting Server...");
                this.triggerServerEvent("koi:server:initializing");

                this._initPlugins();

                /**
                 * Event: Ready
                 */
                this._logger("Server Ready!");
                this.triggerServerEvent("koi:server:ready");
            }
        },

        /**
         * Listen when Koi Framework is stopping
         * @author Rafly Maulana
         *
         * @param resourceName Name of the resource that's stopping
         */
        onServerResourceStop: (resourceName: string) => {
            if (GetCurrentResourceName() == resourceName) {
                this.triggerServerEvent("koi:server:stopped");
            }
        },
    };
}

const server = new Server();
(global as any).exports("getServerProps", () => server);

export default Server;
export { Config, Server };
