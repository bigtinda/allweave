import { useEffect, useState } from "react";
import { runtimeFetch } from "../client/runtime-fetch";
import { PI_COMPATIBLE_APIS, type RuntimeProvider } from "../client/provider-catalog";
import { ThemeSelect } from "./ThemeSelect";
import { ModelCascadeSelect, type ModelMenuGroup } from "./ModelCascadeSelect";

interface ConfiguredModelSelectProps {
  providerId: string;
  modelId: string;
  legacyModel?: string;
  onChange: (providerId: string, modelId: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  cascade?: boolean;
  onManageModels?: () => void;
  onThinkingLevelsChange?: (levels: string[]) => void;
}

const selectionKey = (providerId: string, modelId: string): string => `${providerId}\u001f${modelId}`;

export function ConfiguredModelSelect({ providerId, modelId, legacyModel, onChange, disabled, ariaLabel = "供应商模型", cascade = false, onManageModels, onThinkingLevelsChange }: ConfiguredModelSelectProps) {
  const [providers, setProviders] = useState<RuntimeProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let current = true;
    void runtimeFetch("/api/model-runtime/providers", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json() as { providers?: RuntimeProvider[]; error?: string };
        if (!response.ok || !Array.isArray(result.providers)) throw new Error(result.error || "无法读取已配置模型");
        if (current) setProviders(result.providers);
      })
      .catch((error: unknown) => {
        if (current) setLoadError(error instanceof Error ? error.message : "无法读取已配置模型");
      })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, []);

  const available = providers
    .filter((provider) => provider.configured)
    .flatMap((provider) => provider.models.filter((model) => model.enabled).map((model) => ({ provider, model })));
  const selected = available.find(({ provider, model }) => provider.id === providerId && model.id === modelId)
    ?? (!providerId && (modelId || legacyModel)
      ? available.find(({ model }) => model.id === modelId || model.id === legacyModel || model.name === legacyModel || legacyModel?.endsWith(` / ${model.id}`))
      : undefined);
  const selectedKey = selected ? selectionKey(selected.provider.id, selected.model.id) : "";
  const levelsKey = JSON.stringify(selected?.model.thinkingLevels ?? (selected?.model.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"]));
  useEffect(() => { if (!loading) onThinkingLevelsChange?.(JSON.parse(levelsKey) as string[]); }, [loading, levelsKey, onThinkingLevelsChange]);
  const groups: ModelMenuGroup[] = [];
  for (const { provider, model } of available) {
    const id = selectionKey(provider.id, model.api);
    let group = groups.find((item) => item.id === id);
    if (!group) {
      const apiLabel = model.api === "openai-completions" ? "Chat" : model.api === "openai-responses" ? "Responses" : model.api === "anthropic-messages" ? "Anthropic" : PI_COMPATIBLE_APIS.find((api) => api.id === model.api)?.label ?? model.api;
      group = { id, label: `${provider.name} (${apiLabel})`, models: [] };
      groups.push(group);
    }
    group.models.push({ value: selectionKey(provider.id, model.id), label: model.name, vision: model.input?.includes("image") ?? false });
  }
  const choose = (nextValue: string): void => {
    if (!nextValue) { onChange("", ""); return; }
    const choice = available.find(({ provider, model }) => selectionKey(provider.id, model.id) === nextValue);
    if (choice) onChange(choice.provider.id, choice.model.id);
  };

  return <>
    {cascade ? <ModelCascadeSelect groups={groups} value={selectedKey} label={selected ? `${selected.provider.name}/${selected.model.name}` : loading ? "读取模型…" : available.length ? "项目默认模型" : "没有可用模型"} ariaLabel={ariaLabel} disabled={disabled || loading || !available.length} onChange={choose} onManageModels={onManageModels} /> : <ThemeSelect
      className="configured-model-select"
      menuMinWidth={340}
      menuClassName="configured-model-menu"
      ariaLabel={ariaLabel}
      value={selectedKey}
      disabled={disabled || loading || available.length === 0}
      placeholder={loading ? "正在读取已配置模型…" : available.length ? "使用项目默认模型" : "没有可用的已配置模型"}
      options={[
        { value: "", label: loading ? "正在读取已配置模型…" : available.length ? "使用项目默认模型" : "没有可用的已配置模型" },
        ...available.map(({ provider, model }) => ({
          value: selectionKey(provider.id, model.id),
          label: `${provider.name} · ${model.name}`,
        })),
      ]}
      onChange={choose}
    />}
    {!loading && !available.length && <small className="configured-model-empty">请先在设置的“模型连接”中配置供应商、完成认证并启用模型。</small>}
    {loadError && <small className="configured-model-empty" role="status">{loadError}</small>}
  </>;
}
