import { app } from "/scripts/app.js";
import { findWidgetByName, QueueExecutionController } from "./modules/utils.js";

const CONTROLLER = Symbol("folderbatchImageQueueController");

app.registerExtension({
    name: "Comfy.FolderBatch.FolderBatchImageQueue",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "FolderBatch Image Queue") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated ? origOnNodeCreated.apply(this) : undefined;
            const startAtWidget = findWidgetByName(this, "start_at");
            const autoQueueWidget = findWidgetByName(this, "auto_queue");
            const queueAllWidget = findWidgetByName(this, "queue_all");

            this[CONTROLLER] = new QueueExecutionController(
                app,
                startAtWidget,
                autoQueueWidget,
                queueAllWidget
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
            this[CONTROLLER]?.remove();
            return onRemoved?.apply(this, arguments);
        };
    },
});
