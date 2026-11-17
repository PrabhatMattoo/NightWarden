export type { AlertSourceKind } from "./alerts.js";
export { ALERT_SOURCE_KINDS, isAlertSourceKind } from "./alerts.js";
export type { ThemePreference } from "./auth.js";
export {
  AVATAR_MAX_LENGTH,
  AVATAR_PATTERN,
  AVATAR_SIZE_PX,
  PASSWORD_MIN_LENGTH,
  THEME_PREFERENCES,
} from "./auth.js";
export type {
  DockerServiceIdentity,
  KubernetesWorkloadIdentity,
  K8sWorkloadKind,
} from "./service-identity.js";
export {
  composeServiceLabels,
  deriveDockerServiceIdentity,
  dockerServiceKey,
  kubernetesWorkloadKey,
  parseTargetKey,
} from "./service-identity.js";
export type { LogLine, NotFoundResult, FleetResult } from "./tools/common.js";
export type { Coverage, CoverageKept } from "./tools/coverage.js";
export { coverageOf, fitList, ITEM_BUDGET_CHARS } from "./tools/coverage.js";
export type {
  DockerContainerInstance,
  DockerServiceListResult,
  DockerLogsResult,
  DockerConfigResult,
  DockerStatsResult,
  DockerEvent,
  DockerEventsResult,
  DockerProcess,
  DockerProcessesResult,
  DockerRestartResult,
  DockerExecResult,
} from "./tools/docker.js";
export type {
  K8sWorkloadInstance,
  K8sWorkloadListResult,
  K8sLogsResult,
  K8sProbe,
  K8sContainerSpec,
  K8sConfigResult,
  K8sContainerStats,
  K8sPodStats,
  K8sStatsResult,
  K8sEvent,
  K8sEventsResult,
  K8sProcess,
  K8sProcessesResult,
  K8sRestartResult,
  K8sRolloutStatusResult,
  K8sExecResult,
  K8sNodeCondition,
  K8sNode,
  K8sNodeStatusResult,
} from "./tools/kubernetes.js";
export type {
  HostMemoryResult,
  HostCpuResult,
  HostDiskResult,
  HostNetworkResult,
  HostDmesgResult,
  HostFileResult,
} from "./tools/host.js";
export {
  DOCKER_TOOL_NAMES,
  KUBERNETES_TOOL_NAMES,
  TOOL_NAMES,
  isTool,
  isToolName,
} from "./tools/names.js";
export { METRICS_SOURCE_KINDS, isMetricsSourceKind } from "./metrics.js";
export type { AmpCredential, MetricsSourceKind } from "./metrics.js";
export type { ToolName } from "./tools/names.js";
export type {
  RunnerMessage,
  RunnerCommandMessage,
  RunnerConnectedMessage,
  RunnerIdentityMessage,
  HideContainerMessage,
  RunnerManifestMessage,
  RunnerResultMessage,
} from "./schemas/runner-protocol.js";
export type {
  FrontendHumanInputResolved,
  FrontendInterruptResolved,
  FrontendTextMessageContent,
  FrontendMessage,
  FrontendRunFinished,
  FrontendTranscriptItem,
  FrontendHumanInputRequired,
  FrontendInterrupt,
  FrontendRunStopped,
  FrontendSandboxStatus,
  FrontendRunRetrying,
  FrontendRunFailed,
  FrontendSessionTitleUpdated,
  FrontendSessionOpened,
  FrontendReportUpdated,
  FrontendEvent,
} from "./frontend-events.js";
export type {
  DockerFleetRunner,
  FleetRunner,
  KubernetesFleetRunner,
  Platform,
} from "./runner.js";
export { PLATFORMS, serverNameError } from "./runner.js";
export type {
  TranscriptKind,
  ReminderKind,
  TranscriptRow,
  FailureKind,
  AwaitingKind,
  SessionKind,
  StatusFilter,
} from "./sessions.js";
export { FILTER_STATUSES, STATUS_FILTERS } from "./sessions.js";
export type {
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
  ToolRefusal,
  ToolApprovalPart,
  ElicitationAnswerPart,
  CompactionPart,
  MessagePart,
  PartProviderOptions,
} from "./messages.js";
export { messagePartsToText, toolResultText } from "./messages.js";
export { transcriptItemKey } from "./transcript.js";
export type { RecordGapKind } from "./reports.js";
export {
  rankFindings,
  claimOf,
  principalFindings,
  openCandidateIds,
  standingFindings,
  supersededIds,
} from "./reports.js";
export type {
  LLMProviderName,
  SandboxNetwork,
  ResolvedLLMConfig,
  NumericSetting,
  SettingRange,
} from "./config.js";
export {
  LLM_PROVIDER_NAMES,
  REASONING_LEVELS,
  SANDBOX_HOST_PATTERN,
  SANDBOX_NETWORKS,
  SETTING_RANGES,
} from "./config.js";

// The HTTP contract, inferred from the route schemas. Type-only, so the
// frontend that reads them never ships zod.
export type { paths } from "./openapi.js";
export type { AuthStatusResponse } from "./schemas/auth.js";
export type {
  AgentConfig,
  CatalogError,
  ConfigPatch,
  SettingsPatch,
  ModelCatalog,
  ModelCheck,
  ModelCheckReason,
  ModelOption,
  ProviderOption,
  ProviderSettings,
  ProviderSettingsMap,
  ReasoningDescriptor,
  ReasoningLevel,
} from "./schemas/config.js";
export type { RespondRequest } from "./schemas/http.js";
export type {
  AlertSourceStatus,
  CredentialRejection,
  GitHubErrorBody,
  GitHubErrorCode,
  GitHubIntegrationStatus,
  GitHubRepoPage,
  GitHubRepoSummary,
  LokiErrorCode,
  LokiIntegrationStatus,
  MetricsConnectInput,
  MetricsEndpointInput,
  MetricsEndpointStatus,
  MetricsErrorCode,
  MetricsSourceStatus,
  SandboxPreflight,
  SentryErrorCode,
  SentryIntegrationStatus,
} from "./schemas/integrations.js";
export type {
  Actor,
  Candidate,
  EvidenceKind,
  Finding,
  GatedCall,
  InvestigationRecord,
  ResolvedEvidence,
  SessionReportResponse,
  SubmittedReport,
  TimelineEntry,
  TimelineLane,
  Verdict,
} from "./schemas/report.js";
export type {
  DockerManifest,
  DockerServiceEntry,
  KubernetesManifest,
  KubernetesWorkloadEntry,
  RunnerManifest,
} from "./schemas/runner-protocol.js";
export type { CreatedRunner, RunnerRecord } from "./schemas/runner.js";
export type {
  AlertGroupContext,
  ApprovalResponse,
  InvestigationStatus,
  NormalizedAlert,
  SessionAlert,
  SessionDetail,
  SessionListPage,
  SessionListRow,
  SessionMeta,
} from "./schemas/sessions.js";
export type {
  AgentTextItem,
  AlertArrivedItem,
  ApprovalStatus,
  CandidateCardItem,
  CandidateRow,
  CompactionItem,
  ContinueCardItem,
  ErrorTextItem,
  ReportCardItem,
  ToolCallItem,
  ToolCallState,
  ToolGate,
  TranscriptItem,
  UserTurnItem,
} from "./schemas/transcript.js";
