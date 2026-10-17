"""Read-only inventory boundary. No SDK, credentials, ingestion, or retries."""

import json
from pathlib import Path
from typing import Protocol

from video_lab.domain import Status, Video


class InventoryError(Exception):
    """Inventory could not be read; never substitute a successful empty result."""


class InventoryProvider(Protocol):
    def list_videos(self) -> tuple[Video, ...]: ...


class FixtureInventoryProvider:
    def __init__(self, path: Path):
        self.path = path

    def list_videos(self) -> tuple[Video, ...]:
        try:
            rows = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(rows, list):
                raise ValueError("Inventory must be a list")
            videos = tuple(Video(**{**row, "status": Status(row["status"])}) for row in rows)
            if len({video.filename for video in videos}) != len(videos):
                raise ValueError("Duplicate filename")
            return videos
        except (OSError, ValueError, TypeError, KeyError) as error:
            raise InventoryError("Inventory unavailable: fixture could not be read or validated.") from error
