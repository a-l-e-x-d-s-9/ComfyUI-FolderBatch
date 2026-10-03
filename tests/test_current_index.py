"""Exercise queue nodes without requiring ComfyUI or media decoding packages."""

import ast
import glob
import os
from pathlib import Path
import random
import tempfile
import unittest


SOURCE_PATH = Path(__file__).resolve().parents[1] / "nodes" / "folder_batch_nodes.py"
source = ast.parse(SOURCE_PATH.read_text(encoding="utf-8"))
# Load the actual queue classes and their helpers; omit media loaders and server routes.
definitions = []
for definition in source.body:
    if isinstance(definition, ast.FunctionDef) and definition.name != "load_audio_file":
        definitions.append(definition)
    elif isinstance(definition, ast.ClassDef) and definition.name.startswith("FB_Folder"):
        definitions.append(definition)
namespace = {"os": os, "glob": glob, "random": random}
exec(compile(ast.Module(body=definitions, type_ignores=[]), str(SOURCE_PATH), "exec"), namespace)

CASES = [
    ("Image", {}, "image_limit", ("image_path", "file_name", "image_count", "progress")),
    ("Video", {}, "video_limit", ("video_path", "file_name", "video_count", "progress")),
    ("Audio", {}, "audio_limit", ("audio_path", "file_name", "audio_count", "progress")),
    ("Text", {}, "text_limit", ("text_path", "file_name", "text_count", "line_index", "progress")),
    ("Sync", {"use_image": True}, "item_limit",
     ("base_name", "image_path", "video_path", "text_path", "line_index", "audio_path", "item_count", "progress")),
]


class CurrentIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        for name in ("a", "b", "c", "d"):
            for extension in ("png", "mp4", "wav", "txt"):
                (self.folder / f"{name}.{extension}").write_text("first\n\nthird\n", encoding="utf-8")

    def run_queue(self, node, kind, options, **kwargs):
        folder_key = "common_folder" if kind == "Sync" else "folder"
        return node.run(**{folder_key: str(self.folder), **options, **kwargs})

    def outputs(self, node, response):
        self.assertEqual(len(response["result"]), len(node.RETURN_TYPES))
        self.assertEqual(len(node.RETURN_NAMES), len(node.RETURN_TYPES))
        return dict(zip(node.RETURN_NAMES, response["result"]))

    def test_index_tracks_each_execution_in_all_queue_modes(self):
        for kind, options, limit_name, previous_outputs in CASES:
            for auto_queue, queue_all in ((False, False), (True, False), (False, True), (True, True)):
                with self.subTest(kind=kind, auto_queue=auto_queue, queue_all=queue_all):
                    node = namespace[f"FB_Folder{kind}Queue"]()
                    self.assertEqual(node.RETURN_NAMES, (*previous_outputs, "current_index"))
                    self.assertEqual(node.RETURN_TYPES[-1], "INT")
                    # Resume at 1, reach the limited last item, then start a fresh pass.
                    for index in (1, 2, 0):
                        response = self.run_queue(
                            node, kind, options, start_at=index, auto_queue=auto_queue,
                            queue_all=queue_all, order_by="Z-A", **{limit_name: 3},
                        )
                        outputs = self.outputs(node, response)
                        self.assertEqual(outputs["current_index"], index)
                        self.assertEqual(outputs.get("file_name", outputs.get("base_name")), ("d", "c", "b")[index])
                        self.assertAlmostEqual(outputs["progress"], (index + 1) / 3)
                        count_name = "item_count" if kind == "Sync" else f"{kind.lower()}_count"
                        self.assertEqual(outputs[count_name], 4)
                        self.assertEqual(response["ui"]["start_at"], (index,))
                        self.assertEqual(response["ui"]["queue_count"], (3,))

    def test_index_uses_clamped_selection(self):
        for kind, options, limit_name, _ in CASES:
            for requested, expected in ((-3, 0), (99, 1)):
                with self.subTest(kind=kind, start_at=requested):
                    node = namespace[f"FB_Folder{kind}Queue"]()
                    response = self.run_queue(node, kind, options, start_at=requested, **{limit_name: 2})
                    self.assertEqual(self.outputs(node, response)["current_index"], expected)
                    self.assertEqual(response["ui"]["start_at"], (expected,))

    def test_empty_queue_has_no_current_index(self):
        empty_folder = self.folder / "empty"
        empty_folder.mkdir()
        for kind, options, _, _ in CASES:
            with self.subTest(kind=kind):
                node = namespace[f"FB_Folder{kind}Queue"]()
                folder_key = "common_folder" if kind == "Sync" else "folder"
                response = node.run(**{folder_key: str(empty_folder), **options}, queue_all=True)
                outputs = self.outputs(node, response)
                self.assertEqual(outputs["current_index"], -1)
                self.assertEqual(outputs["progress"], 0.0)
                self.assertEqual(response["ui"]["queue_count"], (0,))

    def test_text_queue_index_is_distinct_from_original_line_index(self):
        node = namespace["FB_FolderTextQueue"]()
        response = node.run(source_mode="file", unit_mode="line", text_path=str(self.folder / "a.txt"), start_at=1, queue_all=True)
        outputs = self.outputs(node, response)
        self.assertEqual(outputs["current_index"], 1)
        self.assertEqual(outputs["line_index"], 2)

    def test_sync_index_tracks_expanded_lines_after_skipping_missing_sets(self):
        (self.folder / "a.png").unlink()
        node = namespace["FB_FolderSyncQueue"]()
        response = self.run_queue(node, "Sync", {"use_image": True, "use_text": True}, text_unit_mode="line", start_at=1, queue_all=True)
        outputs = self.outputs(node, response)
        self.assertEqual(outputs["base_name"], "b")
        self.assertEqual(outputs["current_index"], 1)
        self.assertEqual(outputs["line_index"], 2)
        self.assertEqual(outputs["item_count"], 6)


if __name__ == "__main__":
    unittest.main()
