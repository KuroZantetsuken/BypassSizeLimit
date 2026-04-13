import { Logger } from "@utils/Logger";
import { find, findByProps } from "@webpack";
import definePlugin, { PluginNative } from "@utils/types";

const logger = new Logger("BypassFileLimit");
let Native: PluginNative<typeof import("./native")>;

/**
 * Robust monkey-patching utility that handles descriptors and nested properties.
 */
function monkeyPatch(obj: any, key: string, newValue: any) {
    if (!obj) return;
    try {
        if (key.includes('.')) {
            const parts = key.split('.');
            const targetKey = parts.pop()!;
            let targetObj = obj;
            for (const part of parts) {
                targetObj = targetObj[part];
                if (!targetObj) return;
            }
            monkeyPatch(targetObj, targetKey, newValue);
            return;
        }

        const descriptor = Object.getOwnPropertyDescriptor(obj, key);
        if (descriptor && !descriptor.configurable) {
            logger.warn(`Property ${key} is not configurable, patch might fail.`);
        }
        Object.defineProperty(obj, key, {
            value: newValue,
            configurable: true,
            enumerable: true,
            writable: true
        });
        logger.info(`Successfully patched key: ${key}`);
    } catch (e) {
        logger.error(`Failed to patch key: ${key}`, e);
    }
}

/**
 * Deep search utility that finds property names by searching function source code.
 * Explores non-enumerable properties and the prototype chain safely.
 */
function findKeyByCode(mod: any, code: string | RegExp) {
    if (!mod) return undefined;

    const check = (val: any) => {
        if (typeof val !== "function") return false;
        try {
            const str = val.toString();
            return typeof code === "string" ? str.includes(code) : code.test(str);
        } catch { return false; }
    };

    if (check(mod)) return "SELF";

    // Restricted properties in strict mode that crash iteration
    const isRestricted = (key: string) => ["arguments", "caller", "callee"].includes(key);

    // 1. Check direct properties (including non-enumerable)
    const directKeys = Object.getOwnPropertyNames(mod);
    // Prioritize common Discord module structures
    if (directKeys.includes("ZP") && check(mod.ZP)) return "ZP";
    if (directKeys.includes("Z") && check(mod.Z)) return "Z";

    for (const key of directKeys) {
        if (isRestricted(key)) continue;
        try { if (check(mod[key])) return key; } catch { }
    }

    // 2. Check prototype chain
    let proto = Object.getPrototypeOf(mod);
    while (proto && proto !== Object.prototype) {
        const protoKeys = Object.getOwnPropertyNames(proto);
        for (const key of protoKeys) {
            if (isRestricted(key)) continue;
            try { if (check(proto[key])) return key; } catch { }
        }
        proto = Object.getPrototypeOf(proto);
    }

    // 3. Fallback: Search inside exported objects (e.g. mod.ZP.someFunc)
    for (const key of directKeys) {
        if (isRestricted(key)) continue;
        try {
            const val = mod[key];
            if (val && typeof val === "object" && !Array.isArray(val)) {
                const subKeys = Object.getOwnPropertyNames(val);
                for (const subKey of subKeys) {
                    if (isRestricted(subKey)) continue;
                    if (check(val[subKey])) return `${key}.${subKey}`;
                }
            }
        } catch { }
    }

    return undefined;
}

export default definePlugin({
    name: "BypassFileLimit",
    description: "Reimplements YABDP4Nitro's 'clips' bypass to upload large videos (up to 100MB+).",
    authors: [{ name: "Roo", id: 0n }],

    start() {
        logger.info("Starting BypassFileLimit...");
        Native = (window as any).VencordNative.pluginHelpers["BypassFileLimit"];
        if (Native?.initDatabase) Native.initDatabase();

        const patcher = (window as any).Vencord?.Api?.Patcher;

        const UserStore = findByProps("getCurrentUser");
        const ClipsStore = findByProps("isClipsEnabledForUser");
        const UploadManagerMod = findByProps("addFiles");
        const CloudUploaderMod = findByProps("uploadFileToCloud");

        // 1. User Nitro Spoof (Helping client-side size limit UI checks)
        if (UserStore && patcher) {
            logger.info("Spoofing User Nitro Status...");
            patcher.after("BypassFileLimit", UserStore, "getCurrentUser", (_: any, __: any, user: any) => {
                if (user) user.premiumType = 2; // Nitro
            });
        }

        // 2. Clips Enabled Bypass
        const ClipsEnabledMod = find(m => {
            try { return typeof m === "object" && Object.values(m).some(v => typeof v === "function" && v.toString().includes('useEnableClips')); }
            catch { return false; }
        });
        if (ClipsEnabledMod) {
            const useKey = findKeyByCode(ClipsEnabledMod, 'useExperiment({location:"useEnableClips"');
            const areKey = findKeyByCode(ClipsEnabledMod, 'areClipsEnabled');
            logger.info(`Found ClipsEnabledMod keys: { use: ${useKey}, are: ${areKey} }`);

            if (useKey) {
                if (useKey === "SELF" && patcher) patcher.instead("BypassFileLimit", ClipsEnabledMod, "SELF", () => true);
                else monkeyPatch(ClipsEnabledMod, useKey, () => true);
            }
            if (areKey) {
                if (areKey === "SELF" && patcher) patcher.instead("BypassFileLimit", ClipsEnabledMod, "SELF", () => true);
                else monkeyPatch(ClipsEnabledMod, areKey, () => true);
            }
        }

        // 3. Max File Size Bypass (UI/Pre-upload limits)
        const MaxFileSizeMod = find(m => {
            try { return typeof m === "object" && Object.values(m).some(v => typeof v === "function" && v.toString().includes('.premiumTier].limits.fileSize:')); }
            catch { return false; }
        });
        if (MaxFileSizeMod) {
            const getMaxKey = findKeyByCode(MaxFileSizeMod, '.premiumTier].limits.fileSize:');
            const exceedsKey = findKeyByCode(MaxFileSizeMod, /Array\.from\(.*\.size>/) || findKeyByCode(MaxFileSizeMod, ".size>");
            logger.info(`Found MaxFileSizeMod keys: { getMax: ${getMaxKey}, exceeds: ${exceedsKey} }`);

            if (getMaxKey) {
                if (getMaxKey === "SELF" && patcher) patcher.instead("BypassFileLimit", MaxFileSizeMod, "SELF", () => 524288000); // 500MB
                else monkeyPatch(MaxFileSizeMod, getMaxKey, () => 524288000);
            }
            if (exceedsKey) {
                if (exceedsKey === "SELF" && patcher) patcher.instead("BypassFileLimit", MaxFileSizeMod, "SELF", () => false);
                else monkeyPatch(MaxFileSizeMod, exceedsKey, () => false);
            }
        }

        // Separate check for getUserMaxFileSize module (often default Z export)
        const UserMaxFileSizeMod = find(m => {
            try { return typeof m === "object" && Object.values(m).some(v => typeof v === "function" && v.toString().includes('getUserMaxFileSize')); }
            catch { return false; }
        });
        if (UserMaxFileSizeMod) {
            const getUserMaxKey = findKeyByCode(UserMaxFileSizeMod, 'getUserMaxFileSize');
            logger.info(`Found UserMaxFileSizeMod key: ${getUserMaxKey}`);
            if (getUserMaxKey) {
                if (getUserMaxKey === "SELF" && patcher) patcher.instead("BypassFileLimit", UserMaxFileSizeMod, "SELF", () => 524288000);
                else monkeyPatch(UserMaxFileSizeMod, getUserMaxKey, () => 524288000);
            }
        }

        // 4. Clips Store Logic
        if (ClipsStore) {
            logger.info("Patching ClipsStore...");
            monkeyPatch(ClipsStore, "isViewerClippingAllowedForUser", () => true);
            monkeyPatch(ClipsStore, "isClipsEnabledForUser", () => true);
            monkeyPatch(ClipsStore, "isVoiceRecordingAllowedForUser", () => true);
        }

        /**
         * Core logic: Injects Clip metadata into file upload properties.
         */
        const spoofFile = async (fileObj: any) => {
            const file = fileObj.file;
            if (file && file.size > 10 * 1024 * 1024 && file.name.toLowerCase().endsWith(".mp4")) {
                logger.info(`Spoofing large video as clip: ${file.name} (${file.size} bytes)`);
                try {
                    // Extract game name from filename (e.g., "PioneerGame_..." -> "PioneerGame")
                    // Strip spaces to match common exe naming conventions
                    const exeName = file.name.split('_')[0].replace(/\s/g, "");
                    let appId = "1301689862256066560"; // Default to Official Discord Clips App ID

                    if (Native?.findAppId && exeName) {
                        try {
                            const foundId = await Native.findAppId(exeName);
                            if (foundId) {
                                logger.info(`Matched game "${exeName}" to App ID: ${foundId}`);
                                appId = foundId;
                            }
                        } catch (e) {
                            logger.error("Failed to call native findAppId:", e);
                        }
                    }

                    fileObj.clip = {
                        id: ((BigInt(Date.now()) - 1420070400000n) << 22n).toString(), // Snowflake from current timestamp
                        version: 3,
                        applicationName: "",
                        applicationId: appId,
                        users: [UserStore?.getCurrentUser()?.id].filter(Boolean),
                        clipMethod: "manual",
                        length: file.size,
                        thumbnail: "",
                        filepath: "",
                        name: file.name.split(".").slice(0, -1).join(".")
                    };
                    fileObj.platform = 1; // Mark as Desktop
                    logger.info(`Successfully set file upload properties as clip with App ID: ${appId}`);
                } catch (e) {
                    logger.error("Error during clip spoofing:", e);
                }
            }
        };

        // 5. Intercept Uploads via UploadManager (Programmatic path)
        if (UploadManagerMod) {
            logger.info("Patching upload manager functions...");
            const originalAddFiles = UploadManagerMod.addFiles;
            if (originalAddFiles) {
                monkeyPatch(UploadManagerMod, "addFiles", async (args: any) => {
                    logger.info("Intercepted addFiles call", args);
                    if (args?.files) {
                        for (const f of args.files) await spoofFile(f);
                    }
                    return originalAddFiles(args);
                });
            }

            const addFileKey = Object.keys(UploadManagerMod).find(k => k === "addFile" || (typeof UploadManagerMod[k] === "function" && String(UploadManagerMod[k]).includes(".platform=")));
            if (addFileKey && addFileKey !== "addFiles") {
                const originalAddFile = UploadManagerMod[addFileKey];
                monkeyPatch(UploadManagerMod, addFileKey, async (args: any) => {
                    logger.info("Intercepted addFile call", args);
                    await spoofFile(args);
                    return originalAddFile(args);
                });
            }
        }

        // 6. Universal Intercept via CloudUploader prototype (Catch-all path)
        if (CloudUploaderMod?.prototype) {
            logger.info("Patching CloudUploader prototype...");
            const originalCtor = CloudUploaderMod.prototype.constructor;

            monkeyPatch(CloudUploaderMod.prototype, "constructor", function (this: any, item: any, ...args: any[]) {
                if (item?.file && item.file.size > 10 * 1024 * 1024 && item.file.name.toLowerCase().endsWith(".mp4")) {
                    logger.info(`Catch-all spoof for CloudUploader: ${item.file.name}`);
                    spoofFile(item).then(() => {
                        originalCtor.apply(this, [item, ...args]);
                    });
                } else {
                    return originalCtor.apply(this, [item, ...args]);
                }
            });
        }
    },

    stop() {
        (window as any).Vencord?.Api?.Patcher?.unpatchAll("BypassFileLimit");
        logger.info("Stopping BypassFileLimit. Please reload Discord to fully revert patches.");
    }
});