"""Provider-independent inventory rules."""

from dataclasses import dataclass
from enum import Enum
import math


class Status(str, Enum):
    READY = "ready"
    PROCESSING = "processing"
    FAILED = "failed"


@dataclass(frozen=True)
class Video:
    filename: str
    source: str
    license: str
    attribution: str
    duration_seconds: float
    status: Status
    failure_reason: str | None = None

    def __post_init__(self):
        if not isinstance(self.status, Status):
            raise ValueError("Status must be a supported Status value")
        if (type(self.duration_seconds) not in (int, float)
                or not math.isfinite(self.duration_seconds) or self.duration_seconds <= 0):
            raise ValueError("Duration must be positive and finite")
        for value in (self.filename, self.source, self.license, self.attribution):
            if not isinstance(value, str) or not value.strip():
                raise ValueError("Manifest metadata must be nonempty text")
        if self.failure_reason is not None and not isinstance(self.failure_reason, str):
            raise ValueError("Failure reason must be text or null")

    @property
    def analysis_eligible(self) -> bool:
        return self.status is Status.READY

    @property
    def status_detail(self) -> str:
        if self.status is Status.FAILED:
            return (self.failure_reason or "").strip() or "Failure reason unavailable."
        if self.status is Status.PROCESSING:
            return "Processing; not eligible for analysis."
        return "Ready for analysis."


def eligible_videos(videos: tuple[Video, ...]) -> tuple[Video, ...]:
    return tuple(video for video in videos if video.analysis_eligible)
