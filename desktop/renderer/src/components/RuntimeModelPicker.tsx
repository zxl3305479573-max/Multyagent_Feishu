import React, { useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeConfig } from "../types";

type Props = {
  config: RuntimeConfig | null;
  connected: boolean;
  busy: boolean;
  onLoadProvider: (provider: string) => Promise<RuntimeConfig>;
  onSelect: (input: { provider: string; model: string; thinking: string }) => void;
  onThinking: (thinking: string) => void;
};

function providerName(config: RuntimeConfig, id: string) {
  return config.providers.find((provider) => provider.id === id)?.name || id;
}

function modelName(config: RuntimeConfig, id: string) {
  return config.models.find((model) => model.id === id)?.name || id;
}

function close(button: HTMLButtonElement) {
  button.closest("details")?.removeAttribute("open");
}

/** 输入框右下角的运行模型与思考强度切换器。切换只影响后续 Agent 执行。 */
export function RuntimeModelPicker({ config, connected, busy, onLoadProvider, onSelect, onThinking }: Props) {
  const [listing, setListing] = useState<RuntimeConfig | null>(config);
  const [provider, setProvider] = useState(config?.provider || "");
  const [query, setQuery] = useState("");
  const [loadingProvider, setLoadingProvider] = useState(false);
  const [loadError, setLoadError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setListing(config);
    setProvider(config?.provider || "");
  }, [config]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      for (const details of rootRef.current?.querySelectorAll<HTMLDetailsElement>("details[open]") || []) {
        if (!details.contains(target)) details.removeAttribute("open");
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      for (const details of rootRef.current?.querySelectorAll<HTMLDetailsElement>("details[open]") || []) details.removeAttribute("open");
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  const thinking = config?.thinkingLevels.find((item) => item.value === config.thinking);
  const models = useMemo(() => {
    const source = listing?.listingProvider === provider ? listing.models : [];
    const needle = query.trim().toLowerCase();
    return needle ? source.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(needle)) : source;
  }, [listing, provider, query]);

  async function loadProvider(nextProvider: string) {
    setProvider(nextProvider);
    setQuery("");
    setLoadingProvider(true);
    setLoadError("");
    try {
      const next = await onLoadProvider(nextProvider);
      if (next.listingProvider === nextProvider) setListing(next);
    } catch (error) {
      setLoadError((error as Error).message || "读取模型列表失败");
    } finally {
      setLoadingProvider(false);
    }
  }

  function chooseModel(model: string, button: HTMLButtonElement) {
    if (!config || !provider || !model || busy) return;
    onSelect({ provider, model, thinking: config.thinking });
    close(button);
  }

  function chooseThinking(level: string, button: HTMLButtonElement) {
    if (!config || busy) return;
    onThinking(level);
    close(button);
  }

  if (!connected) return <span className="composer-model-loading composer-model-offline">模型未连接</span>;
  if (!config) return <span className="composer-model-loading">模型加载中…</span>;
  return <div className="composer-runtime-pickers" ref={rootRef}>
    <details className="composer-picker composer-model-picker">
      <summary title={`当前模型：${providerName(config, config.provider)} / ${modelName(config, config.model)}`}>
        <span className="composer-picker-mark">M</span>
        <span className="composer-picker-value">{providerName(config, config.provider)} · {modelName(config, config.model)}</span>
        <span className="composer-picker-chevron">⌄</span>
      </summary>
      <div className="composer-popover model-popover">
        <div className="composer-popover-heading"><strong>模型</strong><span>切换后从下一次 Agent 执行开始生效</span></div>
        <label className="model-provider-select">服务商
          <select value={provider} disabled={busy || loadingProvider} onChange={(event) => void loadProvider(event.target.value)}>
            {config.providers.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.modelCount}）</option>)}
          </select>
        </label>
        <input className="model-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" aria-label="搜索模型" />
        <div className="model-choice-list">
          {loadError ? <p className="model-choice-empty model-choice-error">{loadError}</p> : null}
          {loadingProvider ? <p className="model-choice-empty">正在读取模型…</p> : models.map((model) => <button key={model.id} type="button" className={provider === config.provider && model.id === config.model ? "is-selected" : ""} disabled={busy} onClick={(event) => chooseModel(model.id, event.currentTarget)}>
            <span><strong>{model.name}</strong><small>{model.id}</small></span>
            <span className="model-choice-meta">{model.reasoning ? "推理" : ""}{model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}K` : ""}</span>
          </button>)}
          {!loadingProvider && !models.length && <p className="model-choice-empty">没有匹配的模型</p>}
          {query.trim() && <button type="button" className="model-manual-choice" disabled={busy} onClick={(event) => chooseModel(query.trim(), event.currentTarget)}>使用模型 ID “{query.trim()}”</button>}
        </div>
      </div>
    </details>
    <details className="composer-picker composer-thinking-picker">
      <summary title={`思考强度：${thinking?.label || config.thinking}`}>
        <span className="composer-picker-mark">T</span>
        <span className="composer-picker-value">{thinking?.label || config.thinking}</span>
        <span className="composer-picker-chevron">⌄</span>
      </summary>
      <div className="composer-popover thinking-popover">
        <div className="composer-popover-heading"><strong>思考强度</strong><span>从下一次 Agent 执行开始生效</span></div>
        {config.thinkingLevels.map((level) => <button key={level.value} type="button" className={config.thinking === level.value ? "is-selected" : ""} disabled={busy} onClick={(event) => chooseThinking(level.value, event.currentTarget)}>
          <span>{level.label}</span><small>{level.value}</small>
        </button>)}
      </div>
    </details>
  </div>;
}
