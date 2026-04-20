import { Logger } from "@utils/Logger";
import { findByProps } from "@webpack";
import definePlugin, { PluginNative } from "@utils/types";

const logger = new Logger("BypassFileLimit");
let Native: PluginNative<typeof import("./native")>;

export default definePlugin({
    name: "BypassFileLimit",
    description: "Bypasses Discord file size limits for videos by uploading them as clips using magic-byte injection. Just drag and drop large MP4s.",
    authors: [{ name: "Roo", id: 0n }],

    start() {
        logger.info("Starting BypassFileLimit...");
        Native = (window as any).VencordNative?.pluginHelpers?.["BypassFileLimit"];
        if (Native?.initDatabase) Native.initDatabase();

        const SelectedChannelStore = findByProps("getCurrentlySelectedChannelId");
        const UserStore = findByProps("getCurrentUser");
        const TokenStore = findByProps("getToken");
        const Toasts = findByProps("showToast", "createToast");

        function showToast(title: string, type: number = 0) {
            if (Toasts) {
                Toasts.showToast(Toasts.createToast(title, type));
            } else {
                logger.info(`Toast: ${title}`);
            }
        }

        async function apiRequest(method: string, path: string, body?: any) {
            const token = TokenStore?.getToken();
            const url = `https://discord.com/api/v9${path}`;
            
            const res = await fetch(url, {
                method,
                headers: {
                    "Authorization": token,
                    "Content-Type": "application/json",
                },
                body: body ? JSON.stringify(body) : undefined
            });

            if (!res.ok) {
                const text = await res.text();
                throw new Error(`API Error ${res.status}: ${text.substring(0, 100)}`);
            }

            return res.json();
        }

        async function uploadAsClip(file: File, channelId: string) {
            if (!channelId) {
                showToast("Error: No channel detected", 2);
                return;
            }

            const fileName = file.name;
            logger.info(`Processing ${fileName} for bypass...`);
            showToast(`[1/5] Initializing: ${fileName}`, 0);

            const exeName = fileName.split('_')[0].replace(/\s/g, "");
            let appId = "1301689862256066560"; // Default App ID

            if (Native?.findAppId && exeName) {
                try {
                    const foundId = await Native.findAppId(exeName);
                    if (foundId) appId = foundId;
                } catch (e) {}
            }

            const currentUser = UserStore?.getCurrentUser();
            const createdAt = new Date().toISOString();
            const title = fileName.split('.')[0];

            let tempPath = "";
            try {
                // 1. Process via Native bridge for Magic Byte injection
                const rawBuffer = await file.arrayBuffer();
                if (!Native?.createTempClip) throw new Error("Native helper not found!");
                
                showToast(`[2/5] Injecting Metadata...`, 0);
                tempPath = await Native.createTempClip(rawBuffer);
                
                // 2. Read back processed buffer
                if (!Native?.finalizeTempClip) throw new Error("Native helper missing!");
                const taggedBuffer = await Native.finalizeTempClip(tempPath);
                tempPath = "";

                // 3. Request Attachment URL
                showToast(`[3/5] Requesting Discord Upload Slot...`, 0);
                const attachmentData = await apiRequest("POST", `/channels/${channelId}/attachments`, {
                    files: [{
                        filename: fileName,
                        file_size: taggedBuffer.byteLength,
                        id: "1",
                        is_clip: true,
                        is_spoiler: false,
                        is_remix: false,
                        is_thumbnail: false,
                        clip_created_at: createdAt,
                        clip_participant_ids: [currentUser?.id].filter(Boolean),
                        title: title,
                        application_id: appId
                    }]
                });

                const attachment = attachmentData.attachments[0];

                // 4. Upload Tagged Binary
                showToast(`[4/5] Uploading to Cloud Storage...`, 0);
                const uploadRes = await fetch(attachment.upload_url, {
                    method: "PUT",
                    body: taggedBuffer,
                    mode: "cors"
                });
                if (!uploadRes.ok) throw new Error("Cloud binary upload failed.");

                // 5. Finalize Message
                showToast(`[5/5] Finalizing Message...`, 0);
                await apiRequest("POST", `/channels/${channelId}/messages`, {
                    content: "",
                    attachments: [{
                        id: "0",
                        filesize: taggedBuffer.byteLength,
                        filename: fileName,
                        uploaded_filename: attachment.upload_filename,
                        is_clip: true,
                        is_spoiler: false,
                        is_remix: false,
                        is_thumbnail: false,
                        clip_created_at: createdAt,
                        clip_participant_ids: [currentUser?.id].filter(Boolean),
                        title: title,
                        application_id: appId
                    }]
                });

                showToast(`✅ Successfully uploaded: ${fileName}`, 1);
                logger.info("Upload complete!");

            } catch (err: any) {
                logger.error("Upload failed:", err);
                showToast(`❌ Upload failed: ${err.message || "Unknown error"}`, 2);
                if (tempPath && Native?.finalizeTempClip) {
                    await Native.finalizeTempClip(tempPath);
                }
            }
        }

        const handleFiles = (files: FileList | null) => {
            if (!files || files.length === 0) return false;
            const channelId = SelectedChannelStore?.getCurrentlySelectedChannelId();
            
            let handled = false;
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                // Intercept any MP4 file over 25MB (standard Discord limit)
                if (file.name.toLowerCase().endsWith(".mp4") && file.size > 25 * 1024 * 1024) {
                    uploadAsClip(file, channelId);
                    handled = true;
                }
            }
            return handled;
        };

        this.dropHandler = (e: DragEvent) => {
            if (handleFiles(e.dataTransfer?.files || null)) {
                e.preventDefault();
                e.stopPropagation();
            }
        };

        window.addEventListener('drop', this.dropHandler, true);
    },

    stop() {
        window.removeEventListener('drop', this.dropHandler, true);
        logger.info("Stopped BypassFileLimit.");
    }
});