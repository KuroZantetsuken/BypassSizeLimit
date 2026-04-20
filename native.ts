import { IpcMainInvokeEvent } from "electron";
import { Logger } from "@utils/Logger";
import { createWriteStream, readFileSync, existsSync, writeFileSync, unlinkSync } from "fs";
import { get } from "https";
import { join } from "path";
import { tmpdir } from "os";

const logger = new Logger("BypassFileLimitNative");
const DB_PATH = join(__dirname, 'detectable.json');

/**
 * These are the exact magic bytes used by the user's PowerShell script 
 * and YABDP4Nitro to spoof Discord Clip metadata.
 */
const CLIP_MAGIC_BYTES = Buffer.from([
    0, 0, 0, 89, 109, 101, 116, 97, 0, 0, 0, 0, 0, 0, 0, 33, 104, 100, 108, 114, 0, 0, 0, 0, 0, 0, 0, 0, 109, 100, 105, 114, 97, 112, 112, 108, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 44, 105, 108, 115, 116, 0, 0, 0, 36, 169, 116, 111, 111, 0, 0, 0, 28, 100, 97, 116, 97, 0, 0, 0, 1, 0, 0, 0, 0, 76, 97, 118, 102, 54, 49, 46, 51, 46, 49, 48, 51, 0, 0, 46, 46, 117, 117, 105, 100, 161, 200, 82, 153, 51, 70, 77, 184, 136, 240, 131, 245, 122, 117, 165, 239
]);

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
        await updateDetectableDatabase();
    }

    try {
        const db: Detectable[] = JSON.parse(readFileSync(DB_PATH, 'utf8'));
        const lowerInput = exeName.toLowerCase();
        const cleanInput = lowerInput.replace(/[^a-z0-9]/g, "");

        const exactMatch = db.find(app =>
            app.executables?.some(exe => {
                const name = exe.name.split('/').pop()?.toLowerCase();
                return (name === lowerInput || name === lowerInput + ".exe") && exe.os === 'win32';
            })
        );
        if (exactMatch) return exactMatch.id;

        const fuzzyMatch = db.find(app =>
            app.executables?.some(exe => {
                const name = exe.name.split('/').pop()?.toLowerCase().replace(".exe", "").replace(/[^a-z0-9]/g, "");
                if (!name || name.length < 3) return false;
                return (cleanInput.startsWith(name) || name.startsWith(cleanInput)) && exe.os === 'win32';
            })
        );

        if (fuzzyMatch) return fuzzyMatch.id;
    } catch (e) {
        logger.error("Error searching detectable database:", e);
    }
    return null;
}

/**
 * Saves a buffer to a temporary file in the OS temp directory.
 * Appends the Clip Bypass magic bytes directly to the end of the file.
 */
export async function createTempClip(_: IpcMainInvokeEvent, buffer: ArrayBuffer): Promise<string> {
    const filename = `bypass_clip_${Date.now()}_${Math.random().toString(36).substring(7)}.mp4`;
    const tempPath = join(tmpdir(), filename);
    
    logger.log(`Creating temporary clip: ${tempPath}`);
    
    // Combine original buffer with magic bytes
    const finalBuffer = Buffer.concat([Buffer.from(buffer), CLIP_MAGIC_BYTES]);
    writeFileSync(tempPath, finalBuffer);
    
    return tempPath;
}

/**
 * Reads the processed file and deletes it from the temp directory.
 */
export async function finalizeTempClip(_: IpcMainInvokeEvent, path: string): Promise<ArrayBuffer> {
    logger.log(`Finalizing and cleaning up: ${path}`);
    try {
        const data = readFileSync(path);
        try { unlinkSync(path); } catch {}
        return data.buffer;
    } catch (e) {
        logger.error(`Failed to read/finalize clip: ${path}`, e);
        throw e;
    }
}

export async function initDatabase() {
    if (!existsSync(DB_PATH)) {
        await updateDetectableDatabase();
    }
}