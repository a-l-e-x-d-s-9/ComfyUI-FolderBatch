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
const queueControllers = new Set();
const lifecycleApis = new WeakSet();

// A clear must stop submissions before clearing the server queue, otherwise an
// in-flight submission could arrive after the clear and leave a prompt behind.
export function installQueueLifecycle(api) {
    if (lifecycleApis.has(api)) return;
    lifecycleApis.add(api);
    let cancelling = 0;

    const stop = (clearQueued) => {
        for (const controller of queueControllers) {
            controller.stop(clearQueued);
        }
        return pendingQueuePrompt;
    };

    api.addEventListener("execution_start", () => {
        if (cancelling === 0) {
            for (const controller of queueControllers) controller.suspended = false;
        }
    });
    api.addEventListener("execution_interrupted", () => stop(false));
    api.addEventListener("execution_error", () => stop(false));
    api.addEventListener("status", (event) => {
        // A short workflow may finish before the delayed submissions begin.
        // Keep that active submission loop alive through a temporary empty queue.
        if (event.detail?.exec_info?.queue_remaining === 0 &&
            (!pendingQueuePrompt || queuePromptOwner === null)) {
            stop(true);
        }
    });

    for (const [name, shouldStop, clearQueued] of [
        ["clearItems", (type) => type === "queue", true],
        ["interrupt", () => true, false],
    ]) {
        const original = api[name];
        if (typeof original !== "function") continue;
        api[name] = async function (...args) {
            if (!shouldStop(...args)) return original.apply(this, args);
            cancelling += 1;
            try {
                const pending = stop(clearQueued);
                if (clearQueued && pending) await pending.catch(() => {});
                return await original.apply(this, args);
            } finally {
                cancelling -= 1;
            }
        };
    }
}

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
        await pendingQueuePrompt.catch(() => {});
        if (!shouldQueue()) return false;
        return scheduleQueuePrompt(app, owner, shouldQueue, delayMs);
    }

    const scheduledOwner = owner;
    const generation = owner.generation;
    const request = (async () => {
        await sleep(delayMs);
        if (queuePromptOwner !== scheduledOwner || owner.generation !== generation) {
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

    try {
        return await request;
    } catch (error) {
        if (owner.generation === generation) releaseQueuePromptOwner(scheduledOwner);
        console.error("FolderBatch failed to queue the next prompt.", error);
        return false;
    } finally {
        if (pendingQueuePrompt === request) {
            pendingQueuePrompt = null;
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
        await pendingQueuePrompt.catch(() => {});
        if (!shouldQueue()) return { lastQueued: startAt, completed: false };
        return scheduleAllQueuePrompts(app, owner, startAtWidget, shouldQueue, startAt, queueCount, delayMs);
    }

    const scheduledOwner = owner;
    const generation = owner.generation;
    const request = (async () => {
        let lastQueued = startAt;
        await sleep(delayMs);

        try {
            for (let index = startAt + 1; index < queueCount; index += 1) {
                if (queuePromptOwner !== scheduledOwner || owner.generation !== generation) {
                    return { lastQueued, completed: false };
                }
                if (!shouldQueue()) {
                    releaseQueuePromptOwner(scheduledOwner);
                    return { lastQueued, completed: false };
                }

                startAtWidget.value = index;
                await app.queuePrompt(0, 1);
                lastQueued = index;
            }
            return { lastQueued, completed: true };
        } catch (error) {
            if (owner.generation === generation) releaseQueuePromptOwner(scheduledOwner);
            console.error("FolderBatch failed to queue all remaining prompts.", error);
            return { lastQueued, completed: false };
        }
    })();
    pendingQueuePrompt = request;

    try {
        return await request;
    } finally {
        if (pendingQueuePrompt === request) {
            pendingQueuePrompt = null;
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
        this.generation = 0;
        this.suspended = false;
        queueControllers.add(this);
    }

    stop(clearQueued = true) {
        this.generation += 1;
        this.suspended = true;
        if (clearQueued) this.queuedThrough = -1;
        releaseQueuePromptOwner(this);
    }

    async onExecuted(queueCount, startAt) {
        // Ignore late output from the execution that was just cancelled.
        if (this.suspended) return;
        const generation = this.generation;
        const isActive = () => this.generation === generation && !this.suspended;
        const nextIndex = startAt + 1;
        if (nextIndex >= queueCount) {
            this.stop();
            this.suspended = false;
            this.startAtWidget.value = 0;
            return;
        }

        if (this.queuedThrough >= nextIndex) {
            return;
        }
        this.startAtWidget.value = nextIndex;

        if (this.queueAllWidget.value) {
            // Reserve the range before awaiting submissions. Executions can
            // finish while the browser is still adding the rest of the batch.
            this.queuedThrough = queueCount - 1;
            const result = await scheduleAllQueuePrompts(
                this.app,
                this,
                this.startAtWidget,
                () => isActive() && this.queueAllWidget.value,
                startAt,
                queueCount
            );
            if (isActive()) this.queuedThrough = result.lastQueued;
            return;
        }

        this.queuedThrough = -1;
        if (this.autoQueueWidget.value) {
            await scheduleQueuePrompt(this.app, this, () => isActive() && this.autoQueueWidget.value);
        } else {
            releaseQueuePromptOwner(this);
        }
    }

    remove() {
        this.stop();
        queueControllers.delete(this);
    }
}
