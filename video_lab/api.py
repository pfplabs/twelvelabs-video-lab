"""Application-owned response contract, not a TwelveLabs SDK response."""

from dataclasses import asdict

from video_lab.providers import InventoryError, InventoryProvider


def inventory_response(provider: InventoryProvider) -> tuple[int, dict]:
    try:
        videos = provider.list_videos()
    except InventoryError:
        return 503, {"error": "inventory_unavailable", "message": "Inventory unavailable. Processing status is unknown."}
    rows = [dict(asdict(video), analysis_eligible=video.analysis_eligible,
                 status_detail=video.status_detail) for video in videos]
    return 200, {"mode": "synthetic", "videos": rows,
                 "eligible_count": sum(video.analysis_eligible for video in videos)}
