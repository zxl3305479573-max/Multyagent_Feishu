import type { SkinDefinition } from "./types";
import { taskStatusToken } from "./task-status";

export type SkinCharacterState = "idle" | "thinking" | "planning" | "executing" | "success" | "error" | "confirm";
export type SkinRobotState = "idle" | "working" | "loading" | "error";

export interface SkinAnimationAdapter {
  mood(state: SkinCharacterState): string | undefined;
  robot(state: SkinRobotState): string | undefined;
}

export class StaticSkinAnimationAdapter implements SkinAnimationAdapter {
  constructor(private readonly skin: SkinDefinition) {}

  mood(state: SkinCharacterState) {
    const moods = this.skin.assets?.moods;
    const key = state === "planning" || state === "executing" ? "thinking"
      : state === "success" ? "happy"
        : state === "error" ? "surprised"
          : state === "confirm" ? "puzzled"
            : state === "idle" ? "sleepy" : state;
    return moods?.[key];
  }

  robot(state: SkinRobotState) {
    return this.skin.assets?.robots?.[state] || this.skin.assets?.toolRobotIcon;
  }
}

export function createSkinAnimationAdapter(skin: SkinDefinition): SkinAnimationAdapter {
  return new StaticSkinAnimationAdapter(skin);
}

/** Future integration point: a Rive (.riv) or Lottie (.json) adapter can implement
 * SkinAnimationAdapter and replace these static image lookups without changing UI callers.
 */
export function createRiveSkinAnimationAdapter(_skin: SkinDefinition): SkinAnimationAdapter | null {
  return null;
}

export function moodStateForTaskStatus(status?: string | null): SkinCharacterState {
  switch (taskStatusToken(status)) {
    case "planning": return "planning";
    case "running": return "executing";
    case "waiting-approval": return "confirm";
    case "completed": return "success";
    case "failed": return "error";
    default: return "idle";
  }
}
