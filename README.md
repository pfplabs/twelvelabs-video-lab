# twelvelabs-video-lab

My own video AI lab. Two local clips go through TwelveLabs first (managed Marengo search, Pegasus, direct Marengo embeddings, Jockey), then the same trailer is described and embedded through Amazon Bedrock. Chapter 6 plays those saved results next to the footage. Nothing a model returns is evidence. Replay the timestamps yourself.

The posts and the labels share one slug. A post can link its readers here with the label URL.

## Chapters

| Chapter | Post | Label |
| --- | --- | --- |
| 1 | [Ask Questions About Videos with Jockey in ChatGPT](https://pfplabs.ai/blog/video-ai-jockey-in-chatgpt) | [`video-ai-jockey-in-chatgpt`](https://github.com/pfplabs/twelvelabs-video-lab/labels/video-ai-jockey-in-chatgpt) |
| 2 | [Find Video Moments with TwelveLabs Managed Search](https://pfplabs.ai/blog/video-ai-conversation-to-repo) | [`video-ai-conversation-to-repo`](https://github.com/pfplabs/twelvelabs-video-lab/labels/video-ai-conversation-to-repo) |
| 3 | [Summarize Videos and Identify Scenes with Pegasus](https://pfplabs.ai/blog/video-ai-explain-what-happened) | [`video-ai-explain-what-happened`](https://github.com/pfplabs/twelvelabs-video-lab/labels/video-ai-explain-what-happened) |
| 4 | [Search Video Moments with Marengo and Ask Jockey](https://pfplabs.ai/blog/video-ai-own-retrieval-and-agent) | [`video-ai-own-retrieval-and-agent`](https://github.com/pfplabs/twelvelabs-video-lab/labels/video-ai-own-retrieval-and-agent) |
| 5 | [Search and Summarize Videos with TwelveLabs on Bedrock](https://pfplabs.ai/blog/video-ai-repeat-on-bedrock) | [`video-ai-repeat-on-bedrock`](https://github.com/pfplabs/twelvelabs-video-lab/labels/video-ai-repeat-on-bedrock) |
| 6 | [Build a Local Review Screen for Video AI Results](https://pfplabs.ai/blog/video-ai-useful-workbench) | [`video-ai-useful-workbench`](https://github.com/pfplabs/twelvelabs-video-lab/labels/video-ai-useful-workbench) |

Every script is `node <file>.mjs` with no arguments. A saved result is kept on the next run. A pending flag means the last call's outcome is uncertain: reconcile that state file before running again.

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

<a id="video-ai-jockey-in-chatgpt"></a>

## Chapter 1

[Ask Questions About Videos with Jockey in ChatGPT](https://pfplabs.ai/blog/video-ai-jockey-in-chatgpt) · [label](https://github.com/pfplabs/twelvelabs-video-lab/labels/video-ai-jockey-in-chatgpt)

This chapter stays in ChatGPT. It does not add files here.

<a id="video-ai-conversation-to-repo"></a>

## Chapter 2

[Find Video Moments with TwelveLabs Managed Search](https://pfplabs.ai/blog/video-ai-conversation-to-repo) · [label](https://github.com/pfplabs/twelvelabs-video-lab/labels/video-ai-conversation-to-repo)

`managed-search.mjs` uploads both clips, indexes them with Marengo 3.0 (visual and audio), then runs five text searches: a dragon, red birds flying, snowy mountains, a character running, a traffic light. It writes `state.json` and `local-results/managed-search.json`. Later chapters read asset ids from `state.json`, so this one has to finish first.

It takes a `state.json.lock` directory while it runs. If a crash leaves the lock, confirm nothing is still running and reconcile any pending creation intent before removing it.

<a id="video-ai-explain-what-happened"></a>

## Chapter 3

[Summarize Videos and Identify Scenes with Pegasus](https://pfplabs.ai/blog/video-ai-explain-what-happened) · [label](https://github.com/pfplabs/twelvelabs-video-lab/labels/video-ai-explain-what-happened)

| Script | What it does | Writes |
| --- | --- | --- |
| `pegasus-summaries.mjs` | One Pegasus 1.6 streamed summary per ready clip. A file is written only when the stream finishes with `stop`. | `local-results/<clip-id>-summary.txt` |
| `pegasus-segments.mjs` | One async Pegasus 1.6 time-based segmentation task per ready clip (`desk-actions`: visible action and uncertainty). No prompt is sent. | `local-results/<clip-id>-segments.json`, task ids on `state.segment_tasks` |
| `still-image.mjs` | ffmpeg extracts the middle frame, uploads it once, and asks Pegasus 1.6 to describe only that still. Compares it with the summary. | `local-results/frames/<clip-id>.png`, `local-results/<clip-id>-still-comparison.json`, frame asset ids on `state.frames` |

`still-image.mjs` takes the same `state.json.lock` directory.

<a id="video-ai-own-retrieval-and-agent"></a>

## Chapter 4

[Search Video Moments with Marengo and Ask Jockey](https://pfplabs.ai/blog/video-ai-own-retrieval-and-agent) · [label](https://github.com/pfplabs/twelvelabs-video-lab/labels/video-ai-own-retrieval-and-agent)

| Script | What it does | Writes |
| --- | --- | --- |
| `embeddings.mjs` | Marengo 3.5 clip-scope visual and audio vectors for each clip, plus one text vector for `a person opens a blue notebook`. | `vectors/<clip-id>.json`, `vectors/query-notebook.json`, task ids on `state.embed_tasks` |
| `rank.mjs` | Local cosine over those vectors. No API call. | prints the top 5; picture and sound rows stay separate |
| `composed-query.mjs` | One Marengo 3.5 image-plus-text embedding of the first clip's saved middle frame plus `after the notebook opens`, then the same local ranking. No second index. | `vectors/composed-query.json` |
| `jockey-store.mjs` | Knowledge store `video-lab-store` for the two ready clips. | `state.knowledge_store_id`, `state.store_items` |
| `jockey-responses.mjs` | Two turns in one session: what happens to the red mug, then three 5-second highlight intervals. | `local-results/jockey-highlights.json` |

`jockey-store.mjs` takes the `state.json.lock` directory.

<a id="video-ai-repeat-on-bedrock"></a>

## Chapter 5

[Search and Summarize Videos with TwelveLabs on Bedrock](https://pfplabs.ai/blog/video-ai-repeat-on-bedrock) · [label](https://github.com/pfplabs/twelvelabs-video-lab/labels/video-ai-repeat-on-bedrock)

These two scripts do not upload. Put `media/sintel_trailer-720p.mp4` at `s3://<LAB_BUCKET>/lab/input/sintel_trailer-720p.mp4` first. They do not read `state.json` or `vectors/`.

```sh
node bedrock-analyze.mjs
node bedrock-embed.mjs
```

`bedrock-analyze.mjs` calls Pegasus 1.5 (`us.twelvelabs.pegasus-1-5-v1:0`) once with `InvokeModel` and writes `local-results/sintel_trailer-720p-bedrock.txt`. Resume state is `bedrock-state.json`. A timeout leaves `pending_invoke` set so a rerun does not call again.

`bedrock-embed.mjs` embeds that clip with Marengo 3.0. Video uses `StartAsyncInvoke` on `twelvelabs.marengo-embed-3-0-v1:0` (`embeddingOption: visual`, `embeddingScope: clip`) and writes timed vectors to `s3://<LAB_BUCKET>/lab/output/bedrock-embed/sintel_trailer-720p/<invocation-id>/output.json`. Text uses `InvokeModel` on the US inference profile for `Birds are flying in the scene`. Local cosine prints the top hits. Saved copies are `local-results/sintel_trailer-720p-bedrock-segments.json` and `local-results/sintel_trailer-720p-bedrock-query.json`. Resume state is `bedrock-embed-state.json`: a start with no saved invocation ARN is uncertain, a saved ARN is resumed with `GetAsyncInvoke`, and `pending_text` blocks another text call.

Clip id, question, and S3 prefixes for both scripts are constants at the top of each file. Change them together.

<a id="video-ai-useful-workbench"></a>

## Chapter 6

[Build a Local Review Screen for Video AI Results](https://pfplabs.ai/blog/video-ai-useful-workbench) · [label](https://github.com/pfplabs/twelvelabs-video-lab/labels/video-ai-useful-workbench)

`export-fixtures.mjs` reads the manifest, `local-results/`, and `vectors/`. It copies the clips to `workbench/public/media/` and writes `workbench/public/fixtures.json`. Both are gitignored. With no manifest it writes the synthetic demo at `workbench/public/demo/fixtures.json`, which is the fixture that is committed. A clip is kept only when `durationSec` is a finite number greater than 0. No provider is called.

```sh
node export-fixtures.mjs
cd workbench
npm install
npm test
npm run dev
```

The site is a clip list, a player, and Summary, Scenes, Search, Jockey, and Review tabs. Clicking a time plays that clip at that moment.

## What stays off git

`.env`, `media/`, `local-results/`, `vectors/`, `state.json`, `bedrock-state.json`, `bedrock-embed-state.json`, `workbench/public/fixtures.json`, and `workbench/public/media/`. Run `git status` and `git diff --cached` before every commit.
