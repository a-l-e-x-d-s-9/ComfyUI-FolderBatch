export function findWidgetByName(node, name) {
    if (!node || !node.widgets) {
        return null;
    }
    return node.widgets.find((w) => w.name === name);
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let queuePromptOwner = null;
let pendingQueuePrompt = null;
let pendingQueuePromptMode = null;

function claimQueuePromptOwner(owner) {
    if (queuePromptOwner === null) {
        queuePromptOwner = owner;
    }

    return queuePromptOwner === owner;
}

export function releaseQueuePromptOwner(owner) {
    if (queuePromptOwner === owner) {
        queuePromptOwner = null;
    }
}

export async function scheduleQueuePrompt(app, owner, shouldQueue, delayMs = 200) {
    if (!claimQueuePromptOwner(owner)) {
        return false;
    }

    if (pendingQueuePrompt) {
        return pendingQueuePrompt;
    }

    const scheduledOwner = owner;
    const request = (async () => {
        await sleep(delayMs);
        if (queuePromptOwner !== scheduledOwner) {
            return false;
        }
        if (!shouldQueue()) {
            releaseQueuePromptOwner(scheduledOwner);
            return false;
        }
        await app.queuePrompt(0, 1);
        return true;
    })();
    pendingQueuePrompt = request;
    pendingQueuePromptMode = "single";

    try {
        return await request;
    } catch (error) {
        releaseQueuePromptOwner(scheduledOwner);
        console.error("FolderBatch failed to queue the next prompt.", error);
        return false;
    } finally {
        if (pendingQueuePrompt === request) {
            pendingQueuePrompt = null;
            pendingQueuePromptMode = null;
        }
    }
}

export async function scheduleAllQueuePrompts(
    app,
    owner,
    startAtWidget,
    shouldQueue,
    startAt,
    queueCount,
    delayMs = 200
) {
    if (!claimQueuePromptOwner(owner)) {
        return { lastQueued: startAt, completed: false };
    }

    if (pendingQueuePrompt) {
        const pendingMode = pendingQueuePromptMode;
        const result = await pendingQueuePrompt;
        return pendingMode === "all"
            ? result
            : { lastQueued: startAt, completed: false };
    }

    const scheduledOwner = owner;
    const request = (async () => {
        let lastQueued = startAt;
        await sleep(delayMs);

        try {
            for (let index = startAt + 1; index < queueCount; index += 1) {
                if (queuePromptOwner !== scheduledOwner || !shouldQueue()) {
                    releaseQueuePromptOwner(scheduledOwner);
                    return { lastQueued, completed: false };
                }

                startAtWidget.value = index;
                await app.queuePrompt(0, 1);
                lastQueued = index;
            }
            return { lastQueued, completed: true };
        } catch (error) {
            releaseQueuePromptOwner(scheduledOwner);
            console.error("FolderBatch failed to queue all remaining prompts.", error);
            return { lastQueued, completed: false };
        }
    })();
    pendingQueuePrompt = request;
    pendingQueuePromptMode = "all";

    try {
        return await request;
    } finally {
        if (pendingQueuePrompt === request) {
            pendingQueuePrompt = null;
            pendingQueuePromptMode = null;
        }
    }
}

export class QueueExecutionController {
    constructor(app, startAtWidget, autoQueueWidget, queueAllWidget) {
        this.app = app;
        this.startAtWidget = startAtWidget;
        this.autoQueueWidget = autoQueueWidget;
        this.queueAllWidget = queueAllWidget;
        this.queuedThrough = -1;
    }

    async onExecuted(queueCount, startAt) {
        const nextIndex = startAt + 1;
        if (nextIndex >= queueCount) {
            this.queuedThrough = -1;
            releaseQueuePromptOwner(this);
            this.startAtWidget.value = 0;
            return;
        }

        this.startAtWidget.value = nextIndex;
        if (this.queuedThrough >= nextIndex) {
            return;
        }

        if (this.queueAllWidget.value) {
            const result = await scheduleAllQueuePrompts(
                this.app,
                this,
                this.startAtWidget,
                () => this.queueAllWidget.value,
                startAt,
                queueCount
            );
            this.queuedThrough = Math.max(this.queuedThrough, result.lastQueued);
            return;
        }

        this.queuedThrough = -1;
        if (this.autoQueueWidget.value) {
            await scheduleQueuePrompt(this.app, this, () => this.autoQueueWidget.value);
        } else {
            releaseQueuePromptOwner(this);
        }
    }

    remove() {
        releaseQueuePromptOwner(this);
    }
}
