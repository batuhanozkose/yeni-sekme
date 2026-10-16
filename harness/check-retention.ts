/**
 * Privacy check: after a build, nothing it read is still on disk.
 *
 * There is no remote session to delete any more — but the run in progress is
 * persisted locally between model calls so a killed worker can pick it up, and
 * that record holds every domain and page body the agent read. It must not
 * outlive the build.
 *
 * Run: pnpm agent:retention   (after pnpm agent:run)
 */
import { STORAGE_KEYS } from "@homepage/agent-core";
import { existsSync, readFileSync } from "node:fs";
import { STATE_PATH } from "./node-bridge";

let failures = 0;
const check = (label: string, pass: boolean) => {
  console.log(`${pass ? "✅" : "❌"} ${label}`);
  if (!pass) failures++;
};

if (!existsSync(STATE_PATH)) {
  console.log(`   no harness state yet (${STATE_PATH}) — nothing to leak`);
  check("no run left mid-flight", true);
  check("no scraped page bodies left on disk", true);
} else {
  const state = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as Record<string, unknown>;
  const run = state[STORAGE_KEYS.activeRun] as { turns?: unknown[] } | undefined;
  const pages = state[STORAGE_KEYS.runPages] as Array<{ path: string }> | undefined;

  if (run) console.log(`   a run is still in progress: ${run.turns?.length ?? "?"} turn(s)`);
  check("no run left mid-flight", run === undefined);

  if (pages?.length) console.log(`   still stored: ${pages.map((page) => page.path).join(", ")}`);
  check("no scraped page bodies left on disk", pages === undefined);
}

// The cached ids the old remote orchestrator kept are gone with it; make sure a
// stale one cannot linger in a state file carried over from an older checkout.
const legacyKeys = ["agentId", "environmentId", "activeSessionId", "uploadedFileIds"];
if (existsSync(STATE_PATH)) {
  const state = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as Record<string, unknown>;
  const stale = legacyKeys.filter((key) => key in state || Object.keys(state).some((k) => k.startsWith(`${key}-`)));
  check("no leftover remote-orchestrator state", stale.length === 0);
  if (stale.length) console.log(`   stale keys: ${stale.join(", ")}`);
}

process.exit(failures === 0 ? 0 : 1);
