import { app } from "/scripts/app.js";
import { findWidgetByName, QueueExecutionController } from "./modules/utils.js";

const HIDDEN_TAG = "folderbatch_hidden";
const CONTROLLER = Symbol("folderbatchTextQueueController");

function setWidgetHidden(widget, hidden) {
    if (!widget) {
        return;
    }

    if (!widget[HIDDEN_TAG]) {
        widget[HIDDEN_TAG] = {
            computeSize: widget.computeSize,
            type: widget.type,
        };
    }

    if (hidden) {
        widget.computeSize = () => [0, -4];
        widget.type = "hidden";
    } else {
        widget.computeSize = widget[HIDDEN_TAG].computeSize;
        widget.type = widget[HIDDEN_TAG].type;
    }
}

class FolderBatchTextQueue {
    sourceModeWidget;
    unitModeWidget;
    folderWidget;
    textPathWidget;
    extensionWidget;
    skipEmptyLinesWidget;
    executionController;

    normalizeModes() {
        if (this.sourceModeWidget.value === "file" && this.unitModeWidget.value !== "line") {
            this.unitModeWidget.value = "line";
        }
    }

    refreshWidgetVisibility(node) {
        const isFileMode = this.sourceModeWidget.value === "file";
        const isLineMode = this.unitModeWidget.value === "line";

        setWidgetHidden(this.folderWidget, isFileMode);
        setWidgetHidden(this.textPathWidget, !isFileMode);
        setWidgetHidden(this.extensionWidget, isFileMode);
        setWidgetHidden(this.skipEmptyLinesWidget, !isLineMode);

        if (this.unitModeWidget) {
            this.unitModeWidget.disabled = isFileMode;
        }

        if (node?.computeSize) {
            const size = node.computeSize();
            node.setSize([
                Math.max(size[0], node.size[0]),
                Math.max(size[1], node.size[1]),
            ]);
        }
    }

    async onExecuted(queueCount, startAt) {
        await this.executionController.onExecuted(queueCount, startAt);
    }

    initWidget(node, sourceModeWidget, unitModeWidget, folderWidget, textPathWidget, extensionWidget, startAtWidget, autoQueueWidget, queueAllWidget, skipEmptyLinesWidget) {
        this.sourceModeWidget = sourceModeWidget;
        this.unitModeWidget = unitModeWidget;
        this.folderWidget = folderWidget;
        this.textPathWidget = textPathWidget;
        this.extensionWidget = extensionWidget;
        this.skipEmptyLinesWidget = skipEmptyLinesWidget;
        this.executionController = new QueueExecutionController(
            app,
            startAtWidget,
            autoQueueWidget,
            queueAllWidget
        );

        sourceModeWidget.callback = () => {
            this.normalizeModes();
            this.refreshWidgetVisibility(node);
        };
        unitModeWidget.callback = () => {
            this.normalizeModes();
            this.refreshWidgetVisibility(node);
        };

        setTimeout(() => {
            this.normalizeModes();
            this.refreshWidgetVisibility(node);
        }, 100);
    }

    remove() {
        this.executionController.remove();
    }
}

app.registerExtension({
    name: "Comfy.FolderBatch.FolderBatchTextQueue",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "FolderBatch Text Queue") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated ? origOnNodeCreated.apply(this) : undefined;
            const folderTextQueue = new FolderBatchTextQueue();
            this[CONTROLLER] = folderTextQueue;

            const sourceModeWidget = findWidgetByName(this, "source_mode");
            const unitModeWidget = findWidgetByName(this, "unit_mode");
            const folderWidget = findWidgetByName(this, "folder");
            const textPathWidget = findWidgetByName(this, "text_path");
            const extensionWidget = findWidgetByName(this, "extension");
            const startAtWidget = findWidgetByName(this, "start_at");
            const autoQueueWidget = findWidgetByName(this, "auto_queue");
            const queueAllWidget = findWidgetByName(this, "queue_all");
            const skipEmptyLinesWidget = findWidgetByName(this, "skip_empty_lines");

            folderTextQueue.initWidget(
                this,
                sourceModeWidget,
                unitModeWidget,
                folderWidget,
                textPathWidget,
                extensionWidget,
                startAtWidget,
                autoQueueWidget,
                queueAllWidget,
                skipEmptyLinesWidget
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
