import { useEffect, useMemo, useRef, useState } from "react";
import { loadFixtures } from "./lib/fixtures";
import { rankForQuery } from "./lib/rank";
import type { Clip, Fixtures } from "./types";

type Tab = "summary" | "scenes" | "search" | "jockey" | "review";

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "summary", label: "Summary", hint: "Pegasus claim" },
  { id: "scenes", label: "Scenes", hint: "Timed segments" },
  { id: "search", label: "Search", hint: "Local ranking" },
  { id: "jockey", label: "Jockey", hint: "Saved answers" },
  { id: "review", label: "Review", hint: "Your notes" },
];

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function clipName(clip: Clip): string {
  if (clip.id.startsWith("sintel")) return "Sintel trailer";
  return clip.title;
}

export function App() {
  const [fixtures, setFixtures] = useState<Fixtures | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clipIndex, setClipIndex] = useState(0);
  const [tab, setTab] = useState<Tab>("summary");
  const [queryIndex, setQueryIndex] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerFrame = useRef<HTMLDivElement>(null);
  const pendingSeek = useRef<number | null>(null);

  function revealPlayer() {
    playerFrame.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  useEffect(() => {
    let cancelled = false;
    loadFixtures()
      .then((f) => {
        if (!cancelled) setFixtures(f);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const clip: Clip | undefined = fixtures?.clips[clipIndex];

  const allSegments = useMemo(
    () =>
      (fixtures?.clips ?? []).flatMap((c) =>
        c.segments.map((s) => ({ ...s, clipId: c.id })),
      ),
    [fixtures],
  );

  const ranking = useMemo(
    () => rankForQuery(allSegments, fixtures?.queries[queryIndex]),
    [fixtures, queryIndex, allSegments],
  );

  /** Jump the player to a moment; switch clips first when the moment lives elsewhere. */
  function seek(startSec: number, targetClipIndex?: number) {
    revealPlayer();
    const next = targetClipIndex ?? clipIndex;
    if (next !== clipIndex) {
      pendingSeek.current = startSec;
      setClipIndex(next);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = startSec;
    void video.play();
  }

  function onVideoReady() {
    const video = videoRef.current;
    if (!video || pendingSeek.current == null) return;
    video.currentTime = pendingSeek.current;
    pendingSeek.current = null;
    void video.play();
  }

  if (error) {
    return (
      <main className="gate">
        <p className="kicker">Fixture</p>
        <h1>Could not load fixtures</h1>
        <p className="error" role="alert">{error}</p>
      </main>
    );
  }
  if (!fixtures) {
    return (
      <main className="gate">
        <p className="loading">Loading fixtures…</p>
      </main>
    );
  }
  if (fixtures.clips.length === 0) {
    return (
      <main className="gate">
        <p className="empty">No clips in the fixture yet.</p>
      </main>
    );
  }
  if (!clip) {
    return (
      <main className="gate">
        <p className="error" role="alert">Selected clip is missing from the fixture.</p>
      </main>
    );
  }

  return (
    <div className="app">
      <header className="top">
        <div>
          <p className="kicker">Local review</p>
          <h1>Video AI workbench</h1>
        </div>
        <div className="corpus">
          <span>Corpus · {fixtures.corpus}</span>
          {fixtures.synthetic ? (
            <span className="badge synthetic">synthetic demo data</span>
          ) : (
            <span className="badge">your saved API results</span>
          )}
        </div>
      </header>

      <div className="shell">
        <aside className="watch">
          <div className="player" ref={playerFrame}>
            {clip.mediaFile ? (
              <video
                key={clip.id}
                ref={videoRef}
                src={clip.mediaFile}
                controls
                preload="metadata"
                onLoadedData={onVideoReady}
              />
            ) : (
              <p className="missing-media">No media file for this clip — synthetic demo or missing export.</p>
            )}
          </div>
          <div className="now">
            <h2>{clipName(clip)}</h2>
            <p className="meta">
              {clip.id} · {clip.durationSec}s · {clip.scenes.length} scenes · {clip.segments.length} embedding rows
            </p>
            <FilmCredit id={clip.id} />
          </div>
          <nav className="clips" aria-label="Clips">
            {fixtures.clips.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className="clip"
                aria-pressed={i === clipIndex}
                onClick={() => {
                  setClipIndex(i);
                  revealPlayer();
                }}
              >
                <span className="clip-name">{clipName(c)}</span>
                <span className="clip-meta">{formatTime(c.durationSec)} · {c.scenes.length} scenes</span>
              </button>
            ))}
          </nav>
        </aside>

        <section className="stage">
          <nav className="tabs" aria-label="Result tabs">
            {TABS.map((t) => (
              <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
                <span>{t.label}</span>
                <small>{t.hint}</small>
              </button>
            ))}
          </nav>

          {tab === "summary" && (
            <section className="panel">
              <header className="panel-head">
                <h2>Pegasus summary</h2>
                <span className="badge source">Pegasus · model claim</span>
              </header>
              {clip.summary ? (
                <p className="claim">{clip.summary}</p>
              ) : (
                <p className="empty">No saved summary for this clip yet — chapter 3 creates one.</p>
              )}
              <header className="panel-head yours-head">
                <h3>Your ground truth</h3>
                <span className="badge yours">Your notes</span>
              </header>
              {clip.groundTruth.length === 0 ? (
                <p className="empty">No handwritten ground truth for this clip yet.</p>
              ) : (
                <ul className="moments">
                  {clip.groundTruth.map((e) => (
                    <li key={`${e.startSec}-${e.label}`}>
                      <button type="button" onClick={() => seek(e.startSec)}>
                        {formatTime(e.startSec)}–{formatTime(e.endSec)}
                      </button>
                      <span>{e.label}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "scenes" && (
            <section className="panel">
              <header className="panel-head">
                <h2>Pegasus scenes</h2>
                <span className="badge source">Pegasus · model claim</span>
              </header>
              {clip.scenes.length === 0 ? (
                <p className="empty">No saved scene segmentation for this clip yet — chapter 3 creates one.</p>
              ) : (
                <ol className="scenes">
                  {clip.scenes.map((s) => (
                    <li key={`${s.startSec}-${s.endSec}`}>
                      <button type="button" onClick={() => seek(s.startSec)}>
                        {formatTime(s.startSec)}–{formatTime(s.endSec)}
                      </button>
                      <div>
                        <p>{s.action}</p>
                        <p className="uncertainty">
                          <span className="badge">Uncertainty</span>
                          {s.uncertainty || "none stated"}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}

          {tab === "search" && (
            <section className="panel">
              <header className="panel-head">
                <h2>Marengo search</h2>
                <span className="badge source">Marengo · local cosine</span>
              </header>
              {fixtures.queries.length === 0 ? (
                <p className="empty">No saved query vectors yet — chapter 4 creates one.</p>
              ) : (
                <label className="query">
                  Query
                  <select value={queryIndex} onChange={(e) => setQueryIndex(Number(e.target.value))}>
                    {fixtures.queries.map((q, i) => (
                      <option key={q.text} value={i}>{q.text}</option>
                    ))}
                  </select>
                </label>
              )}
              <p className="meta">Pre-embedded queries only — no provider key ever enters the browser. A score is not evidence.</p>
              {ranking.error ? (
                <p className="error" role="alert">
                  Ranking failed: {ranking.error}. Fix or re-export the fixture; no results are shown
                  rather than a misleading empty list.
                </p>
              ) : fixtures.queries.length === 0 ? null : ranking.results.length === 0 ? (
                <p className="empty">No rankable segments for this query.</p>
              ) : (
                <ol className="hits">
                  {ranking.results.map((r) => {
                    const target = fixtures.clips.findIndex((c) => c.id === r.clipId);
                    const name = target >= 0 ? clipName(fixtures.clips[target]) : r.clipId;
                    return (
                      <li key={`${r.clipId}-${r.startSec}-${r.source}`}>
                        <button type="button" onClick={() => seek(r.startSec, target)}>
                          {formatTime(r.startSec)}–{formatTime(r.endSec)}
                        </button>
                        <div>
                          <p className="hit-title">{name}</p>
                          <p className="meta">{r.clipId}</p>
                        </div>
                        <span className="score">{r.score.toFixed(3)}</span>
                        <span className="badge">{r.source}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          )}

          {tab === "jockey" && (
            <section className="panel">
              <header className="panel-head">
                <h2>Jockey answers</h2>
                <span className="badge source">Jockey · model claim</span>
              </header>
              {fixtures.jockey.length === 0 ? (
                <p className="empty">No saved Jockey answers yet — chapter 4 creates them.</p>
              ) : (
                fixtures.jockey.map((j) => (
                  <article key={j.question} className="answer">
                    <h3>{j.question}</h3>
                    <p className="claim">{j.answer}</p>
                    {j.citations.length > 0 && (
                      <p className="citations">
                        <span className="meta">Citations</span>
                        {j.citations.map((c, i) => (
                          <span key={i} className="badge">
                            {c.startSec !== undefined && c.endSec !== undefined
                              ? `${formatTime(c.startSec)}–${formatTime(c.endSec)}`
                              : (c.type ?? "reference")}
                          </span>
                        ))}
                      </p>
                    )}
                  </article>
                ))
              )}
            </section>
          )}

          {tab === "review" && (
            <section className="panel">
              <header className="panel-head yours-head">
                <h2>Your review notes</h2>
                <span className="badge yours">Your notes</span>
              </header>
              <p className="meta">Corrections you record stay separate from model claims. This tab does not grade the footage for you.</p>
              {clip.corrections.length === 0 ? (
                <p className="empty">No human corrections recorded yet.</p>
              ) : (
                <ol className="scenes">
                  {clip.corrections.map((c) => (
                    <li key={`${c.startSec}-${c.decision}`}>
                      <button type="button" onClick={() => seek(c.startSec)}>
                        {formatTime(c.startSec)}–{formatTime(c.endSec)}
                      </button>
                      <div>
                        <p><span className="badge yours">{c.decision}</span></p>
                        <p>{c.note}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
        </section>
      </div>
    </div>
  );
}

function FilmCredit({ id }: { id: string }) {
  if (!id.startsWith("sintel")) return null;
  return (
    <aside className="credit">
      <p className="kicker">Film credit</p>
      <p>Sintel trailer. © Blender Foundation · www.sintel.org. Licensed under CC BY 3.0.</p>
      <p className="meta">
        <a href="https://download.blender.org/durian/trailer/sintel_trailer-720p.mp4">Source</a>
        {" · "}
        <a href="https://durian.blender.org/sharing/">Rights</a>
        {" · "}
        <a href="https://creativecommons.org/licenses/by/3.0/">License</a>
      </p>
    </aside>
  );
}
