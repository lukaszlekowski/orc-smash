export interface PerSkillOverride {
  agent?: string;
  model?: string;
  effort?: string;
}

export type RunnerOverrideMap = Record<string, PerSkillOverride>;

export interface ParsedOverride {
  skillId: string;
  value: string;
}

export function parseSkillEquals(raw: string): ParsedOverride {
  const eqIdx = raw.indexOf('=');
  if (eqIdx <= 0 || eqIdx === raw.length - 1) {
    throw new Error(`invalid --runner/--runner-model/--runner-effort entry '${raw}': expected skill=value`);
  }
  return {
    skillId: raw.slice(0, eqIdx),
    value: raw.slice(eqIdx + 1)
  };
}

export function collectRunnerOverrides(
  runnerEntries: string[],
  modelEntries: string[],
  validSkillIds: string[]
): RunnerOverrideMap {
  const map: RunnerOverrideMap = {};
  const seenRunner = new Set<string>();
  const seenModel = new Set<string>();

  for (const entry of runnerEntries) {
    const { skillId, value: agent } = parseSkillEquals(entry);
    if (seenRunner.has(skillId)) {
      throw new Error(`Duplicate --runner entry for skill '${skillId}'`);
    }
    if (!validSkillIds.includes(skillId)) {
      throw new Error(`--runner: skill '${skillId}' is not a valid skill in the selected loop. Valid skills: ${validSkillIds.join(', ')}`);
    }
    seenRunner.add(skillId);
    map[skillId] = { ...map[skillId], agent };
  }

  for (const entry of modelEntries) {
    const { skillId, value: model } = parseSkillEquals(entry);
    if (seenModel.has(skillId)) {
      throw new Error(`Duplicate --runner-model entry for skill '${skillId}'`);
    }
    if (!validSkillIds.includes(skillId)) {
      throw new Error(`--runner-model: skill '${skillId}' is not a valid skill in the selected loop. Valid skills: ${validSkillIds.join(', ')}`);
    }
    seenModel.add(skillId);
    map[skillId] = { ...map[skillId], model };
  }

  return map;
}

export function collectEffortOverrides(
  effortEntries: string[],
  validSkillIds: string[],
): RunnerOverrideMap {
  const map: RunnerOverrideMap = {};
  const seen = new Set<string>();

  for (const entry of effortEntries) {
    const { skillId, value: effort } = parseSkillEquals(entry);
    if (seen.has(skillId)) {
      throw new Error(`Duplicate --runner-effort entry for skill '${skillId}'`);
    }
    if (!validSkillIds.includes(skillId)) {
      throw new Error(`--runner-effort: skill '${skillId}' is not a valid skill in the selected loop. Valid skills: ${validSkillIds.join(', ')}`);
    }
    seen.add(skillId);
    map[skillId] = { ...map[skillId], effort };
  }

  return map;
}
