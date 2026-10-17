from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from video_lab.domain import Status, eligible_videos
from video_lab.providers import FixtureInventoryProvider, InventoryError
from video_lab.web import render_inventory


FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "inventory.json"


class StaticProvider:
    def __init__(self, videos):
        self.videos = videos

    def list_videos(self):
        return self.videos


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.provider = FixtureInventoryProvider(FIXTURE)
        self.videos = self.provider.list_videos()

    def test_two_ready_and_one_failed_remain_visible(self):
        status, html = render_inventory(self.provider)
        self.assertEqual(status, 200)
        self.assertEqual([v.status for v in self.videos], [Status.READY, Status.READY, Status.FAILED])
        self.assertIn("3 items · 2 eligible", html)
        for video in self.videos:
            self.assertIn(video.filename, html)
        self.assertIn("Failure reason unavailable.", html)
        self.assertIn("<td>failed</td><td>Failure reason unavailable.</td><td>Not eligible</td>", html)

    def test_only_ready_items_are_eligible(self):
        processing = replace(self.videos[0], status=Status.PROCESSING)
        selected = eligible_videos(self.videos + (processing,))
        self.assertEqual(selected, self.videos[:2])
        self.assertFalse(processing.analysis_eligible)

    def test_render_is_read_only_and_does_not_retry_failed_item(self):
        class CountingProvider(StaticProvider):
            calls = 0

            def list_videos(self):
                self.calls += 1
                return self.videos

        provider = CountingProvider(self.videos)
        render_inventory(provider)
        self.assertEqual(provider.calls, 1)
        self.assertEqual(provider.videos, self.videos)

    def test_failure_reason_and_manifest_text_are_escaped(self):
        video = replace(self.videos[2], filename="<script>.mp4", failure_reason="<unsafe>")
        _, html = render_inventory(StaticProvider((video,)))
        self.assertIn("&lt;script&gt;.mp4", html)
        self.assertIn("&lt;unsafe&gt;", html)
        self.assertNotIn("<unsafe>", html)

    def test_missing_or_invalid_fixture_is_visible_failure(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "inventory.json"
            provider = FixtureInventoryProvider(path)
            status, html = render_inventory(provider)
            self.assertEqual(status, 503)
            self.assertIn('role="alert"', html)
            self.assertNotIn("No videos in inventory", html)
            for value in ('{}', '[{"status":"unknown"}]', '[null]', 'not json'):
                with self.subTest(value=value):
                    path.write_text(value)
                    with self.assertRaises(InventoryError):
                        provider.list_videos()

    def test_empty_inventory_is_distinct_from_error(self):
        status, html = render_inventory(StaticProvider(()))
        self.assertEqual(status, 200)
        self.assertIn("No videos in inventory", html)

    def test_invalid_duration_is_rejected(self):
        for duration in (0, -1, float("nan"), float("inf")):
            with self.subTest(duration=duration), self.assertRaises(ValueError):
                replace(self.videos[0], duration_seconds=duration)

    def test_processing_and_known_failure_details(self):
        processing = replace(self.videos[0], status=Status.PROCESSING)
        failed = replace(self.videos[2], failure_reason="Synthetic decode error")
        _, html = render_inventory(StaticProvider((processing, failed)))
        self.assertIn("Processing; not eligible for analysis.", html)
        self.assertIn("Synthetic decode error", html)
        self.assertIn("2 items · 0 eligible", html)


if __name__ == "__main__":
    unittest.main()
