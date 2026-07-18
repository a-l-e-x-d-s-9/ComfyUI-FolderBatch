export function findWidgetByName(node, name) {
    if (!node || !node.widgets) {
        return null;
    }
    return node.widgets.find((w) => w.name === name);
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LatestJsonRequest {
    abortController = null;

    cancel() {
        this.abortController?.abort();
        this.abortController = null;
    }

    async get(url) {
        this.cancel();
        const abortController = new AbortController();
        this.abortController = abortController;

        try {
            const response = await fetch(url, { signal: abortController.signal });
            if (!response.ok) {
                throw new Error(`Request failed with status ${response.status}`);
            }

            const data = await response.json();
            if (this.abortController !== abortController) {
                return null;
            }
            return data;
        } catch (error) {
            if (error.name !== "AbortError") {
                console.error("FolderBatch request failed.", error);
            }
            return null;
        } finally {
            if (this.abortController === abortController) {
                this.abortController = null;
            }
        }
    }
}

let queuePromptOwner = null;
let pendingQueuePrompt = null;

export function releaseQueuePromptOwner(owner) {
    if (queuePromptOwner === owner) {
        queuePromptOwner = null;
    }
}

export async function scheduleQueuePrompt(app, owner, shouldQueue, delayMs = 200) {
    if (queuePromptOwner === null) {
        queuePromptOwner = owner;
    }

    if (queuePromptOwner !== owner) {
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

    try {
        return await request;
    } catch (error) {
        releaseQueuePromptOwner(scheduledOwner);
        console.error("FolderBatch failed to queue the next prompt.", error);
        return false;
    } finally {
        if (pendingQueuePrompt === request) {
            pendingQueuePrompt = null;
        }
    }
}
