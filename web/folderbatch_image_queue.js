import { app } from "/scripts/app.js";
import { findWidgetByName, LatestJsonRequest, releaseQueuePromptOwner, scheduleQueuePrompt } from "./modules/utils.js";

const API_BASE_URL = "/folderbatch/image-queue/";
const CONTROLLER = Symbol("folderbatchImageQueueController");

class FolderBatchImageQueue {
    folderWidget;
    extensionWidget;
    startAtWidget;
    imageCountWidget;
    autoQueueWidget;
    progressWidget;
    imageCount = 0;
    countRequest = new LatestJsonRequest();

    async getImageCount() {
        const folder = encodeURIComponent(this.folderWidget.value ?? "");
        const extension = encodeURIComponent(this.extensionWidget.value ?? "");
        const url = API_BASE_URL + `get_image_count?folder=${folder}&extension=${extension}`;
        const data = await this.countRequest.get(url);

        if (data !== null) {
            const count = Number.parseInt(data["image_count"], 10);
            this.imageCount = Number.isFinite(count) ? count : 0;
        }
        return this.imageCount;
    }

    refreshImageCount() {
        if (this.imageCountWidget) {
            this.imageCountWidget.value = this.imageCount;
        }
    }

    refreshProgress(startAt) {
        if (this.progressWidget && this.imageCount > 0) {
            this.progressWidget.value = (startAt + 1) / this.imageCount;
        }
    }

    async onExecuted(imageCount, startAt) {
        if (startAt + 1 < imageCount) {
            this.startAtWidget.value = startAt + 1;
            this.refreshProgress(startAt);

            if (this.autoQueueWidget.value) {
                await scheduleQueuePrompt(app, this, () => this.autoQueueWidget.value);
            } else {
                releaseQueuePromptOwner(this);
            }
        } else if (startAt + 1 >= imageCount) {
            releaseQueuePromptOwner(this);
            this.startAtWidget.value = 0;
            if (this.progressWidget) {
                this.progressWidget.value = 0;
            }
        }
    }

    initWidget(folderWidget, extensionWidget, startAtWidget, imageCountWidget, autoQueueWidget, progressWidget) {
        this.folderWidget = folderWidget;
        this.extensionWidget = extensionWidget;
        this.startAtWidget = startAtWidget;
        this.imageCountWidget = imageCountWidget;
        this.autoQueueWidget = autoQueueWidget;
        this.progressWidget = progressWidget;

        folderWidget.callback = async () => {
            await this.getImageCount();
            this.refreshImageCount();
        };
        extensionWidget.callback = async () => {
            await this.getImageCount();
            this.refreshImageCount();
        };

        setTimeout(async () => {
            await this.getImageCount();
            this.refreshImageCount();
        }, 100);
    }
}

app.registerExtension({
    name: "Comfy.FolderBatch.FolderBatchImageQueue",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "FolderBatch Image Queue") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated ? origOnNodeCreated.apply(this) : undefined;
            const folderImageQueue = new FolderBatchImageQueue();
            this[CONTROLLER] = folderImageQueue;

            const folderWidget = findWidgetByName(this, "folder");
            const extensionWidget = findWidgetByName(this, "extension");
            const startAtWidget = findWidgetByName(this, "start_at");
            const autoQueueWidget = findWidgetByName(this, "auto_queue");
            const imageCountWidget = findWidgetByName(this, "image_count");
            const progressWidget = findWidgetByName(this, "progress");

            folderImageQueue.initWidget(
                folderWidget,
                extensionWidget,
                startAtWidget,
                imageCountWidget,
                autoQueueWidget,
                progressWidget
            );

            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = async function (message) {
            onExecuted?.apply(this, arguments);

            const imageCount = message["image_count"][0];
            const startAt = message["start_at"][0];
            this[CONTROLLER]?.onExecuted(imageCount, startAt);
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
