/**
 * Protocol between the new-tab page(s) and the service worker.
 *
 * The worker owns exactly one build at a time and is the single source of truth
 * for its state (see build-manager.ts). Tabs are thin, disposable views: they
 * connect on AGENT_PORT, receive a snapshot, then stream deltas.
 */
import type { RunPhase } from "@homepage/agent-core";

export const AGENT_PORT = "homepage-agent";

/** Live build state. The worker holds the canonical copy; tabs reduce into a mirror. */
export interface BuildState {
  running: boolean;
  phase: RunPhase | null;
  /** High-water index into BUILD_STEPS — only advances, so interleaved phases don't rewind the stepper. */
  stepIndex: number;
  detail: string;
  narration: string;
  logs: string[];
  error: string | null;
}

export const INITIAL_BUILD_STATE: BuildState = {
  running: false,
  phase: null,
  stepIndex: 0,
  detail: "",
  narration: "",
  logs: [],
  error: null,
};

/** How many recent log lines are kept (and shown). */
export const LOG_RETENTION = 40;

// page → worker
export type PageMsg =
  | { kind: "subscribe" } //                    → replies with a snapshot
  | { kind: "startBuild"; resume?: boolean } // no-op if one is already running
  | { kind: "cancel" };

// worker → page (broadcast to every connected tab)
export type BuildMsg =
  | { kind: "snapshot"; state: BuildState }
  | { kind: "phase"; phase: RunPhase; stepIndex: number; detail: string }
  | { kind: "text"; chunk: string } // narration delta
  | { kind: "log"; line: string }
  | { kind: "done"; code: string } // homepage saved; carries the raw TSX
  | { kind: "error"; message: string };

/**
 * The five stages a person cares about. The agent emits finer-grained phases
 * that interleave (thinking ↔ analyzing fire repeatedly); each maps to a step
 * here. `thinking` and `error` deliberately map to none, so they never move the
 * stepper.
 *
 * Keys, not labels: this module is imported by the service worker, which must
 * not pull React in, so the strings live in lib/i18n.tsx instead.
 */
export const BUILD_STEP_KEYS = [
  "step.prepare",
  "step.history",
  "step.scraping",
  "step.analyzing",
  "step.writing",
] as const;

export type BuildStepKey = (typeof BUILD_STEP_KEYS)[number];

export const BUILD_STEPS: { key: BuildStepKey; phases: RunPhase[] }[] = [
  { key: "step.prepare", phases: ["setup"] },
  { key: "step.history", phases: ["history"] },
  { key: "step.scraping", phases: ["scraping"] },
  { key: "step.analyzing", phases: ["analyzing"] },
  { key: "step.writing", phases: ["writing", "cleanup", "done"] },
];

/** Which step a phase belongs to, or `undefined` if it shouldn't move the stepper. */
export function stepForPhase(phase: RunPhase): number | undefined {
  const i = BUILD_STEPS.findIndex((step) => step.phases.includes(phase));
  return i === -1 ? undefined : i;
}
