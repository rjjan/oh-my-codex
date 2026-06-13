import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEEP_INTERVIEW_ALLOWED_WRITE_PREFIXES,
  PLANNING_HEREDOC_WRITE_BLOCK_FEEDBACK,
  RALPLAN_ALLOWED_WRITE_PREFIXES,
  evaluatePlanningBashWritePolicy,
  evaluatePlanningFileToolPolicy,
  extractPlanningCommandRedirectTargets,
  stripBashHeredocBodies,
} from "../planning-artifact-write-policy.js";

describe("planning-artifact-write-policy", () => {
  const cwd = "/workspace/project";

  it("strips quoted heredoc bodies before redirect target parsing", () => {
    const command = "cat <<'EOF' > .omx/specs/deep-interview-lox.md\n--interpreter <path>\nsource -> parser\nEOF";

    assert.equal(stripBashHeredocBodies(command).includes("<path>"), false);
    assert.deepEqual(extractPlanningCommandRedirectTargets(command), [".omx/specs/deep-interview-lox.md"]);
  });

  it("strips unquoted heredoc bodies before redirect target parsing", () => {
    const command = "cat <<EOF > .omx/context/interview.md\nnext step > fake-target.md\nEOF";

    assert.equal(stripBashHeredocBodies(command).includes("fake-target.md"), false);
    assert.deepEqual(extractPlanningCommandRedirectTargets(command), [".omx/context/interview.md"]);
  });

  it("blocks Bash heredoc file writes to planning artifacts", () => {
    const result = evaluatePlanningBashWritePolicy({
      cwd,
      command: "cat <<'EOF' > .omx/specs/deep-interview-lox.md\n# Spec\nEOF",
      allowedPrefixes: DEEP_INTERVIEW_ALLOWED_WRITE_PREFIXES,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.reason, "bash-heredoc-write");
    assert.equal(result.feedback, PLANNING_HEREDOC_WRITE_BLOCK_FEEDBACK);
  });

  it("allows heredocs with no file write intent", () => {
    const result = evaluatePlanningBashWritePolicy({
      cwd,
      command: "cat <<'EOF'\nomx question text with <path>\nEOF",
      allowedPrefixes: DEEP_INTERVIEW_ALLOWED_WRITE_PREFIXES,
    });

    assert.equal(result.allowed, true);
  });

  it("allows non-heredoc redirects only for the active mode prefixes", () => {
    const deepSpec = evaluatePlanningBashWritePolicy({
      cwd,
      command: "printf '%s\\n' planning > .omx/specs/deep-interview-lox.md",
      allowedPrefixes: DEEP_INTERVIEW_ALLOWED_WRITE_PREFIXES,
    });
    const deepPlan = evaluatePlanningBashWritePolicy({
      cwd,
      command: "printf '%s\\n' planning > .omx/plans/prd-lox.md",
      allowedPrefixes: DEEP_INTERVIEW_ALLOWED_WRITE_PREFIXES,
    });
    const ralplanPlan = evaluatePlanningBashWritePolicy({
      cwd,
      command: "printf '%s\\n' planning > .omx/plans/prd-lox.md",
      allowedPrefixes: RALPLAN_ALLOWED_WRITE_PREFIXES,
    });

    assert.equal(deepSpec.allowed, true);
    assert.equal(deepPlan.allowed, false);
    assert.equal(ralplanPlan.allowed, true);
  });

  it("blocks redirects to implementation files", () => {
    const result = evaluatePlanningBashWritePolicy({
      cwd,
      command: "printf '%s\\n' code > src/runtime.ts",
      allowedPrefixes: RALPLAN_ALLOWED_WRITE_PREFIXES,
    });

    assert.equal(result.allowed, false);
    assert.deepEqual(result.targets, ["src/runtime.ts"]);
  });

  it("allows apply_patch when every target is a planning artifact", () => {
    const result = evaluatePlanningFileToolPolicy({
      cwd,
      toolName: "apply_patch",
      toolInput: {
        patch:
          "*** Begin Patch\n"
          + "*** Add File: .omx/specs/deep-interview-lox.md\n"
          + "+# Spec\n"
          + "*** Update File: .omx/context/interview.md\n"
          + "@@\n"
          + "+context\n"
          + "*** Delete File: .omx/state/old.json\n"
          + "*** Move to: .omx/specs/deep-interview-lox-renamed.md\n"
          + "*** End Patch\n",
      },
      allowedPrefixes: DEEP_INTERVIEW_ALLOWED_WRITE_PREFIXES,
    });

    assert.equal(result.allowed, true);
  });

  it("blocks apply_patch when any target is outside planning artifacts", () => {
    const result = evaluatePlanningFileToolPolicy({
      cwd,
      toolName: "ApplyPatch",
      toolInput: {
        patch:
          "*** Begin Patch\n"
          + "*** Add File: .omx/plans/prd-lox.md\n"
          + "+# Plan\n"
          + "*** Update File: src/runtime.ts\n"
          + "@@\n"
          + "+implementation\n"
          + "*** End Patch\n",
      },
      allowedPrefixes: RALPLAN_ALLOWED_WRITE_PREFIXES,
    });

    assert.equal(result.allowed, false);
    assert.deepEqual(result.targets, [".omx/plans/prd-lox.md", "src/runtime.ts"]);
  });
});
