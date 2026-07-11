import type { ModelRegistry } from '../config.js';
import { isValidModelForAgent } from '../runner.js';
import type { Runner } from './runtime.js';

/** Restores a recorded runner only when its provider and model remain usable. */
export function resolveRecordedRunner(
  registry: ModelRegistry,
  agent: string,
  model: string
): Runner | null {
  const allowedModels = registry.providers[agent];
  if (!allowedModels) return null;

  const configuredModel = allowedModels.find(candidate => candidate === model || candidate.endsWith(`/${model}`));
  if (configuredModel) return { agent, model: configuredModel };
  if (isValidModelForAgent(agent, model, registry)) return { agent, model };
  return null;
}
