from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from media_manifest import LabError, build, read_json, save_json, verify
from managed_search import load_state, resume_item, state_lock


class ChapterTwoTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.names = ["one.mp4", "two.mp4", "three.mp4"]
        for i, name in enumerate(self.names):
            (self.root / name).write_bytes(f"synthetic bytes {i}".encode())
        self.manifest = build(self.names, self.root, probe=lambda _: 30)
        for clip in self.manifest["clips"]:
            clip.update(source="Synthetic", license="Test", attribution="Fixture")
        self.path = self.root / "state.json"
        self.state = load_state(self.path, self.manifest["clips"], "fake-index")
        self.clip = self.manifest["clips"][0]
        self.record = self.state["items"][self.clip["sha256"]]

    def provider(self, statuses=None):
        owner = self

        class FakeProvider:
            creates = 0
            polls = 0

            def create(self, stage, clip, record):
                self.creates += 1
                owner.assertEqual(read_json(owner.path)["items"][clip["sha256"]]["pending"], stage)
                return "fake-" + stage

            def poll(self, stage, remote_id):
                self.polls += 1
                saved = read_json(owner.path)["items"][owner.clip["sha256"]]
                owner.assertEqual(saved[stage + "_id"], remote_id)
                return next(statuses) if statuses else "ready"

        return FakeProvider()

    def test_checksums_and_handwritten_metadata_preserved(self):
        self.clip["ground_truth"] = [{"observation": "handwritten synthetic note"}]
        before = repr(self.manifest)
        verify(self.manifest, self.root)
        self.assertEqual(repr(self.manifest), before)
        (self.root / self.names[0]).write_bytes(b"changed")
        with self.assertRaisesRegex(LabError, "mismatch"):
            verify(self.manifest, self.root)

    def test_missing_file_and_duplicates_rejected(self):
        with self.assertRaises(LabError):
            build([self.names[0]] * 3, self.root, probe=lambda _: 30)
        (self.root / self.names[0]).unlink()
        with self.assertRaises(LabError):
            verify(self.manifest, self.root)

    def test_persist_before_poll_and_resume_without_creation(self):
        provider = self.provider()
        self.assertEqual(resume_item(self.record, self.state, self.path, provider, self.clip), "ready")
        self.assertEqual(provider.creates, 2)
        state = load_state(self.path, self.manifest["clips"], "fake-index")
        resume_item(state["items"][self.clip["sha256"]], state, self.path, provider, self.clip)
        self.assertEqual(provider.creates, 2)
        self.assertEqual(provider.polls, 2)

    def test_timeout_resumes_existing_id(self):
        provider = self.provider(iter(["processing", "ready", "ready"]))
        with self.assertRaisesRegex(LabError, "Polling limit"):
            resume_item(self.record, self.state, self.path, provider, self.clip, polls=1)
        state = load_state(self.path, self.manifest["clips"], "fake-index")
        resume_item(state["items"][self.clip["sha256"]], state, self.path, provider, self.clip)
        self.assertEqual(provider.creates, 2)

    def test_ambiguous_creation_is_not_repeated(self):
        provider = self.provider()
        provider.create = lambda *args: (_ for _ in ()).throw(ConnectionError("PRIVATE"))
        with self.assertRaisesRegex(LabError, "Details redacted") as error:
            resume_item(self.record, self.state, self.path, provider, self.clip)
        self.assertNotIn("PRIVATE", str(error.exception))
        state = load_state(self.path, self.manifest["clips"], "fake-index")
        fresh_provider = self.provider()
        with self.assertRaisesRegex(LabError, "reconcile"):
            resume_item(state["items"][self.clip["sha256"]], state, self.path, fresh_provider, self.clip)
        self.assertEqual(fresh_provider.creates, 0)

    def test_save_failure_prevents_polling(self):
        provider = self.provider()
        real_save = save_json
        calls = 0

        def save(path, value):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("PRIVATE")
            real_save(path, value)

        with patch("managed_search.save_json", side_effect=save), self.assertRaises(OSError):
            resume_item(self.record, self.state, self.path, provider, self.clip)
        self.assertEqual(provider.polls, 0)
        self.assertEqual(read_json(self.path)["items"][self.clip["sha256"]]["pending"], "asset")

    def test_failed_item_stays_failed_and_has_no_retry(self):
        provider = self.provider(iter(["failed"]))
        self.assertEqual(resume_item(self.record, self.state, self.path, provider, self.clip), "failed")
        self.assertEqual(self.record["failure_reason"], "Failure reason unavailable.")
        resume_item(self.record, self.state, self.path, provider, self.clip)
        self.assertEqual(provider.creates, 1)

    def test_corrupt_state_and_wrong_index_stop(self):
        self.path.write_text("invalid")
        with self.assertRaises(LabError):
            load_state(self.path, self.manifest["clips"], "fake-index")
        save_json(self.path, self.state)
        with self.assertRaises(LabError):
            load_state(self.path, self.manifest["clips"], "other-index")

    def test_lock_prevents_parallel_runner(self):
        with state_lock(self.path), self.assertRaises(LabError):
            with state_lock(self.path):
                self.fail("Second runner acquired lock")

    def test_offline_check_never_reads_environment_or_network(self):
        path = self.root / "manifest.json"
        save_json(path, self.manifest)
        from managed_search import main
        with patch("sys.argv", ["managed_search.py", "--check", "--manifest", str(path), "--media-dir", str(self.root)]), \
                patch("managed_search.load_live_settings", side_effect=AssertionError("secret access")), \
                patch("socket.socket", side_effect=AssertionError("network access")), \
                patch("builtins.print"):
            main()
