# Roadmap

## Ideas

1. Investigate status panel progression during audit v2 runs.
   Current observation: when audit v2 is running, the `orc smash` status panel only shows step 1. It looks like the panel is either not updating, not refreshing correctly, or later updates are being added but are not visible.

2. Investigate `opencode` runner failures.
   Current observation: `codex` and `claude` work, but `opencode` appears not to. This needs targeted investigation to determine whether the issue is in the adapter invocation, local CLI setup, authentication, model choice, or upstream service behavior.

3. Investigate audit artifact ownership / step attribution.
   Current observation: `plan-audit-v2-claude.md` appears to have been produced while running the `plan-follow-up` skill, but it should be an artifact from the `plan-audit` skill. This needs investigation to confirm whether the wrong step wrote the file, the UI/status attribution is incorrect, or the loop is mislabeling which skill produced which artifact.

4. Normalize the top-of-document metadata heading in generated output docs.
   Current observation: the "metadata" heading at the top of output documents does not appear consistent across generated artifacts. This should be standardized so audit/review artifacts use one consistent heading structure and naming convention.

5. Improve status panel visibility for multi-step, multi-role execution.
   Current observation: the `orc smash` status panel appears to show only the auditor's work and does not clearly show the implementer / patcher work. It also does not state the role of the active agent. This should be investigated so the panel makes all active/completed loop steps visible and labels each runner with its role as well as its agent/model.

6. Investigate rerun behavior when implementer becomes visible but verdict becomes `unknown`.
   Current observation: after rerunning the project, the implementer agents showed up in the status/output, but the verdict became `unknown`. This needs investigation to determine whether rerun state recovery, artifact parsing, output attribution, or verdict extraction is breaking when the loop resumes.
