import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { installQueueLifecycle } from "./modules/utils.js";

app.registerExtension({
    name: "Comfy.FolderBatch.QueueLifecycle",
    setup() {
        installQueueLifecycle(api);
    },
});
