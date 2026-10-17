import json
from io import BytesIO
from pathlib import Path
import unittest

from tests.contract_probe import run_cases
from video_lab.providers import FixtureInventoryProvider
from video_lab.web import make_handler


class ContractTests(unittest.TestCase):
    def test_shared_cases(self):
        cases = json.loads(Path("fixtures/inventory-cases.json").read_text())
        for case, result in zip(cases, run_cases(), strict=True):
            with self.subTest(case=case["name"]):
                self.assertEqual(result["status"], case["status"])
                if case["status"] == 200:
                    self.assertEqual(result["payload"]["eligible_count"], case["eligible_count"])
                    self.assertEqual(len(result["payload"]["videos"]), len(case["rows"]))
                else:
                    self.assertNotIn("videos", result["payload"])
                    self.assertEqual(result["payload"]["error"], "inventory_unavailable")

    def test_json_http_handler_without_opening_socket(self):
        handler_class = make_handler(FixtureInventoryProvider(Path("fixtures/inventory.json")))
        handler = handler_class.__new__(handler_class)
        handler.path = "/api/inventory"
        handler.wfile = BytesIO()
        statuses, headers = [], {}
        handler.send_response = statuses.append
        handler.send_header = lambda name, value: headers.update({name: value})
        handler.end_headers = lambda: None
        handler.do_GET()
        self.assertEqual(statuses, [200])
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(json.loads(handler.wfile.getvalue())["eligible_count"], 2)
