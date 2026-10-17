"""Small local read-only UI; provider selection stays outside rendering."""

import argparse
import json

from video_lab.api import inventory_response
from html import escape
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from video_lab.domain import eligible_videos
from video_lab.providers import FixtureInventoryProvider, InventoryError, InventoryProvider


def render_inventory(provider: InventoryProvider) -> tuple[int, str]:
    try:
        videos = provider.list_videos()
    except InventoryError:
        return 503, page('<p role="alert">Inventory unavailable. Could not load inventory; processing status is unknown.</p>')
    rows = "".join(
        "<tr>"
        f"<td>{escape(video.filename)}</td>"
        f"<td>{escape(video.status.value)}</td>"
        f"<td>{escape(video.status_detail)}</td>"
        f"<td>{'Eligible' if video.analysis_eligible else 'Not eligible'}</td>"
        f"<td>{video.duration_seconds:g}s</td>"
        f"<td>{escape(video.source)}</td>"
        f"<td>{escape(video.license)}</td>"
        f"<td>{escape(video.attribution)}</td></tr>"
        for video in videos
    )
    content = f"<p>{len(videos)} items · {len(eligible_videos(videos))} eligible for analysis</p>"
    if videos:
        content += ('<div class="scroll"><table><caption>Video processing inventory</caption>'
                    '<thead><tr><th scope="col">Filename</th><th scope="col">Status</th>'
                    '<th scope="col">Detail</th><th scope="col">Analysis</th>'
                    '<th scope="col">Duration</th><th scope="col">Source</th>'
                    '<th scope="col">License</th><th scope="col">Attribution</th></tr></thead>'
                    f'<tbody>{rows}</tbody></table></div>')
    else:
        content += "<p>No videos in inventory.</p>"
    return 200, page(content)


def page(content: str) -> str:
    template = Path(__file__).resolve().parent.parent / "ui" / "inventory.html"
    return template.read_text(encoding="utf-8").replace("{{content}}", content)



def make_handler(provider: InventoryProvider):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/api/inventory":
                status, payload = inventory_response(provider)
                body = json.dumps(payload, allow_nan=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path != "/":
                self.send_error(404)
                return
            status, html = render_inventory(provider)
            body = html.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main():
    parser = argparse.ArgumentParser(description="Serve the offline synthetic inventory")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    fixture = Path(__file__).resolve().parent.parent / "fixtures" / "inventory.json"
    server = HTTPServer(("127.0.0.1", args.port), make_handler(FixtureInventoryProvider(fixture)))
    print(f"Offline inventory: http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
