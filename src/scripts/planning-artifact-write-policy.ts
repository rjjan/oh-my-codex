import { relative, resolve } from "path";

export const DEEP_INTERVIEW_ALLOWED_WRITE_PREFIXES = [
  ".omx/context",
  ".omx/interviews",
  ".omx/specs",
  ".omx/state",
] as const;

export const RALPLAN_ALLOWED_WRITE_PREFIXES = [
  ".omx/context",
  ".omx/plans",
  ".omx/specs",
  ".omx/state",
] as const;

export const PLANNING_HEREDOC_WRITE_BLOCK_FEEDBACK =
  "Bash heredoc file writes are not allowed for planning artifacts. No artifact was written. Retry with apply_patch, Write, or Edit.";

const PLANNING_FILE_TOOL_NAMES = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
  "ApplyPatch",
]);

const APPLY_PATCH_TOOL_NAMES = new Set(["apply_patch", "ApplyPatch"]);

export type PlanningWritePolicyReason =
  | "allowed-targets"
  | "bash-heredoc-write"
  | "disallowed-targets"
  | "missing-targets"
  | "no-write-intent"
  | "non-planning-tool"
  | "omx-runtime-command";

export type PlanningWritePolicyResult = {
  applies: boolean;
  allowed: boolean;
  reason: PlanningWritePolicyReason;
  targets: string[];
  feedback?: string;
};

export type PlanningBashWritePolicyInput = {
  cwd: string;
  command: string;
  allowedPrefixes: readonly string[];
};

export type PlanningFileToolPolicyInput = {
  cwd: string;
  toolName: string;
  toolInput: unknown;
  allowedPrefixes: readonly string[];
};

type HeredocMarker = {
  delimiter: string;
  stripLeadingTabs: boolean;
};

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function trimShellQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function isNullDeviceRedirectTarget(target: string): boolean {
  const normalized = trimShellQuotes(target).toLowerCase();
  return normalized === "/dev/null" || normalized === "nul";
}

function isAllowedPlanningArtifactPath(
  cwd: string,
  rawPath: string,
  allowedPrefixes: readonly string[],
): boolean {
  const trimmed = trimShellQuotes(rawPath);
  if (!trimmed || trimmed.includes("\0")) return false;
  let relativePath: string;
  try {
    const absolute = resolve(cwd, trimmed);
    relativePath = relative(cwd, absolute).replace(/\\/g, "/");
  } catch {
    return false;
  }
  if (!relativePath || relativePath.startsWith("..") || relativePath.startsWith("/")) return false;
  return allowedPrefixes.some((prefix) => (
    relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  ));
}

function readPathCandidates(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return [];
  const input = toolInput as Record<string, unknown>;
  const candidates = [
    input.file_path,
    input.filePath,
    input.path,
    input.target_path,
    input.targetPath,
  ];
  return candidates.map((candidate) => safeString(candidate).trim()).filter(Boolean);
}

function collectStringValues(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStringValues(item, output);
    }
  }
  return output;
}

function readHeredocMarkers(line: string): HeredocMarker[] {
  const markers: HeredocMarker[] = [];
  for (const match of line.matchAll(/<<(-)?\s*(?:"([^"]+)"|'([^']+)'|(\\?[^\s;&|<>]+))/g)) {
    const rawDelimiter = match[2] ?? match[3] ?? match[4] ?? "";
    const delimiter = rawDelimiter.replace(/^\\/, "");
    if (!delimiter) continue;
    markers.push({
      delimiter,
      stripLeadingTabs: match[1] === "-",
    });
  }
  return markers;
}

export function commandHasBashHeredoc(command: string): boolean {
  return readHeredocMarkers(command).length > 0;
}

export function stripBashHeredocBodies(command: string): string {
  const lines = command.split(/\r?\n/);
  const output: string[] = [];
  const pending: HeredocMarker[] = [];

  for (const line of lines) {
    if (pending.length > 0) {
      const marker = pending[0];
      const candidate = marker.stripLeadingTabs ? line.replace(/^\t+/, "") : line;
      if (candidate.trim() === marker.delimiter) pending.shift();
      continue;
    }

    output.push(line);
    pending.push(...readHeredocMarkers(line));
  }

  return output.join("\n");
}

export function extractPlanningCommandRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  const strippedCommand = stripBashHeredocBodies(command);
  for (const match of strippedCommand.matchAll(/(?:^|[^>])>{1,2}\s*(["']?)([^\s&|;<>]+)\1/g)) {
    const candidate = safeString(match[2]).trim();
    if (candidate && !isNullDeviceRedirectTarget(candidate)) targets.push(candidate);
  }
  return targets;
}

export function extractPlanningCommandWriteTargets(command: string): string[] {
  const targets = extractPlanningCommandRedirectTargets(command);
  const strippedCommand = stripBashHeredocBodies(command);
  for (const match of strippedCommand.matchAll(/\btee\s+(?:-a\s+)?(["']?)([^\s&|;<>]+)\1/g)) {
    const candidate = safeString(match[2]).trim();
    if (candidate) targets.push(candidate);
  }
  return targets;
}

export function commandHasPlanningWriteIntent(command: string): boolean {
  const strippedCommand = stripBashHeredocBodies(command);
  return /\bapply_patch\b/.test(strippedCommand)
    || extractPlanningCommandRedirectTargets(command).length > 0
    || /\btee\s+(?:-a\s+)?[^\s&|;]+/.test(strippedCommand)
    || /\bsed\s+(?:[^\n;&|]*\s)?-i(?:\b|['"])/.test(strippedCommand)
    || /\b(?:python3?|node|perl|ruby)\b[\s\S]{0,260}\b(?:writeFileSync|writeFile|write_text|open\([^)]*["']w|File\.write|Path\()/.test(strippedCommand)
    || /\b(?:git\s+(?:checkout|switch|restore|reset|apply|am|merge|rebase)|npm\s+(?:install|i|ci)|pnpm\s+(?:install|i)|yarn\s+(?:install|add))\b/.test(strippedCommand);
}

function isAllowedOmxRuntimeCommand(command: string): boolean {
  return /\bomx\s+(?:state\s+(?:write|read|clear)|question)\b/.test(command);
}

export function evaluatePlanningBashWritePolicy(
  input: PlanningBashWritePolicyInput,
): PlanningWritePolicyResult {
  if (!commandHasPlanningWriteIntent(input.command)) {
    return { applies: true, allowed: true, reason: "no-write-intent", targets: [] };
  }
  if (isAllowedOmxRuntimeCommand(input.command)) {
    return { applies: true, allowed: true, reason: "omx-runtime-command", targets: [] };
  }

  const targets = extractPlanningCommandWriteTargets(input.command);
  if (commandHasBashHeredoc(input.command)) {
    return {
      applies: true,
      allowed: false,
      reason: "bash-heredoc-write",
      targets,
      feedback: PLANNING_HEREDOC_WRITE_BLOCK_FEEDBACK,
    };
  }
  if (targets.length === 0) {
    return { applies: true, allowed: false, reason: "missing-targets", targets };
  }
  if (targets.every((target) => isAllowedPlanningArtifactPath(input.cwd, target, input.allowedPrefixes))) {
    return { applies: true, allowed: true, reason: "allowed-targets", targets };
  }
  return { applies: true, allowed: false, reason: "disallowed-targets", targets };
}

export function extractApplyPatchTargets(toolInput: unknown): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const text of collectStringValues(toolInput)) {
    for (const line of text.split(/\r?\n/)) {
      const fileMatch = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
      const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
      const target = safeString(fileMatch?.[1] ?? moveMatch?.[1]).trim();
      if (!target || seen.has(target)) continue;
      seen.add(target);
      targets.push(target);
    }
  }
  return targets;
}

export function evaluatePlanningFileToolPolicy(
  input: PlanningFileToolPolicyInput,
): PlanningWritePolicyResult {
  if (!PLANNING_FILE_TOOL_NAMES.has(input.toolName)) {
    return { applies: false, allowed: true, reason: "non-planning-tool", targets: [] };
  }

  const targets = APPLY_PATCH_TOOL_NAMES.has(input.toolName)
    ? extractApplyPatchTargets(input.toolInput)
    : readPathCandidates(input.toolInput);

  if (targets.length === 0) {
    return { applies: true, allowed: false, reason: "missing-targets", targets };
  }
  if (targets.every((target) => isAllowedPlanningArtifactPath(input.cwd, target, input.allowedPrefixes))) {
    return { applies: true, allowed: true, reason: "allowed-targets", targets };
  }
  return { applies: true, allowed: false, reason: "disallowed-targets", targets };
}
