export interface GroundTruthEvent {
  startSec: number;
  endSec: number;
  label: string;
}

export interface Scene {
  startSec: number;
  endSec: number;
  action: string;
  uncertainty: string;
}

export interface Segment {
  startSec: number;
  endSec: number;
  embedding: number[];
  source: string;
}

export interface Correction {
  startSec: number;
  endSec: number;
  decision: "accept" | "adjust" | "reject";
  note: string;
}

export interface Clip {
  id: string;
  title: string;
  durationSec: number;
  mediaFile: string | null;
  groundTruth: GroundTruthEvent[];
  scenes: Scene[];
  segments: Segment[];
  summary: string | null;
  corrections: Correction[];
}

export interface QueryFixture {
  text: string;
  embedding: number[];
}

export interface JockeyCitation {
  type?: string;
  itemId?: string;
  startSec?: number;
  endSec?: number;
}

export interface JockeyAnswer {
  question: string;
  answer: string;
  citations: JockeyCitation[];
}

export interface Fixtures {
  corpus: string;
  synthetic: boolean;
  clips: Clip[];
  queries: QueryFixture[];
  jockey: JockeyAnswer[];
}
