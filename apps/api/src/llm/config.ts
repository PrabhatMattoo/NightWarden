// These seed the global config row, and the loop reads effective values from it
// rather than from here. MAX_OUTPUT_TOKENS covers models publishing no ceiling.
export const MAX_OUTPUT_TOKENS = 32_000;

// The SDK spends these on the request, and again on a stream that fails part way.
export const MAX_RETRIES = 3;

/* Before the first token a model may reason unseen or compact a long history,
   so the wait is long; once output flows, a two-minute silence is a stall. */
export const FIRST_CHUNK_TIMEOUT_MS = 5 * 60_000;
export const CHUNK_TIMEOUT_MS = 2 * 60_000;

// Room for a real incident's several alert groups while a storm spends ten runs an hour.
export const DEFAULT_MAX_INVESTIGATIONS_PER_HOUR = 10;

// How long the agent works before finishing its current step and asking whether
// to continue. Not a kill switch: the continue gate is what it reaches.
export const DEFAULT_CHECK_IN_AFTER_MS = 30 * 60_000;

// Upper bound on any single tool call. Individual tools declare their own, often
// far lower; this is the user's brake on the slowest of them.
export const DEFAULT_TOOL_CALL_CEILING_MS = 10 * 60_000;

// For a tool that declares no limit of its own. A property of the tool, not a
// preference, so it stays a constant rather than a setting.
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

// Listing models and reading the capability snapshot: a run resolves its model
// through both, and the settings form waits on them.
export const CATALOG_TIMEOUT_MS = 10_000;

// The ceiling on one tool result, counted in the characters the model reads.
// Claude Code's Bash tool and OpenHands' runtime arrived at the same figure.
export const MAX_TOOL_RESULT_CHARS = 30_000;

// A result past the ceiling is kept whole for paging, up to this much.
export const MAX_STORED_RESULT_CHARS = 2_000_000;

export const DEFAULT_SANDBOX_IDLE_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_SANDBOX_CPUS = 2;
export const DEFAULT_SANDBOX_MEMORY_MB = 4096;

// Sandbox egress reaches only these hosts, listed in full: the host pattern
// refuses wildcards. GitHub release assets redirect to githubusercontent.com.
export const DEFAULT_SANDBOX_NETWORK = "allowlist" as const;
export const DEFAULT_SANDBOX_ALLOWLIST_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  "classic.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "static.rust-lang.org",
  "sh.rustup.rs",
  "proxy.golang.org",
  "sum.golang.org",
  "dl.google.com",
  "go.dev",
  "rubygems.org",
  "index.rubygems.org",
  "repo.packagist.org",
  "packagist.org",
  "repo.hex.pm",
  "hex.pm",
  "builds.hex.pm",
  "api.nuget.org",
  "builds.dotnet.microsoft.com",
  "dot.net",
  "ci.dot.net",
  "nodejs.org",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "mise-versions.jdx.dev",
  "mise-java.jdx.dev",
  "tuf-repo-cdn.sigstore.dev",
];
