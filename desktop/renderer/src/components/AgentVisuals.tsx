import { useSkinPack } from "../themes/SkinContext";
import { createSkinAnimationAdapter, moodStateForTaskStatus, type SkinCharacterState, type SkinRobotState } from "../themes/animation";
import { taskStatusToken } from "../themes/task-status";

type AvatarProps = {
  state?: SkinCharacterState;
  label?: string;
  className?: string;
};

export function AgentAvatar({ state = "idle", label = "AI", className = "" }: AvatarProps) {
  const skin = useSkinPack();
  const source = createSkinAnimationAdapter(skin).mood(state) || skin.assets.aiAvatar;
  const initial = Array.from(label.trim())[0] || "A";
  return source
    ? <img className={`agent-avatar-visual ${className}`.trim()} src={source} alt={label} />
    : <span className={`agent-avatar-visual agent-avatar-fallback ${className}`.trim()} aria-label={label}>{initial}</span>;
}

export function StatusMood({ status, label = "" }: { status?: string | null; label?: string }) {
  const skin = useSkinPack();
  const token = taskStatusToken(status);
  const source = createSkinAnimationAdapter(skin).mood(moodStateForTaskStatus(status));
  return source
    ? <img className="status-mood" src={source} alt="" aria-hidden="true" />
    : <span className={`status-mood status-mood-fallback status-mood-${token}`} aria-hidden="true" title={label || token}>{label ? Array.from(label)[0] : ""}</span>;
}

export function ToolRobot({ state, label = "工具执行状态" }: { state: SkinRobotState; label?: string }) {
  const skin = useSkinPack();
  const source = createSkinAnimationAdapter(skin).robot(state);
  return source
    ? <img className="tool-robot-visual" src={source} alt={label} />
    : <span className={`tool-robot-visual tool-robot-fallback tool-robot-${state}`} role="img" aria-label={label}>⚙</span>;
}
