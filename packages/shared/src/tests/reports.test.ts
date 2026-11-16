import { describe, it, expect } from "vitest";

import type { Finding, Verdict } from "../schemas/report.js";
import {
  openCandidateIds,
  principalFindings,
  rankFindings,
  standingFindings,
  supersededIds,
} from "../reports.js";

function claim(id: string, verdict: Verdict, candidate = id): Finding {
  return {
    id,
    verdict,
    candidate,
    explanation: "",
    evidenceIds: [],
    recordedAt: "2026-08-19T02:14:00.000Z",
  };
}

/* The queue row and the report read this, so a second ranking anywhere is two
   answers to "what did the run conclude". */
describe("ranking what a run concluded", () => {
  it("returns every equally confident claim, most recent first", () => {
    const claims = [
      claim("f1", "root_cause", "c1"),
      claim("f2", "root_cause", "c2"),
    ];

    expect(principalFindings(claims).map((f) => f.id)).toEqual(["f2", "f1"]);
    expect(rankFindings(claims).map((f) => f.id)).toEqual(["f2", "f1"]);
  });

  it("keeps a lower-ranked standing claim out of the principal set", () => {
    const claims = [
      claim("f1", "root_cause", "c1"),
      claim("f2", "contributing_factor", "c2"),
    ];

    expect(principalFindings(claims).map((f) => f.id)).toEqual(["f1"]);
  });

  it("never leads with what the run ruled out or could not reach", () => {
    expect(
      principalFindings([
        claim("f1", "symptom", "c1"),
        claim("f2", "disproven", "c2"),
      ]).map((f) => f.id),
    ).toEqual(["f1"]);
    expect(principalFindings([claim("f1", "disproven", "c1")])).toEqual([]);
    expect(principalFindings([claim("f1", "untestable", "c1")])).toEqual([]);
  });
});

/* Position within a candidate decides this, so a run that settles the same
   candidate twice states one verdict rather than two rival ones. */
describe("what a candidate's findings say now", () => {
  it("names one root cause per candidate however often each was settled", () => {
    // The ledger a live run wrote: three candidates, nine findings, two claims.
    const claims = [
      claim("f1", "root_cause", "c1"),
      claim("f2", "contributing_factor", "c2"),
      claim("f3", "root_cause", "c1"),
      claim("f4", "root_cause", "c1"),
      claim("f5", "root_cause", "c3"),
      claim("f6", "contributing_factor", "c2"),
      claim("f7", "disproven", "c2"),
      claim("f8", "root_cause", "c3"),
      claim("f9", "root_cause", "c3"),
    ];

    expect(principalFindings(claims).map((f) => f.id)).toEqual(["f9", "f4"]);
    // c2 stands disproven, so it leads nothing and is ruled out exactly once.
    expect(standingFindings(claims).map((f) => f.candidate)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    // Every finding but each candidate's newest is superseded.
    expect([...supersededIds(claims)].sort()).toEqual([
      "f1",
      "f2",
      "f3",
      "f5",
      "f6",
      "f8",
    ]);
  });
});

describe("which candidates are still open", () => {
  it("counts a candidate open until some finding names it", () => {
    const record = {
      candidates: [
        {
          id: "c1",
          statement: "one",
          ifTrue: "",
          ifFalse: "",
          openedAtEvidence: 0,
        },
        {
          id: "c2",
          statement: "two",
          ifTrue: "",
          ifFalse: "",
          openedAtEvidence: 0,
        },
      ],
      findings: [claim("f1", "root_cause", "c1")],
      report: null,
      updatedAt: "2026-08-19T02:14:00.000Z",
    };

    expect(openCandidateIds(record)).toEqual(["c2"]);
  });
});
