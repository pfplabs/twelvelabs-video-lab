"""Emit offline contract outputs for the Node/Python parity test."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from video_lab.api import inventory_response
from video_lab.providers import FixtureInventoryProvider


def run_cases():
    cases = json.loads(Path("fixtures/inventory-cases.json").read_text())
    results = []
    with TemporaryDirectory() as directory:
        path = Path(directory) / "inventory.json"
        for case in cases:
            path.write_text(json.dumps(case["rows"]))
            status, payload = inventory_response(FixtureInventoryProvider(path))
            results.append({"status": status, "payload": payload})
    return results


if __name__ == "__main__":
    print(json.dumps(run_cases()))
