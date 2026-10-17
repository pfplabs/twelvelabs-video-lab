"""Chapter 2 offline-check entry point and injectable resumable workflow.

No live adapter is enabled. The transport must be approved and tested separately.
All state keys below are lab-owned fields, not TwelveLabs response field claims.
"""

import argparse
from contextlib import contextmanager
import fcntl
import json
from pathlib import Path

from media_manifest import LabError, read_json, save_json, verify


QUERIES = ("A dragon", "Red birds flying", "Snowy mountains",
           "A character running", "A traffic light")


@contextmanager
def state_lock(path):
    lock_path = Path(str(path) + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LabError("Another runner holds the state lock.") from None
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def resume_item(record, state, state_path, provider, clip, polls=3):
    """Provider seam for offline tests. Caller holds state_lock.

    Provider returns lab-normalized IDs/statuses. A future adapter must map the
    documented REST _id (or verified SDK id) explicitly, never guess IDs.
    """
    if record.get("failed"):
        return "failed"
    for stage in ("asset", "indexed_asset"):
        id_key = stage + "_id"
        if not record.get(id_key):
            if record.get("pending"):
                raise LabError("Creation outcome unknown; reconcile locally before retrying.")
            record["pending"] = stage
            save_json(state_path, state)
            try:
                remote_id = provider.create(stage, clip, record)
            except Exception:
                raise LabError("Creation failed or outcome unknown; reconcile locally. Details redacted.") from None
            if not isinstance(remote_id, str) or not remote_id:
                raise LabError("Creation returned no usable ID; reconciliation required.")
            record[id_key] = remote_id
            record.pop("pending")
            save_json(state_path, state)  # Must succeed before the first poll.
        if record.get(stage + "_status") == "ready":
            continue
        for _ in range(polls):
            try:
                status = provider.poll(stage, record[id_key])
            except Exception:
                raise LabError("Polling failed; saved IDs retained. Details redacted.") from None
            record[stage + "_status"] = status
            if status == "failed":
                record["failed"] = True
                record["failure_reason"] = "Failure reason unavailable."
            save_json(state_path, state)
            if status == "failed":
                return "failed"
            if status == "ready":
                break
            if status != "processing":
                raise LabError("Unmapped provider status; resume stopped safely.")
        else:
            raise LabError("Polling limit reached; saved IDs retained for resume.")
    return "ready"


def load_state(path, clips, index_id):
    identity = [{"filename": c["filename"], "sha256": c["sha256"]} for c in clips]
    if Path(path).exists():
        state = read_json(path)
        if (not isinstance(state, dict) or state.get("schema_version") != 1
                or state.get("corpus") != identity or state.get("index_id") != index_id
                or not isinstance(state.get("items"), dict)):
            raise LabError("State does not match the selected corpus/index; refusing reuse.")
        return state
    return {"schema_version": 1, "corpus": identity, "index_id": index_id,
            "items": {c["sha256"]: {} for c in clips}}


def load_live_settings():
    """Reserved for a separately approved live entry point; never called by checks."""
    from dotenv import dotenv_values
    values = dotenv_values(".env")
    if not values.get("TWELVELABS_API_KEY") or not values.get("TWELVELABS_INDEX_ID"):
        raise LabError("Required local configuration is missing; values redacted.")
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path("media-manifest.json"))
    parser.add_argument("--media-dir", type=Path, default=Path("media"))
    parser.add_argument("--check", action="store_true", required=True,
                        help="Offline checksum check; no .env reads or remote calls")
    args = parser.parse_args()
    try:
        verify(read_json(args.manifest), args.media_dir)
        print(json.dumps({"mode": "offline-check", "clips": 3, "queries": list(QUERIES),
                          "live_adapter": "pending separate approval", "remote_calls": 0}))
    except (LabError, OSError) as error:
        parser.exit(1, f"{error if isinstance(error, LabError) else 'Local file operation failed; details redacted.'}\n")


if __name__ == "__main__":
    main()
