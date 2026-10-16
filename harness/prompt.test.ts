import { describe, expect, test } from "bun:test";
import { buildKickoffMessage, getTimeOfDay } from "@homepage/agent-core";

/**
 * The kickoff message is the only place the build is told what language to write
 * in and what today's date is. The date used to be hardcoded to `en-US`, so a
 * Turkish build got "Friday, October 16, 2026" and an English section header.
 */
describe("buildKickoffMessage", () => {
  const morning = new Date(2026, 9, 16, 9, 0); // 16 October 2026, 09:00 local
  const evening = new Date(2026, 9, 16, 19, 0);

  test("formats the date in the requested language", () => {
    expect(buildKickoffMessage({ now: morning, language: "tr" })).toContain("16 Ekim 2026");
    expect(buildKickoffMessage({ now: morning, language: "en" })).toContain("October 16, 2026");
  });

  test("localizes the time of day", () => {
    expect(buildKickoffMessage({ now: morning })).toContain("Time of day: morning");
    expect(buildKickoffMessage({ now: morning, language: "tr" })).toContain("Time of day: sabah");
    expect(buildKickoffMessage({ now: evening, language: "tr" })).toContain("Time of day: akşam");
  });

  test("asks for Turkish page copy but leaves quoted headlines alone", () => {
    const turkish = buildKickoffMessage({ now: morning, language: "tr" });
    expect(turkish).toContain("in Turkish");
    expect(turkish).toContain("Keep headlines");

    // English says nothing about language at all.
    expect(buildKickoffMessage({ now: morning, language: "en" })).not.toContain("Turkish");
  });

  test("carries the user's standing instructions, marked as outranking the defaults", () => {
    const message = buildKickoffMessage({ now: morning, userSystemPrompt: "  Sadece teknoloji  " });
    expect(message).toContain("Sadece teknoloji");
    expect(message).not.toContain("  Sadece teknoloji  "); // trimmed
    expect(message).toContain("take priority");
  });

  test("still tells the agent where to write", () => {
    expect(buildKickoffMessage({ now: morning })).toContain("/homepage.tsx");
  });
});

describe("getTimeOfDay", () => {
  test("changes over at 5, 12, 17 and 21", () => {
    const at = (hour: number) => new Date(2026, 0, 1, hour, 0);
    expect(getTimeOfDay(at(4))).toBe("night");
    expect(getTimeOfDay(at(5))).toBe("morning");
    expect(getTimeOfDay(at(11))).toBe("morning");
    expect(getTimeOfDay(at(12))).toBe("afternoon");
    expect(getTimeOfDay(at(16))).toBe("afternoon");
    expect(getTimeOfDay(at(17))).toBe("evening");
    expect(getTimeOfDay(at(20))).toBe("evening");
    expect(getTimeOfDay(at(21))).toBe("night");
  });
});
