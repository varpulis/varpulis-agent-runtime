export {
  proposeRule,
  isDuplicate,
  applyRule,
  evaluate,
} from "./rules.js";
export type { LearnProposal } from "./rules.js";
export { proposeHook, mergeHookConfig } from "./hooks.js";
export type { HookProposal, HookConfig } from "./hooks.js";
export { proposeCommand, isCommandDuplicate } from "./commands.js";
export type { CommandProposal } from "./commands.js";
