import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CLOUD_PROVIDER_IDS, PI_COMPATIBLE_APIS, providerPresentation, type RuntimeProvider } from "../client/provider-catalog";
import { runtimeFetch } from "../client/runtime-fetch";
import { Icon, PageHeading, StatusBadge } from "./ui";
import type { ConfirmationRequest } from "./confirmation";

interface ModelConnectionsProps {
  defaultProviderId: string;
  defaultModelId: string;
  onSetDefault: (providerId: string, modelId: string) => void;
  onConfirm: (request: ConfirmationRequest) => Promise<boolean>;
  showCatalogHeading?: boolean;
}

interface AuthFlowState {
  flowId: string;
  prompt: { id: number; type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] } | null;
  events: { type: string; message: string; links: { label: string; url: string }[] }[];
  eventCount: number;
  done: boolean;
  error: string;
}

interface ManagedModelDraft {
  originalId: string;
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
  reasoning: boolean;
  api: string;
  baseUrl: string;
}

const postJson = async <T,>(path: string, value: unknown): Promise<T> => {
  const response = await runtimeFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "请求失败，请稍后重试");
  return body;
};

export function ModelConnections({ defaultProviderId, defaultModelId, onSetDefault, onConfirm, showCatalogHeading = true }: ModelConnectionsProps) {
  const [providers, setProviders] = useState<RuntimeProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [isCustomDraft, setIsCustomDraft] = useState(false);
  const [customProviderId, setCustomProviderId] = useState("");
  const [customProviderName, setCustomProviderName] = useState("");
  const [customModelId, setCustomModelId] = useState("");
  const [customModelName, setCustomModelName] = useState("");
  const [customModelInput, setCustomModelInput] = useState<"text" | "text,image">("text");
  const [api, setApi] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [deploymentId, setDeploymentId] = useState("");
  const [bedrockRegion, setBedrockRegion] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [authFlow, setAuthFlow] = useState<AuthFlowState | null>(null);
  const [answer, setAnswer] = useState("");
  const [answerError, setAnswerError] = useState("");
  const [answering, setAnswering] = useState(false);
  const [modelDraft, setModelDraft] = useState<ManagedModelDraft | null>(null);
  const [modelActionId, setModelActionId] = useState("");
  const [modelError, setModelError] = useState("");

  const loadProviders = async (): Promise<void> => {
    try {
      const response = await runtimeFetch("/api/model-runtime/providers", { cache: "no-store" });
      const result = await response.json() as { providers?: RuntimeProvider[]; error?: string };
      if (!response.ok || !Array.isArray(result.providers)) throw new Error(result.error || "Pi Runtime 未启动");
      setProviders(result.providers);
      setCatalogError("");
    } catch {
      setCatalogError("无法连接 Pi Model Runtime。请重启 Web 开发服务后重试。");
    }
  };

  useEffect(() => { void loadProviders(); }, []);

  useEffect(() => {
    if (!authFlow || authFlow.done) return;
    let stopped = false;
    const poll = async (): Promise<void> => {
      try {
        const response = await runtimeFetch(`/api/model-runtime/auth/${authFlow.flowId}?after=${authFlow.eventCount}`, { cache: "no-store" });
        const state = await response.json() as Omit<AuthFlowState, "flowId"> & { error?: string };
        if (!response.ok) throw new Error(state.error || "授权流程已结束");
        if (!stopped) setAuthFlow((current) => current?.flowId === authFlow.flowId ? { ...current, ...state, events: [...current.events, ...state.events] } : current);
      } catch (error) {
        if (!stopped) setAuthFlow((current) => current?.flowId === authFlow.flowId ? { ...current, done: true, error: error instanceof Error ? error.message : "授权流程已结束" } : current);
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [authFlow?.flowId, authFlow?.eventCount, authFlow?.done]);

  const selectedProvider = useMemo(() => providers.find((provider) => provider.id === selectedProviderId) ?? null, [providers, selectedProviderId]);
  const addProviderModel = Boolean(selectedProvider && selectedProvider.models.length === 0);
  const displayedName = selectedProvider ? providerPresentation(selectedProvider).name : customProviderName;
  const apiChoices = selectedProvider
    ? (selectedProvider.availableApis.length
        ? [...new Set([...selectedProvider.availableApis, ...(selectedProvider.api ? [selectedProvider.api] : [])])]
        : PI_COMPATIBLE_APIS.map((item) => item.id))
        .map((id) => PI_COMPATIBLE_APIS.find((item) => item.id === id) ?? { id, label: id })
    : [...PI_COMPATIBLE_APIS];
  const cloudProviders = providers.filter((provider) => (CLOUD_PROVIDER_IDS as readonly string[]).includes(provider.id));
  const otherProviders = providers.filter((provider) => !(CLOUD_PROVIDER_IDS as readonly string[]).includes(provider.id));

  const openProvider = (provider: RuntimeProvider): void => {
    setSelectedProviderId(provider.id);
    setIsCustomDraft(false);
    setApi(provider.api || provider.availableApis[0] || "openai-completions");
    setBaseUrl(provider.baseUrl || "");
    setModelId(provider.models.find((model) => model.enabled && defaultProviderId === provider.id && model.id === defaultModelId)?.id ?? provider.models.find((model) => model.enabled)?.id ?? provider.models[0]?.id ?? "");
    setDeploymentId("");
    setBedrockRegion(provider.region ?? "");
    setFormError("");
  };

  const openCustomProvider = (): void => {
    setSelectedProviderId(null);
    setIsCustomDraft(true);
    setCustomProviderId("");
    setCustomProviderName("");
    setCustomModelId("");
    setCustomModelName("");
    setCustomModelInput("text");
    setApi("openai-completions");
    setBaseUrl("");
    setModelId("");
    setDeploymentId("");
    setBedrockRegion("");
    setFormError("");
  };

  const saveProvider = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    const id = isCustomDraft ? customProviderId.trim().toLowerCase() : selectedProviderId;
    const name = isCustomDraft ? customProviderName.trim() : undefined;
    try {
      if (!id) throw new Error("请填写供应商 ID");
      const result = await postJson<{ provider: RuntimeProvider }>("/api/model-runtime/providers", {
        providerId: id,
        ...(name ? { name } : {}),
        baseUrl: baseUrl.trim(),
        api,
        modelId,
        ...(isCustomDraft || addProviderModel ? { customModel: { id: customModelId.trim(), name: customModelName.trim(), input: customModelInput } } : {}),
        ...(deploymentId.trim() ? { deploymentId: deploymentId.trim() } : {}),
        ...(id === "amazon-bedrock" ? { region: bedrockRegion.trim() } : {}),
      });
      await loadProviders();
      setSelectedProviderId(id);
      setIsCustomDraft(false);
      const savedModel = isCustomDraft || addProviderModel
        ? customModelId.trim()
        : deploymentId.trim() || (selectedProvider?.models.find((model) => model.id === modelId && model.enabled)?.id ?? selectedProvider?.models.find((model) => model.enabled)?.id ?? "");
      if (savedModel) { setModelId(savedModel); onSetDefault(id, savedModel); }
      else if (defaultProviderId === id) { setModelId(""); onSetDefault("", ""); }
      if (!result.provider) throw new Error("供应商配置已保存，但 Pi 未返回供应商信息");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "无法保存供应商配置");
    } finally {
      setSaving(false);
    }
  };

  const beginModelEdit = (model?: RuntimeProvider["models"][number]): void => {
    if (!selectedProvider) return;
    setModelError("");
    setModelDraft({
      originalId: model?.id ?? "",
      id: model?.id ?? "",
      name: model?.name ?? "",
      contextWindow: model?.contextWindow ?? 128_000,
      maxTokens: model?.maxTokens ?? 8192,
      input: model?.input?.includes("image") ? ["text", "image"] : ["text"],
      reasoning: model?.reasoning ?? false,
      api: model?.api ?? api,
      baseUrl: model?.baseUrl ?? selectedProvider.baseUrl,
    });
  };

  const saveManagedModel = async (): Promise<void> => {
    if (!selectedProvider || !modelDraft) return;
    setModelActionId(modelDraft.originalId || "new");
    setModelError("");
    try {
      const result = await postJson<{ provider: RuntimeProvider }>(`/api/model-runtime/providers/${encodeURIComponent(selectedProvider.id)}/models`, {
        action: "save",
        originalId: modelDraft.originalId,
        model: modelDraft,
      });
      setProviders((current) => current.map((provider) => provider.id === result.provider.id ? result.provider : provider));
      if ((!defaultProviderId || !defaultModelId) || (defaultProviderId === result.provider.id && defaultModelId === modelDraft.originalId && modelDraft.id !== modelDraft.originalId)) {
        onSetDefault(result.provider.id, modelDraft.id.trim());
        setModelId(modelDraft.id.trim());
      }
      setModelDraft(null);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "模型保存失败");
    } finally {
      setModelActionId("");
    }
  };

  const setModelEnabled = async (model: RuntimeProvider["models"][number], enabled: boolean): Promise<void> => {
    if (!selectedProvider) return;
    setModelActionId(model.id);
    setModelError("");
    try {
      const result = await postJson<{ provider: RuntimeProvider }>(`/api/model-runtime/providers/${encodeURIComponent(selectedProvider.id)}/models`, { action: "enabled", modelId: model.id, enabled });
      setProviders((current) => current.map((provider) => provider.id === result.provider.id ? result.provider : provider));
      if (!enabled && (defaultProviderId === selectedProvider.id && defaultModelId === model.id || modelId === model.id)) {
        const replacement = result.provider.models.find((item) => item.enabled && item.id !== model.id);
        if (defaultProviderId === selectedProvider.id && defaultModelId === model.id) onSetDefault(replacement ? result.provider.id : "", replacement?.id ?? "");
        setModelId(replacement?.id ?? "");
      }
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "模型状态保存失败");
    } finally {
      setModelActionId("");
    }
  };

  const deleteManagedModel = async (model: RuntimeProvider["models"][number]): Promise<void> => {
    if (!selectedProvider || !model.custom) return;
    if (!await onConfirm({ title: "删除自定义模型", message: `确定删除模型「${model.id}」吗？`, confirmLabel: "删除模型", destructive: true })) return;
    setModelActionId(model.id);
    setModelError("");
    try {
      const result = await postJson<{ provider: RuntimeProvider }>(`/api/model-runtime/providers/${encodeURIComponent(selectedProvider.id)}/models`, { action: "delete", modelId: model.id });
      setProviders((current) => current.map((provider) => provider.id === result.provider.id ? result.provider : provider));
      if (defaultProviderId === selectedProvider.id && defaultModelId === model.id) {
        const replacement = result.provider.models.find((item) => item.enabled);
        onSetDefault(replacement ? result.provider.id : "", replacement?.id ?? "");
        setModelId(replacement?.id ?? "");
      }
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "模型删除失败");
    } finally {
      setModelActionId("");
    }
  };

  const startAuth = async (providerId: string, type: "api_key" | "oauth"): Promise<void> => {
    setFormError("");
    try {
      const result = await postJson<{ flowId: string }>("/api/model-runtime/auth/login", { providerId, type });
      setAnswer("");
      setAnswerError("");
      setAuthFlow({ flowId: result.flowId, prompt: null, events: [], eventCount: 0, done: false, error: "" });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "无法开始授权");
    }
  };

  const submitAuthAnswer = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!authFlow?.prompt) return;
    setAnswering(true);
    setAnswerError("");
    try {
      await postJson(`/api/model-runtime/auth/${authFlow.flowId}/answer`, { promptId: authFlow.prompt.id, value: answer });
      setAnswer("");
      setAuthFlow((current) => current ? { ...current, prompt: null } : null);
    } catch (error) {
      setAnswerError(error instanceof Error ? error.message : "无法提交此步骤");
    } finally {
      setAnswering(false);
    }
  };

  const cancelAuth = async (): Promise<void> => {
    if (authFlow) await runtimeFetch(`/api/model-runtime/auth/${authFlow.flowId}`, { method: "DELETE" }).catch(() => undefined);
    setAuthFlow(null);
    await loadProviders();
  };

  if (selectedProvider || isCustomDraft) {
    const providerId = selectedProvider?.id ?? customProviderId;
    const isCurrentDefault = defaultProviderId === providerId && defaultModelId === modelId;
    return <>
      <PageHeading eyebrow="工作空间 / 设置 / 模型连接" title="配置供应商" description={selectedProvider ? `${displayedName} · ${providerId}` : "连接支持 Pi API 协议的自定义供应商。"} actions={<button className="button button-outline" onClick={() => { setSelectedProviderId(null); setIsCustomDraft(false); setFormError(""); }}><Icon name="arrow" size={15} /> 返回供应商列表</button>} />
      <form className="provider-config-panel panel-card" onSubmit={saveProvider}>
        <div className="provider-config-heading"><span className="provider-mark">{selectedProvider ? <ProviderLogo provider={selectedProvider} size={28} /> : <Icon name="plus" size={20} />}</span><div><h2>{displayedName || "创建自定义供应商"}</h2><p>供应商认证由 Pi Runtime 处理，凭证保存在本机 Pi Agent 凭证存储中。</p></div>{selectedProvider?.configured && <StatusBadge tone="green">已授权</StatusBadge>}</div>
        {selectedProvider?.baseUrlRestriction && <div className="provider-model-restriction" role="note">OpenCode Go 模型目录中的模型均可启用；请求地址固定为官方服务地址。</div>}
        {isCustomDraft && <div className="provider-form-grid"><label className="form-field"><span>供应商名称 <b>*</b></span><input required value={customProviderName} onChange={(event) => setCustomProviderName(event.target.value)} placeholder="例如：公司模型平台" /></label><label className="form-field"><span>供应商 ID <b>*</b></span><input required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}" value={customProviderId} onChange={(event) => setCustomProviderId(event.target.value)} placeholder="例如：company-ai" /></label></div>}
        <div className="provider-form-grid">
          <label className="form-field"><span>API 协议 <b>*</b></span><select value={api} onChange={(event) => setApi(event.target.value)}>{apiChoices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label className="form-field"><span>服务地址 {isCustomDraft && <b>*</b>}</span><input required={isCustomDraft} readOnly={Boolean(selectedProvider?.baseUrlRestriction)} type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" /></label>
        </div>
        {(isCustomDraft || addProviderModel) && <div className="provider-form-grid"><label className="form-field"><span>模型 ID <b>*</b></span><input required value={customModelId} onChange={(event) => setCustomModelId(event.target.value)} placeholder="例如：my-chat-model" /></label><label className="form-field"><span>模型显示名称</span><input value={customModelName} onChange={(event) => setCustomModelName(event.target.value)} placeholder={customModelId || "自定义模型"} /></label></div>}
        {selectedProvider && <label className="form-field provider-model-field"><span>默认模型</span><select value={modelId} onChange={(event) => setModelId(event.target.value)}><option value="" disabled>请选择已启用的模型</option>{selectedProvider.models.filter((model) => model.enabled).map((model) => <option key={`${model.api}:${model.id}`} value={model.id}>{model.name} · {model.id}</option>)}</select>{!selectedProvider.models.length && <small>Pi Runtime 尚未注册此供应商的模型。保存供应商地址后可添加模型。</small>}{selectedProvider.models.length > 0 && !selectedProvider.models.some((model) => model.enabled) && <small>当前没有启用的模型，请先在模型列表中启用一个。</small>}</label>}
        {(isCustomDraft || addProviderModel) && <label className="form-field"><span>输入类型</span><select value={customModelInput} onChange={(event) => setCustomModelInput(event.target.value as "text" | "text,image")}><option value="text">文本</option><option value="text,image">文本和图像</option></select></label>}
        {providerId === "amazon-bedrock" && <label className="form-field provider-model-field"><span>AWS 区域</span><input value={bedrockRegion} onChange={(event) => setBedrockRegion(event.target.value)} placeholder="例如：us-east-1" /><small>保存后由 Pi Runtime 通过 AWS SDK 使用对应区域。</small></label>}
        {providerId === "azure" && <label className="form-field provider-model-field"><span>部署名称</span><input value={deploymentId} onChange={(event) => setDeploymentId(event.target.value)} placeholder={modelId || "使用模型 ID 作为部署名称"} /><small>如果 Azure 部署名称与所选模型 ID 不同，请在此填写。</small></label>}
        {formError && <p className="provider-form-error" role="alert">{formError}</p>}
        <div className="provider-config-actions"><button className="button button-outline" type="button" onClick={() => { setSelectedProviderId(null); setIsCustomDraft(false); }}>取消</button><button className="button button-primary" type="submit" disabled={saving || (isCustomDraft ? !customProviderId.trim() || !customProviderName.trim() || !customModelId.trim() : !selectedProvider || (addProviderModel && !customModelId.trim()))}>{saving ? "正在保存…" : "保存供应商配置"}</button></div>
        {selectedProvider && selectedProvider.auth.length > 0 && <section className="provider-auth-section"><h3>凭证与授权</h3><p>选择 Pi 为此供应商提供的认证流程。</p><div className="provider-auth-actions">{selectedProvider.auth.map((method) => <button key={method.type} className="button button-outline" type="button" onClick={() => void startAuth(selectedProvider.id, method.type)}><Icon name={method.type === "oauth" ? "external" : "shield"} size={15} /> {method.label}</button>)}</div></section>}
        {selectedProvider && selectedProvider.auth.length === 0 && <p className="provider-auth-note">Pi 未为该供应商注册交互式认证方式。请按 Pi 的环境变量或云凭证配置方式完成认证。</p>}
        {selectedProvider && selectedProvider.models.length > 0 && <div className="provider-default-row"><span>当前默认模型：{defaultProviderId && defaultModelId ? `${defaultProviderId} / ${defaultModelId}` : "尚未设置"}</span><button className="text-button" type="button" disabled={!modelId || isCurrentDefault} onClick={() => onSetDefault(selectedProvider.id, modelId)}>{isCurrentDefault ? "当前默认模型" : "设为默认模型"}</button></div>}
        {selectedProvider && <section className="provider-model-section">
          <div className="provider-model-section-heading"><div><h3>模型列表</h3><p>已自动加载 Pi Runtime 注册的模型；在此管理启用状态和自定义模型。</p></div><button type="button" className="button button-outline button-small" onClick={() => beginModelEdit()}><Icon name="plus" size={14} /> 添加模型</button></div>
          {selectedProvider.models.length > 0 ? <div className="provider-model-list">{selectedProvider.models.map((model) => <div className={`provider-model-row ${model.enabled ? "model-enabled" : "model-disabled"}`} key={`${model.api}:${model.id}`}>
            <div className="provider-model-name"><code title={model.id}>{model.id}</code><div className="provider-model-badges">{model.contextWindow && <span>{formatTokenCount(model.contextWindow)}</span>}{model.input?.includes("image") && <span>视觉</span>}</div></div>
            <div className="provider-model-actions"><button type="button" className="provider-model-action" title={`编辑 ${model.id}`} aria-label={`编辑 ${model.id}`} disabled={Boolean(modelActionId)} onClick={() => beginModelEdit(model)}><Icon name="pencil" size={15} /></button>{model.custom && <button type="button" className="provider-model-action provider-model-delete" title={`删除 ${model.id}`} aria-label={`删除 ${model.id}`} disabled={Boolean(modelActionId)} onClick={() => void deleteManagedModel(model)}><Icon name="trash" size={15} /></button>}<button type="button" role="switch" aria-label={`${model.enabled ? "停用" : "启用"}模型 ${model.id}`} aria-checked={model.enabled} className={`provider-model-switch ${model.enabled ? "on" : ""}`} disabled={modelActionId === model.id} onClick={() => void setModelEnabled(model, !model.enabled)}><span /></button></div>
          </div>)}</div> : <div className="provider-model-empty">当前没有模型，请添加此供应商提供的模型。</div>}
          {modelDraft && <div className="provider-model-editor">
            <div className="provider-model-editor-heading"><strong>{modelDraft.originalId ? "编辑模型" : "添加模型"}</strong><button type="button" className="provider-model-action" aria-label="取消编辑模型" onClick={() => { setModelDraft(null); setModelError(""); }}><Icon name="close" size={15} /></button></div>
            <div className="provider-model-editor-grid">
              <label className="form-field"><span>模型 ID</span><input required readOnly={Boolean(modelDraft.originalId && !selectedProvider.models.find((item) => item.id === modelDraft.originalId)?.custom)} value={modelDraft.id} onChange={(event) => setModelDraft((current) => current ? { ...current, id: event.target.value } : current)} /></label>
              <label className="form-field"><span>显示名称</span><input required value={modelDraft.name} onChange={(event) => setModelDraft((current) => current ? { ...current, name: event.target.value } : current)} /></label>
              <label className="form-field"><span>上下文长度</span><input type="number" min={1024} max={10000000} value={modelDraft.contextWindow} onChange={(event) => setModelDraft((current) => current ? { ...current, contextWindow: Number(event.target.value) } : current)} /></label>
              <label className="form-field"><span>最大输出</span><input type="number" min={256} max={10000000} value={modelDraft.maxTokens} onChange={(event) => setModelDraft((current) => current ? { ...current, maxTokens: Number(event.target.value) } : current)} /></label>
              <label className="form-field"><span>Pi API 协议</span><select value={modelDraft.api} onChange={(event) => setModelDraft((current) => current ? { ...current, api: event.target.value } : current)}>{apiChoices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              <label className="form-field"><span>模型地址（可选）</span><input type="url" readOnly={Boolean(selectedProvider.baseUrlRestriction)} value={modelDraft.baseUrl} onChange={(event) => setModelDraft((current) => current ? { ...current, baseUrl: event.target.value } : current)} placeholder={baseUrl || "使用供应商地址"} /></label>
            </div>
            <div className="provider-model-editor-options"><label><input type="checkbox" checked={modelDraft.input.includes("image")} onChange={(event) => setModelDraft((current) => current ? { ...current, input: event.target.checked ? ["text", "image"] : ["text"] } : current)} /> 支持图像输入</label><label><input type="checkbox" checked={modelDraft.reasoning} onChange={(event) => setModelDraft((current) => current ? { ...current, reasoning: event.target.checked } : current)} /> 推理模型</label><button type="button" className="button button-primary button-small" disabled={Boolean(modelActionId) || !modelDraft.id.trim() || !modelDraft.name.trim()} onClick={() => void saveManagedModel()}>{modelActionId ? "正在保存…" : "保存模型"}</button></div>
            {modelError && <p className="provider-form-error" role="alert">{modelError}</p>}
          </div>}
          {!modelDraft && modelError && <p className="provider-form-error" role="alert">{modelError}</p>}
        </section>}
      </form>
      {authFlow && <AuthInteractionDialog flow={authFlow} answer={answer} answerError={answerError} answering={answering} onAnswer={submitAuthAnswer} onAnswerChange={setAnswer} onCancel={() => void cancelAuth()} />}
    </>;
  }

  return <>
    {showCatalogHeading && <PageHeading eyebrow="工作空间 / 设置" title="模型连接" description="配置 Pi 支持的模型供应商、认证凭证和默认模型。" actions={<button className="button button-outline" onClick={() => void loadProviders()}><Icon name="arrow" size={15} /> 刷新列表</button>} />}
    {catalogError && <div className="provider-catalog-error" role="alert"><Icon name="alert" size={17} /><span>{catalogError}</span><button className="text-button" onClick={() => void loadProviders()}>重试</button></div>}
    <ProviderGroup title="云平台与托管服务" providers={cloudProviders} onSelect={openProvider} onCustom={openCustomProvider} defaultProviderId={defaultProviderId} defaultModelId={defaultModelId} />
    <ProviderGroup title="其他与扩展供应商" providers={otherProviders} onSelect={openProvider} defaultProviderId={defaultProviderId} defaultModelId={defaultModelId} />
    {providers.length > 0 && <p className="provider-catalog-footer">Pi Agent 内置供应商 · {providers.length} 家</p>}
  </>;
}

function ProviderGroup({ title, providers, onSelect, onCustom, defaultProviderId, defaultModelId }: { title: string; providers: RuntimeProvider[]; onSelect: (provider: RuntimeProvider) => void; onCustom?: () => void; defaultProviderId: string; defaultModelId: string }) {
  return <section className="provider-group panel-card"><h2>{title}</h2><div className="provider-catalog-grid">{providers.map((provider) => {
    const presentation = providerPresentation(provider);
    const isDefault = defaultProviderId === provider.id && defaultModelId;
    return <button className="provider-catalog-card" key={provider.id} onClick={() => onSelect(provider)}>
      <span className={`provider-catalog-mark provider-mark-${provider.id}`} aria-hidden="true"><ProviderLogo provider={provider} size={22} /></span><span className="provider-catalog-copy"><strong>{presentation.name}</strong><small>{provider.id}</small></span>
      <span className="provider-catalog-status">{isDefault ? <StatusBadge tone="blue">默认模型</StatusBadge> : provider.configured ? <StatusBadge tone="green">已授权</StatusBadge> : null}</span><Icon name="chevron" size={17} className="provider-catalog-chevron" />
    </button>;
  })}{onCustom && <button className="provider-catalog-card provider-catalog-custom" onClick={onCustom}><span className="provider-catalog-mark"><Icon name="plus" size={20} /></span><span className="provider-catalog-copy"><strong>创建自定义供应商</strong><small>兼容 Pi 支持的 API 协议</small></span><span /><Icon name="chevron" size={17} className="provider-catalog-chevron" /></button>}</div></section>;
}

function ProviderLogo({ provider, size }: { provider: RuntimeProvider; size: number }) {
  const [failed, setFailed] = useState(false);
  const presentation = providerPresentation(provider);
  const logoUrl = presentation.logoDomain ? `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(`https://${presentation.logoDomain}`)}&sz=64` : "";
  return <span className="provider-logo" style={{ width: size, height: size }}>
    {logoUrl && !failed ? <img src={logoUrl} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <span aria-hidden="true">{presentation.mark}</span>}
  </span>;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return String(value);
}

function AuthInteractionDialog({ flow, answer, answerError, answering, onAnswer, onAnswerChange, onCancel }: { flow: AuthFlowState; answer: string; answerError: string; answering: boolean; onAnswer: (event: FormEvent<HTMLFormElement>) => void; onAnswerChange: (value: string) => void; onCancel: () => void }) {
  const prompt = flow.prompt;
  return <div className="modal-overlay auth-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }} onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}><section className="modal-card auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-dialog-title"><div className="dialog-heading"><h2 id="auth-dialog-title">Pi 供应商授权</h2><p>认证信息会交由 Pi Runtime 处理。</p></div>
    {flow.events.map((event, index) => <div className="auth-flow-event" key={`${event.message}-${index}`}><p>{event.message}</p>{event.links.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noreferrer">{link.label}<Icon name="external" size={13} /></a>)}</div>)}
    {flow.error && <p className="provider-form-error" role="alert">{flow.error}</p>}
    {flow.done && !flow.error && <div className="auth-flow-success"><Icon name="check" size={17} /> 授权完成，凭证已保存到 Pi Agent。</div>}
    {!flow.done && !prompt && <p className="auth-flow-waiting">正在等待 Pi Runtime 的认证步骤…</p>}
    {!flow.done && prompt && <form className="auth-prompt-form" onSubmit={onAnswer}><label className="form-field"><span>{prompt.message}</span>{prompt.type === "select" ? <select autoFocus required value={answer} onChange={(event) => onAnswerChange(event.target.value)}><option value="" disabled>请选择</option>{prompt.options?.map((option) => <option key={option.id} value={option.id}>{option.label}{option.description ? ` · ${option.description}` : ""}</option>)}</select> : <input autoFocus required type={prompt.type === "secret" ? "password" : "text"} value={answer} onChange={(event) => onAnswerChange(event.target.value)} placeholder={prompt.placeholder ?? (prompt.type === "secret" ? "输入凭证" : "输入内容")} autoComplete={prompt.type === "secret" ? "new-password" : "off"} />}</label>{answerError && <p className="provider-form-error" role="alert">{answerError}</p>}<button className="button button-primary" disabled={answering}>{answering ? "正在提交…" : "继续"}</button></form>}
    <div className="dialog-actions"><button className="button button-quiet" onClick={onCancel}>{flow.done ? "关闭" : "取消授权"}</button></div>
  </section></div>;
}
