import { app } from "/scripts/app.js";
import { findWidgetByName, LatestJsonRequest, releaseQueuePromptOwner, scheduleQueuePrompt } from "./modules/utils.js";

const API_BASE_URL = "/folderbatch/audio-queue/";
const CONTROLLER = Symbol("folderbatchAudioQueueController");

class FolderBatchAudioQueue {
    folderWidget;
    extensionWidget;
    startAtWidget;
    audioCountWidget;
    autoQueueWidget;
    progressWidget;
    audioCount = 0;
    countRequest = new LatestJsonRequest();

    async getAudioCount() {
        const folder = encodeURIComponent(this.folderWidget.value ?? "");
        const extension = encodeURIComponent(this.extensionWidget.value ?? "");
        const url = API_BASE_URL + `get_audio_count?folder=${folder}&extension=${extension}`;
        const data = await this.countRequest.get(url);

        if (data !== null) {
            const count = Number.parseInt(data["audio_count"], 10);
            this.audioCount = Number.isFinite(count) ? count : 0;
        }
        return this.audioCount;
    }

    refreshAudioCount() {
        if (this.audioCountWidget) {
            this.audioCountWidget.value = this.audioCount;
        }
    }

    refreshProgress(startAt) {
        if (this.progressWidget && this.audioCount > 0) {
            this.progressWidget.value = (startAt + 1) / this.audioCount;
        }
    }

    async onExecuted(audioCount, startAt) {
        if (startAt + 1 < audioCount) {
            this.startAtWidget.value = startAt + 1;
            this.refreshProgress(startAt);

            if (this.autoQueueWidget.value) {
                await scheduleQueuePrompt(app, this, () => this.autoQueueWidget.value);
            } else {
                releaseQueuePromptOwner(this);
            }
        } else if (startAt + 1 >= audioCount) {
            releaseQueuePromptOwner(this);
            this.startAtWidget.value = 0;
            if (this.progressWidget) {
                this.progressWidget.value = 0;
            }
        }
    }

    initWidget(folderWidget, extensionWidget, startAtWidget, audioCountWidget, autoQueueWidget, progressWidget) {
        this.folderWidget = folderWidget;
        this.extensionWidget = extensionWidget;
        this.startAtWidget = startAtWidget;
        this.audioCountWidget = audioCountWidget;
        this.autoQueueWidget = autoQueueWidget;
        this.progressWidget = progressWidget;

        folderWidget.callback = async () => {
            await this.getAudioCount();
            this.refreshAudioCount();
        };
        extensionWidget.callback = async () => {
            await this.getAudioCount();
            this.refreshAudioCount();
        };

        setTimeout(async () => {
            await this.getAudioCount();
            this.refreshAudioCount();
        }, 100);
    }
}

app.registerExtension({
    name: "Comfy.FolderBatch.FolderBatchAudioQueue",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "FolderBatch Audio Queue") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated ? origOnNodeCreated.apply(this) : undefined;
            const folderAudioQueue = new FolderBatchAudioQueue();
            this[CONTROLLER] = folderAudioQueue;

            const folderWidget = findWidgetByName(this, "folder");
            const extensionWidget = findWidgetByName(this, "extension");
            const startAtWidget = findWidgetByName(this, "start_at");
            const autoQueueWidget = findWidgetByName(this, "auto_queue");
            const audioCountWidget = findWidgetByName(this, "audio_count");
            const progressWidget = findWidgetByName(this, "progress");

            folderAudioQueue.initWidget(
                folderWidget,
                extensionWidget,
                startAtWidget,
                audioCountWidget,
                autoQueueWidget,
                progressWidget
            );

            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = async function (message) {
            onExecuted?.apply(this, arguments);

            const audioCount = message["audio_count"][0];
            const startAt = message["start_at"][0];
            this[CONTROLLER]?.onExecuted(audioCount, startAt);
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            const controller = this[CONTROLLER];
            releaseQueuePromptOwner(controller);
            controller?.countRequest.cancel();
            return onRemoved?.apply(this, arguments);
        };
    },
});
