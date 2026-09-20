// The frontend renders what the API projects; the item shapes live in shared so
// both ends compile against one definition.
export type {
  ToolGate,
  ToolCallState,
  UserTurnItem,
  AgentTextItem,
  ErrorTextItem,
  ToolCallItem,
  ContinueCardItem,
  ReportCardItem,
  CandidateRow,
  CandidateCardItem,
  AlertArrivedItem,
  CompactionItem,
  TranscriptItem,
} from "@nightwarden/shared";

/* What a run says it is doing, and whether that is work of its own or a wait on
   something outside it, which the line is drawn differently for. */
export interface ActivityLine {
  text: string;
  waiting: boolean;
}
