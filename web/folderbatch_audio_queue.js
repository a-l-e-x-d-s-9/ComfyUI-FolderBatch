import { app } from "/scripts/app.js";
import { findWidgetByName, releaseQueuePromptOwner, scheduleQueuePrompt } from "./modules/utils.js";

const CONTROLLER = Symbol("folderbatchAudioQueueController");

class FolderBatchAudioQueue {
    startAtWidget;
    autoQueueWidget;

    async onExecuted(queueCount, startAt) {
        if (startAt + 1 < queueCount) {
            this.startAtWidget.value = startAt + 1;

            if (this.autoQueueWidget.value) {
                await scheduleQueuePrompt(app, this, () => this.autoQueueWidget.value);
            } else {
                releaseQueuePromptOwner(this);
            }
        } else if (startAt + 1 >= queueCount) {
            releaseQueuePromptOwner(this);
            this.startAtWidget.value = 0;
        }
    }

    initWidget(startAtWidget, autoQueueWidget) {
        this.startAtWidget = startAtWidget;
        this.autoQueueWidget = autoQueueWidget;
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

            const startAtWidget = findWidgetByName(this, "start_at");
            const autoQueueWidget = findWidgetByName(this, "auto_queue");

            folderAudioQueue.initWidget(
                startAtWidget,
                autoQueueWidget
            );

            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = async function (message) {
            onExecuted?.apply(this, arguments);

            const queueCount = message["queue_count"][0];
            const startAt = message["start_at"][0];
            this[CONTROLLER]?.onExecuted(queueCount, startAt);
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            const controller = this[CONTROLLER];
            releaseQueuePromptOwner(controller);
            return onRemoved?.apply(this, arguments);
        };
    },
});
