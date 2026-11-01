import type { ReactNode } from "react";
import type { AgentExecutionGroup, EventRecord, Task } from "../types";
import { useSkinPack } from "../themes/SkinContext";
import { TaskPanel } from "./TaskPanel";

type Props = {
  selectedTask?: Task;
  events: EventRecord[];
  groups: AgentExecutionGroup[];
  onQuickEntry: (prompt: string) => void;
  children: ReactNode;
};

export function HomeWorkspace({ selectedTask, events, groups, onQuickEntry, children }: Props) {
  const skin = useSkinPack();
  const { brand } = skin;
  return <div className="workspace-layout home-workspace">
    <section className="workspace-center home-workspace-main" aria-label={`${brand.displayName} 欢迎区`}>
      <div className="home-welcome">
        {skin.assets.welcomeIllustration
          ? <img src={skin.assets.welcomeIllustration} alt={`${brand.displayName} 欢迎插画`} />
          : <div className="neutral-hero-visual" aria-hidden="true"><span>{Array.from(brand.displayName)[0] || "A"}</span><i /><i /></div>}
        <div>
          <p>{brand.slogan}</p>
          <h2>{brand.welcomeText}</h2>
          <span>{brand.welcomeDescription}</span>
        </div>
      </div>
      <div className="home-quick-entries" aria-label="快捷任务入口">
        {brand.quickEntries.map((entry) => <button key={entry.id} type="button" onClick={() => onQuickEntry(entry.prompt)}>
          <i aria-hidden="true">{entry.icon}</i>
          <strong>{entry.label}</strong>
          {entry.description && <span>{entry.description}</span>}
        </button>)}
      </div>
      <div className="home-composer-slot">{children}</div>
    </section>
    <TaskPanel selectedTask={selectedTask} events={events} groups={groups} />
  </div>;
}
