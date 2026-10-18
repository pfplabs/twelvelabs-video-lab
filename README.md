# twelvelabs-video-lab

My own video AI lab. Two local clips go through TwelveLabs first (managed Marengo search, Pegasus, direct Marengo embeddings, Jockey), then the same trailer is described and embedded through Amazon Bedrock.

Every script is `node <file>.mjs` with no arguments. A saved result is kept on the next run. A pending flag means the last call's outcome is uncertain: reconcile that state file before running again. Rank, search hits, summaries, and Jockey answers are not evidence. Replay the timestamps yourself.

## Setup

Node.js 20+, ffmpeg, and ffprobe.

```sh
npm install
cp .env.example .env
```

`.env` (never commit it):

- `TWELVELABS_API_KEY` for every TwelveLabs script.
- `TWELVELABS_INDEX_ID` is optional. `managed-search.mjs` creates a Marengo 3.0 index named after the corpus unless this is set, and it refuses to run if the value disagrees with `state.json`.
- `AWS_PROFILE`, `AWS_REGION=us-east-1`, `LAB_BUCKET`, and `LAB_ACCOUNT_ID` for the Bedrock scripts. The bucket must be in `us-east-1`. The example bucket name and `123456789012` are rejected.

## Corpus

Put exactly two regular `.mp4` files in `media/` (gitignored, 200 MB direct-upload limit). Then:

```sh
node media-manifest.mjs
```

That needs ffprobe, not an API key. It writes `media-manifest.json` with checksums and durations, and an empty `ground_truth` list to fill by hand. A later run verifies the two files and keeps the existing manifest.

## TwelveLabs

Run these in order. Chapter 2 has to finish before the rest, because they read asset ids from `state.json`.

| Step | Script | What it does | Writes |
| --- | --- | --- | --- |
| 2 | `managed-search.mjs` | Uploads both clips, indexes them with Marengo 3.0 (visual and audio), then runs five text searches: a dragon, red birds flying, snowy mountains, a character running, a traffic light. | `state.json`, `local-results/managed-search.json` |
| 3 | `pegasus-summaries.mjs` | One Pegasus 1.6 streamed summary per ready clip. A file is written only when the stream finishes with `stop`. | `local-results/<clip-id>-summary.txt` |
| 3 | `pegasus-segments.mjs` | One async Pegasus 1.6 time-based segmentation task per ready clip (`desk-actions`: visible action and uncertainty). No prompt is sent. | `local-results/<clip-id>-segments.json`, task ids on `state.segment_tasks` |
| 3 | `still-image.mjs` | ffmpeg extracts the middle frame, uploads it once, and asks Pegasus 1.6 to describe only that still. Compares it with the Step 3 summary. | `local-results/frames/<clip-id>.png`, `local-results/<clip-id>-still-comparison.json`, frame asset ids on `state.frames` |
| 4 | `embeddings.mjs` | Marengo 3.5 clip-scope visual and audio vectors for each clip, plus one text vector for `a person opens a blue notebook`. | `vectors/<clip-id>.json`, `vectors/query-notebook.json`, task ids on `state.embed_tasks` |
| 4 | `rank.mjs` | Local cosine over those vectors. No API call. | prints the top 5; picture and sound rows stay separate |
| 4 | `composed-query.mjs` | One Marengo 3.5 image-plus-text embedding of the first clip's saved middle frame plus `after the notebook opens`, then the same local ranking. No second index. | `vectors/composed-query.json` |
| 4 | `jockey-store.mjs` | Knowledge store `video-lab-store` for the two ready clips. | `state.knowledge_store_id`, `state.store_items` |
| 4 | `jockey-responses.mjs` | Two turns in one session: what happens to the red mug, then three 5-second highlight intervals. | `local-results/jockey-highlights.json` |

`managed-search.mjs`, `still-image.mjs`, and `jockey-store.mjs` take a `state.json.lock` directory while they run. If a crash leaves the lock, confirm nothing is still running and reconcile any pending creation intent before removing it.

## Bedrock

These two scripts do not upload. Put `media/sintel_trailer-720p.mp4` at `s3://<LAB_BUCKET>/lab/input/sintel_trailer-720p.mp4` first. They do not read `state.json` or `vectors/`.

```sh
node bedrock-analyze.mjs
node bedrock-embed.mjs
```

`bedrock-analyze.mjs` calls Pegasus 1.5 (`us.twelvelabs.pegasus-1-5-v1:0`) once with `InvokeModel` and writes `local-results/sintel_trailer-720p-bedrock.txt`. Resume state is `bedrock-state.json`. A timeout leaves `pending_invoke` set so a rerun does not call again.

`bedrock-embed.mjs` embeds that clip with Marengo 3.0. Video uses `StartAsyncInvoke` on `twelvelabs.marengo-embed-3-0-v1:0` (`embeddingOption: visual`, `embeddingScope: clip`) and writes timed vectors to `s3://<LAB_BUCKET>/lab/output/bedrock-embed/sintel_trailer-720p/<invocation-id>/output.json`. Text uses `InvokeModel` on the US inference profile for `Birds are flying in the scene`. Local cosine prints the top hits. Saved copies are `local-results/sintel_trailer-720p-bedrock-segments.json` and `local-results/sintel_trailer-720p-bedrock-query.json`. Resume state is `bedrock-embed-state.json`: a start with no saved invocation ARN is uncertain, a saved ARN is resumed with `GetAsyncInvoke`, and `pending_text` blocks another text call.

Clip id, question, and S3 prefixes for both scripts are constants at the top of each file. Change them together.

## What stays off git

`.env`, `media/`, `local-results/`, `vectors/`, `state.json`, and `bedrock-state.json`. Run `git status` and `git diff --cached` before every commit. `bedrock-embed-state.json` is resume state too; do not commit it.
