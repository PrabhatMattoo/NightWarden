import { updateRecord } from "../session/record-store.js";
import { composeReport } from "../agent/report.js";

/* Candidates for a test to settle, so RecordFinding has something to name. The
   claim lives here, so a test asserting on one names it here too. */
export async function seedCandidates(
  sessionId: string,
  count = 1,
  statements: string[] = [],
): Promise<string[]> {
  return await updateRecord(sessionId, (record) => {
    const added = Array.from({ length: count }, (_, i) => ({
      id: `c${record.candidates.length + i + 1}`,
      statement:
        statements[i] ?? `seeded candidate ${record.candidates.length + i + 1}`,
      ifTrue: "seeded",
      ifFalse: "seeded",
      openedAtEvidence: 0,
    }));
    return {
      next: { ...record, candidates: [...record.candidates, ...added] },
      value: added.map((c) => c.id),
    };
  });
}

// Satisfies the finish gate for tests exercising run mechanics: one candidate
// carrying one finding is a complete record, so the run reaches its report turn.
export async function seedCompleteReport(sessionId: string): Promise<void> {
  await updateRecord(sessionId, (record) => ({
    next: {
      ...record,
      candidates: [
        {
          id: "c1",
          statement: "seeded by test",
          ifTrue: "seeded",
          ifFalse: "seeded",
          openedAtEvidence: 0,
        },
      ],
      findings: [
        {
          id: "f1",
          verdict: "disproven",
          candidate: "c1",
          explanation: "",
          evidenceIds: [],
          recordedAt: new Date().toISOString(),
        },
      ],
    },
    value: null,
  }));
}

// A finished write-up carrying one recommendation, for tests about what an
// investigation is waiting on rather than about how it was written.
export async function seedRecommendation(
  sessionId: string,
  recommendation: string,
): Promise<void> {
  await composeReport(sessionId, {
    headline: "seeded by test",
    affected: "seeded by test",
    summary: "seeded by test",
    timeline: [],
    impact: "",
    recommendation,
  });
}
