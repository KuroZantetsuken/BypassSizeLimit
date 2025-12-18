import { IpcMainInvokeEvent } from "electron";
import { Logger } from "@utils/Logger";
import { createWriteStream, readFileSync, existsSync } from "fs";
import { get } from "https";
import { join } from "path";

const logger = new Logger("BypassFileLimitNative");
const DB_PATH = join(__dirname, 'detectable.json');

interface Detectable {
    id: string;
    name: string;
    executables: {
        name: string;
        os: 'win32' | 'linux' | 'darwin';
    }[];
}

async function updateDetectableDatabase(): Promise<void> {
    logger.log('Fetching latest detectable applications from Discord...');
    return new Promise((resolve, reject) => {
        const file = createWriteStream(DB_PATH);
        get('https://discord.com/api/v9/applications/detectable', (res) => {
            res.pipe(file);
            file.on('finish', () => {
                file.close();
                logger.log('Detectable database updated successfully.');
                resolve();
            });
        }).on('error', (err) => {
            logger.error('Failed to download detectable database:', err);
            reject(err);
        });
    });
}

export async function findAppId(_: IpcMainInvokeEvent, exeName: string): Promise<string | null> {
    if (!existsSync(DB_PATH)) {
        logger.warn("Detectable database not found! Updating...");
        await updateDetectableDatabase();
    }

    try {
        const db: Detectable[] = JSON.parse(readFileSync(DB_PATH, 'utf8'));
        const lowerInput = exeName.toLowerCase();
        const cleanInput = lowerInput.replace(/[^a-z0-9]/g, "");

        logger.log(`Searching for app with exe name: ${lowerInput} (Clean: ${cleanInput})`);

        // Pass 1: Exact match with .exe
        const exactMatch = db.find(app =>
            app.executables?.some(exe => {
                const name = exe.name.split('/').pop()?.toLowerCase();
                return (name === lowerInput || name === lowerInput + ".exe") && exe.os === 'win32';
            })
        );
        if (exactMatch) {
            logger.log(`Found exact match: ${exactMatch.name} (ID: ${exactMatch.id})`);
            return exactMatch.id;
        }

        // Pass 2: Fuzzy match (is database exe name a prefix of the input or vice versa?)
        // This handles cases like "zenlesszonezero2025.06.13..."
        const fuzzyMatch = db.find(app =>
            app.executables?.some(exe => {
                const name = exe.name.split('/').pop()?.toLowerCase().replace(".exe", "").replace(/[^a-z0-9]/g, "");
                if (!name || name.length < 3) return false; // Avoid matching very short exe names like "a.exe"
                return (cleanInput.startsWith(name) || name.startsWith(cleanInput)) && exe.os === 'win32';
            })
        );

        if (fuzzyMatch) {
            logger.log(`Found fuzzy match: ${fuzzyMatch.name} (ID: ${fuzzyMatch.id})`);
            return fuzzyMatch.id;
        }
    } catch (e) {
        logger.error("Error searching detectable database:", e);
    }

    return null;
}

export async function initDatabase() {
    if (!existsSync(DB_PATH)) {
        await updateDetectableDatabase();
    }
}