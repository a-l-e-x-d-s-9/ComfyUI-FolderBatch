import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const utilsPath = new URL("../web/modules/utils.js", import.meta.url);
const utilsSource = await readFile(utilsPath, "utf8");
const utils = await import(`data:text/javascript;base64,${Buffer.from(utilsSource).toString("base64")}`);

function widgets({ startAt = 0, autoQueue = true, queueAll = false } = {}) {
    return {
        startAt: { value: startAt },
        autoQueue: { value: autoQueue },
        queueAll: { value: queueAll },
    };
}

class TestApi extends EventTarget {
    constructor(queued) {
        super();
        this.queued = queued;
        this.calls = [];
    }

    emit(type, detail) {
        const event = new Event(type);
        event.detail = detail;
        this.dispatchEvent(event);
    }

    async clearItems(type) {
        this.calls.push(["clearItems", type]);
        if (type === "queue") this.queued.length = 0;
        return "cleared";
    }

    async interrupt(...args) {
        this.calls.push(["interrupt", ...args]);
    }
}

function fixture({ queueAll = true, queuePrompt } = {}) {
    const queued = [];
    const nodeWidgets = widgets({ queueAll });
    const api = new TestApi(queued);
    utils.installQueueLifecycle(api);
    const controller = new utils.QueueExecutionController(
        { async queuePrompt() {
            queued.push(nodeWidgets.startAt.value);
            await queuePrompt?.();
        } },
        nodeWidgets.startAt,
        nodeWidgets.autoQueue,
        nodeWidgets.queueAll
    );
    return { queued, nodeWidgets, api, controller };
}

{
    const queued = [];
    const nodeWidgets = widgets({ startAt: 1, autoQueue: true, queueAll: true });
    const app = {
        async queuePrompt() {
            queued.push(nodeWidgets.startAt.value);
        },
    };
    const controller = new utils.QueueExecutionController(
        app,
        nodeWidgets.startAt,
        nodeWidgets.autoQueue,
        nodeWidgets.queueAll
    );

    await controller.onExecuted(5, 1);
    assert.deepEqual(queued, [2, 3, 4]);
    assert.equal(nodeWidgets.startAt.value, 4);

    await controller.onExecuted(5, 2);
    await controller.onExecuted(5, 3);
    assert.deepEqual(queued, [2, 3, 4], "queued executions must not recursively duplicate work");

    await controller.onExecuted(5, 4);
    assert.equal(nodeWidgets.startAt.value, 0);
    controller.remove();
}

{
    const queued = [];
    const nodeWidgets = widgets({ autoQueue: true, queueAll: false });
    const app = {
        async queuePrompt() {
            queued.push(nodeWidgets.startAt.value);
        },
    };
    const controller = new utils.QueueExecutionController(
        app,
        nodeWidgets.startAt,
        nodeWidgets.autoQueue,
        nodeWidgets.queueAll
    );

    await controller.onExecuted(3, 0);
    assert.deepEqual(queued, [1], "existing one-ahead auto queue must remain unchanged");
    controller.remove();
}

{
    const queued = [];
    const nodeWidgets = widgets({ autoQueue: false, queueAll: false });
    const app = { async queuePrompt() { queued.push(nodeWidgets.startAt.value); } };
    const controller = new utils.QueueExecutionController(
        app,
        nodeWidgets.startAt,
        nodeWidgets.autoQueue,
        nodeWidgets.queueAll
    );

    await controller.onExecuted(3, 0);
    assert.deepEqual(queued, []);
    assert.equal(nodeWidgets.startAt.value, 1);
    controller.remove();
}

{
    const { queued, nodeWidgets, api, controller } = fixture();
    const wrappedClear = api.clearItems;
    utils.installQueueLifecycle(api);
    assert.equal(api.clearItems, wrappedClear, "install lifecycle hooks only once");
    await controller.onExecuted(6, 0);
    assert.deepEqual(queued, [1, 2, 3, 4, 5]);

    await api.clearItems("history");
    assert.equal(controller.queuedThrough, 5, "clearing history must not reset queue state");
    nodeWidgets.startAt.value = 2;
    assert.equal(await api.clearItems("queue"), "cleared", "preserve the API's return value and receiver");
    assert.equal(nodeWidgets.startAt.value, 2, "clearing must preserve the chosen resume index");
    assert.equal(controller.queuedThrough, -1);

    await controller.onExecuted(6, 5);
    assert.equal(nodeWidgets.startAt.value, 2, "late output from a cancelled run must not overwrite the resume index");
    assert.deepEqual(queued, []);
    api.emit("execution_start", { prompt_id: "resumed" });
    await controller.onExecuted(6, 2);
    assert.deepEqual(queued, [3, 4, 5], "resume queue_all from a nonzero index without recreating the controller");
    controller.remove();
}

{
    const { queued, nodeWidgets, api, controller } = fixture();
    await controller.onExecuted(5, 0);
    api.emit("status", { exec_info: { queue_remaining: 3 } });
    assert.equal(controller.queuedThrough, 4);
    queued.length = 0;
    nodeWidgets.startAt.value = 2;
    api.emit("status", { exec_info: { queue_remaining: 0 } });
    assert.equal(controller.queuedThrough, -1, "an empty server queue must clear stale tracking");
    assert.equal(nodeWidgets.startAt.value, 2);
    api.emit("execution_start", { prompt_id: "resumed" });
    await controller.onExecuted(5, 2);
    assert.deepEqual(queued, [3, 4]);
    controller.remove();
}

{
    const { queued, nodeWidgets, api, controller } = fixture();
    const submission = controller.onExecuted(5, 0);
    api.emit("status", { exec_info: { queue_remaining: 0 } });
    await submission;
    assert.deepEqual(queued, [1, 2, 3, 4], "temporary idle status during the submission delay must not abort a batch");
    nodeWidgets.startAt.value = 3;
    await api.interrupt("current-prompt");
    api.emit("execution_interrupted", { prompt_id: "current-prompt" });
    assert.equal(nodeWidgets.startAt.value, 3);
    api.emit("execution_start", { prompt_id: "already-pending" });
    await controller.onExecuted(5, 1);
    assert.deepEqual(queued, [1, 2, 3, 4], "interrupting the current execution must not duplicate surviving pending prompts");
    await api.clearItems("queue");
    api.emit("execution_start", { prompt_id: "resumed" });
    await controller.onExecuted(5, 3);
    assert.deepEqual(queued, [4]);
    controller.remove();
}

{
    const { queued, nodeWidgets, api, controller } = fixture();
    const submission = controller.onExecuted(5, 0);
    nodeWidgets.startAt.value = 2;
    await api.clearItems("queue");
    await submission;
    assert.deepEqual(queued, [], "cancel during the delay before submissions begin");
    assert.equal(controller.queuedThrough, -1, "a cancelled submission must not restore stale tracking");
    assert.equal(nodeWidgets.startAt.value, 2);
    api.emit("execution_start", { prompt_id: "resumed" });
    await controller.onExecuted(5, 2);
    assert.deepEqual(queued, [3, 4]);
    controller.remove();
}

{
    let releaseSubmission;
    let submissionStarted;
    const inFlight = new Promise((resolve) => { releaseSubmission = resolve; });
    const started = new Promise((resolve) => { submissionStarted = resolve; });
    const { queued, nodeWidgets, api, controller } = fixture({
        async queuePrompt() {
            submissionStarted();
            await inFlight;
        },
    });
    const submission = controller.onExecuted(5, 0);
    await started;
    nodeWidgets.startAt.value = 2;
    const clear = api.clearItems("queue");
    assert.deepEqual(api.calls, [], "wait for the in-flight submission before sending the server clear");
    api.emit("execution_start", { prompt_id: "cancelled-in-flight" });
    await controller.onExecuted(5, 1);
    assert.equal(nodeWidgets.startAt.value, 2, "an execution starting during cancellation must not resume submissions");
    releaseSubmission();
    await Promise.all([submission, clear]);
    assert.deepEqual(queued, [], "no submissions may arrive after the server clear");
    assert.equal(controller.queuedThrough, -1);
    assert.equal(nodeWidgets.startAt.value, 2);
    api.emit("execution_start", { prompt_id: "resumed" });
    await controller.onExecuted(5, 2);
    assert.deepEqual(queued, [3, 4]);
    controller.remove();
}

{
    const { queued, nodeWidgets, api, controller } = fixture();
    const submission = controller.onExecuted(5, 0);
    nodeWidgets.startAt.value = 2;
    await api.interrupt("current-prompt");
    assert.deepEqual(api.calls, [["interrupt", "current-prompt"]], "interrupt the current execution without waiting for submissions");
    api.emit("status", { exec_info: { queue_remaining: 0 } });
    await submission;
    assert.equal(controller.queuedThrough, -1, "idle after interrupt must reset tracking even while an aborted delay is settling");
    api.emit("execution_start", { prompt_id: "resumed" });
    await controller.onExecuted(5, 2);
    assert.deepEqual(queued, [3, 4]);
    controller.remove();
}

{
    let rejectSubmission;
    let submissionStarted;
    const failed = new Promise((_, reject) => { rejectSubmission = reject; });
    const started = new Promise((resolve) => { submissionStarted = resolve; });
    const { api, controller } = fixture({
        queueAll: false,
        async queuePrompt() {
            submissionStarted();
            await failed;
        },
    });
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args);
    try {
        const submission = controller.onExecuted(5, 0);
        await started;
        const clear = api.clearItems("queue");
        rejectSubmission(new Error("test submission failed"));
        await Promise.all([submission, clear]);
        assert.deepEqual(api.calls, [["clearItems", "queue"]], "submission failure must not prevent clearing the server queue");
        assert.equal(errors.length, 1);
        assert.equal(controller.queuedThrough, -1);
    } finally {
        console.error = originalError;
        controller.remove();
    }
}

{
    let controller;
    const queued = [];
    const nodeWidgets = widgets({ queueAll: true });
    controller = new utils.QueueExecutionController(
        { async queuePrompt() {
            const index = nodeWidgets.startAt.value;
            queued.push(index);
            await controller.onExecuted(5, index);
        } },
        nodeWidgets.startAt, nodeWidgets.autoQueue, nodeWidgets.queueAll
    );
    await controller.onExecuted(5, 0);
    assert.deepEqual(queued, [1, 2, 3, 4], "executions during submission must not recursively duplicate the batch");
    assert.equal(controller.queuedThrough, -1, "late submission completion must not restore tracking after the last execution");
    assert.equal(nodeWidgets.startAt.value, 0);
    controller.remove();
}

{
    const { queued, nodeWidgets, api, controller } = fixture({ queueAll: false });
    const submission = controller.onExecuted(5, 0);
    nodeWidgets.startAt.value = 2;
    await api.clearItems("queue");
    await submission;
    assert.deepEqual(queued, [], "cancellation must also stop delayed one-ahead auto queue");
    assert.equal(nodeWidgets.startAt.value, 2);
    controller.remove();
}

{
    const { queued, api, controller } = fixture();
    await controller.onExecuted(5, 0);
    controller.remove();
    api.emit("status", { exec_info: { queue_remaining: 0 } });
    api.emit("execution_start", { prompt_id: "after-removal" });
    await controller.onExecuted(5, 1);
    assert.deepEqual(queued, [1, 2, 3, 4], "removed controllers must not resume on API events");
}

const frontendFiles = [
    "folderbatch_image_queue.js",
    "folderbatch_video_queue.js",
    "folderbatch_audio_queue.js",
    "folderbatch_text_queue.js",
    "folderbatch_sync_queue.js",
];
for (const filename of frontendFiles) {
    const source = await readFile(new URL(`../web/${filename}`, import.meta.url), "utf8");
    assert.match(source, /findWidgetByName\(this, "queue_all"\)/, `${filename} lacks queue_all`);
    assert.match(source, /QueueExecutionController/, `${filename} lacks the shared controller`);
}

const backend = await readFile(
    new URL("../nodes/folder_batch_nodes.py", import.meta.url),
    "utf8"
);
assert.equal((backend.match(/"queue_all": \("BOOLEAN", \{"default": False\}\)/g) || []).length, 5);

const lifecycle = await readFile(new URL("../web/folderbatch_queue_lifecycle.js", import.meta.url), "utf8");
{
    const api = new TestApi([]);
    let extension;
    const app = { registerExtension(value) { extension = value; } };
    // Execute the extension registration with ComfyUI's imports supplied by the fixture.
    const register = new Function("app", "api", "installQueueLifecycle", lifecycle.replace(/^import .*;\n/gm, ""));
    register(app, api, utils.installQueueLifecycle);
    assert.equal(extension.name, "Comfy.FolderBatch.QueueLifecycle");
    const originalClear = api.clearItems;
    extension.setup();
    assert.notEqual(api.clearItems, originalClear, "ComfyUI setup must install the cancellation hooks");
}

console.log("queue-all tests passed");
