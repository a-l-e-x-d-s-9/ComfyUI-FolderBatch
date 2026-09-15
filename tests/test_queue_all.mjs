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

console.log("queue-all tests passed");
