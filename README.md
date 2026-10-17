# twelvelabs-video-lab
Building with TwelveLabs: From ChatGPT to Bedrock.

## Chapter 2: root-level setup and manifest

The requested root layout is added alongside the existing inventory exercise;
existing Python/TypeScript inventory modules and fixtures remain in place.

```text
requirements.txt       Python dependency names; installation is a separate local step
.env.example           empty placeholder names only
media_manifest.py      local SHA-256/size/duration generation and verification
managed_search.py      offline check and injectable resume workflow; no live adapter yet
media-manifest.json    ignored local manifest; starts empty, never guesses your corpus
media/                 ignored local selected clips
local-results/         ignored model outputs and handwritten grading
vectors/               ignored; reserved, not used in this chapter
state.json             ignored; created only when a runner persists actual workflow state
```

No media is downloaded, selected, renamed or replaced. The empty local manifest is
not a completed corpus. The three exact filenames must be supplied explicitly.
The real manifest is intentionally ignored because it may contain private filenames,
checksums and handwritten observations. Only synthetic fixtures belong in Git.

### Setup and run order

1. Review the diff. You choose what to stage and commit.
2. Create a virtual environment and install `requirements.txt` locally when desired.
   It lists the four requested packages. `numpy` and `boto3` are reserved and unused;
   this chapter adds no vectors or Bedrock integration. Dependencies are not yet
   locked or live-validated. `ffprobe` is an external local prerequisite for durations.
3. Put your selected licensed clips directly in `media/`. Generate the manifest with
   `python3 media_manifest.py FIRST.mp4 SECOND.mp4 THIRD.mp4`, using their actual
   filenames. This does not read `.env` or call a service.
4. Fill `source`, `license`, `attribution`, and `ground_truth` in the ignored manifest
   by hand. Generation refuses to overwrite an existing nonempty manifest. Empty
   ground truth means unreviewed, never verified absence. Preserve the chapter-one
   Sintel/Jockey discrepancy described below as separate human and model evidence.
5. Run `python3 media_manifest.py --check`, then
   `python3 managed_search.py --check`. Both remain offline. Checks require exactly
   three distinct files with matching checksums/sizes and completed provenance.
6. Run `npm run test:all` for the existing suites plus chapter-two offline tests.

The setup template names `TWELVELABS_API_KEY` and `TWELVELABS_INDEX_ID`. A reserved
configuration loader uses `python-dotenv`, but offline commands never invoke it.
No actual secret file has been created or read by this increment.

### Managed-search boundary and recovery

The five proposed queries are visible in `managed_search.py`; review and freeze them
before any live experiment. In particular, the candidate absent-object query still
needs handwritten corpus review. **This increment does not upload, index, search,
or generate model results.** Its injectable workflow is exercised with fake providers;
adding and running a real adapter requires the next review and explicit live approval.

The workflow writes creation intent first, then the returned remote ID, then polls.
Atomic JSON replacement includes flushing and filesystem sync. A state lock prevents
concurrent writers when callers use `state_lock`. Resume uses saved IDs, stops on
corrupt state or changed corpus/index identity, retains failed records, and never
automatically retries failed or ambiguous creations. Missing failure reasons are
reported explicitly. Poll attempts are bounded and errors have fixed redacted text.
There is no automatic status-specific retry policy yet.

A crash between server creation and local persistence cannot be made exactly-once
by a local file. A saved pending intent with no ID requires reconciliation, not
another upload. Current state/resume keys are application fields, not invented API
response fields. Only the future adapter may translate provider responses.

Current official v1.3 contracts checked for that future adapter:

- [Create an asset](https://docs.twelvelabs.io/api-reference/upload-files/direct-uploads/create):
  `method=direct`, `file`, returned `_id`; poll asset readiness even for small files.
- [Create an index](https://docs.twelvelabs.io/api-reference/indexes/create):
  `model_name=marengo3.0`, `model_options=[visual,audio]`. No index is created here.
- [Index an asset](https://docs.twelvelabs.io/api-reference/index-content/create):
  `asset_id`, returned indexed-asset `_id`; persist it before
  [retrieval/polling](https://docs.twelvelabs.io/api-reference/index-content/retrieve).
- [Managed search](https://docs.twelvelabs.io/api-reference/any-to-video-search/make-search-request):
  `index_id`, `query_text`, `search_options`; result examples include `video_id`,
  `start`, `end`, `rank`. SDK mappings and pagination must be verified before live use.

Git discipline: `.env`, `media/`, `local-results/`, `vectors/`, `*state.json`, and
the actual generated manifest are ignored. Review staged content yourself; ignore
rules do not untrack previously committed files. No commits or pushes are automated.

## Step 1: offline inventory

Two offline implementations share synthetic fixtures, an HTML template, and the
same application response contract. Requires Python 3.10+ and Node.js 24.12+.
Both use only built-in libraries; no dependency installation is needed.

Run Python on port 8000:

```sh
python3 -m video_lab.web
```

Open http://127.0.0.1:8000. Stop with Ctrl-C. Use `--port 8001` if needed.

Run Node.js/TypeScript on port 8001 in a second terminal:

```sh
npm start
```

Open http://127.0.0.1:8001. Stop with Ctrl-C. Set `PORT` to change the Node port.
Both servers bind only to localhost and serve the same UI at `/` and JSON at
`/api/inventory`. You can run them side by side.

```sh
python3 -m unittest discover -s tests -v
npm test
# Or run both suites:
npm run test:all
```

### Structure and boundary

- `video_lab/domain.py`: manifest fields, explicit statuses, and ready-only eligibility.
- `video_lab/providers.py`: read-only provider protocol and synthetic fixture adapter.
- `video_lab/web.py`: local inventory UI; takes a provider, independent of its implementation.
- `video_lab/api.py`: Python implementation of the shared JSON contract.
- `node/domain.ts`, `node/providers.ts`, `node/api.ts`, `node/server.ts`: matching
  Node implementation, with the same separation of responsibilities.
- `ui/inventory.html`: shared UI shell; each backend escapes and renders inventory rows.
- `fixtures/inventory.json`: two ready items and one failed item with no reason.
- `fixtures/inventory-cases.json`: shared valid and invalid acceptance inputs.
- `tests/test_inventory.py`: offline acceptance and failure checks.
- `tests/test_contract.py`, `node/inventory.test.ts`: contract checks and exact
  Python/Node JSON parity across all shared cases. The Node parity test runs Python.

Node runs erasable TypeScript directly using its built-in type stripping. It does
not perform static type checking; no TypeScript compiler is installed. See the
[official Node documentation](https://nodejs.org/api/typescript.html).

### Application JSON contract

This is our own contract, not a claim about TwelveLabs API fields. A successful
`GET /api/inventory` returns HTTP 200 with `mode: "synthetic"`, `videos`, and
`eligible_count`. Each video includes the manifest fields plus `failure_reason`
(text or null), `analysis_eligible` (boolean), and `status_detail` (text). Status is
one of `ready`, `processing`, or `failed`. Missing failure reasons normalize to
null. An empty inventory returns an empty array and zero eligible items.

If inventory cannot be read or validated, HTTP 503 returns
`{"error":"inventory_unavailable","message":"Inventory unavailable. Processing status is unknown."}`
without a videos array. Both adapters reject invalid metadata, nonpositive or
nonfinite durations, unsupported statuses, duplicate filenames, and unknown fields.

All fixture names, durations, and statuses are synthetic. No media is included and
no media license or processing success is asserted. The manifest includes filename,
source, license, duration, and attribution. A failed record stays visible, with
“Failure reason unavailable.” when the adapter has no reason. Only `ready` records
pass `eligible_videos`; processing and failed records do not. There are no upload,
retry, search, or export actions. Inventory load failures show an explicit error
instead of an empty or successful result.

### Review boundary and next steps

This step covers acceptance test 1 offline. Evidence answers and highlight planning
(tests 2 and 3) are pending. Before adding a live adapter, verify SDK signatures and
status mappings against current official TwelveLabs documentation. No SDK is
installed or called in this step. Live integration, resource provisioning, and paid
calls require approval.

Preserve the supplied future evaluation case: the human observation at Sintel
00:24 is three red birds and one pale dragon; the reported Jockey interpretation
over 00:24–00:26 was two birds. Flag this discrepancy, keep frame counts distinct
from unique counts across a sequence, and never hard-code a corrected model answer.
Also evaluate an absent object. These are evaluation requirements, not results
produced or verified by this implementation.

Future highlight plans must validate source bounds, compute interval durations,
flag overlaps, and support human review. A plan is not an exported video.

Keep credentials, account/store identifiers, private media, and generated results
in ignored local paths (`.env`, `local/`, `media/`, `results/`). The ignore rules are
a guardrail; review staged files before any future commit. Do not place private
values in fixtures, logs, or prompts.
