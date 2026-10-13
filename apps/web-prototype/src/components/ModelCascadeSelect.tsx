import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./ui";

export interface ModelMenuGroup {
  id: string;
  label: string;
  models: { value: string; label: string; vision: boolean }[];
}

export function ModelCascadeSelect({ groups, value, label, disabled, ariaLabel, onChange, onManageModels }: {
  groups: ModelMenuGroup[];
  value: string;
  label: string;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: string) => void;
  onManageModels?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0, width: 520, maxHeight: 300 });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const providersRef = useRef<HTMLDivElement>(null);
  const modelsRef = useRef<HTMLDivElement>(null);
  const activeGroup = groups.find((group) => group.id === activeId) ?? groups[0];
  const close = (): void => { setOpen(false); triggerRef.current?.focus(); };
  const select = (nextValue: string): void => { onChange(nextValue); close(); };
  const show = (): void => {
    if (disabled) return;
    setActiveId(groups.find((group) => group.models.some((model) => model.value === value))?.id ?? groups[0]?.id ?? "");
    setOpen(true);
  };
  const moveFocus = (container: HTMLDivElement | null, direction: number): void => {
    const items = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const current = items.findIndex((item) => item === document.activeElement);
    items[(current + direction + items.length) % items.length]?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = (): void => {
      const trigger = triggerRef.current;
      const rect = trigger?.getBoundingClientRect();
      if (!trigger || !rect) return;
      const panelRect = trigger.closest(".conversation-panel")?.getBoundingClientRect();
      const panelWidth = panelRect?.width ?? window.innerWidth;
      const width = Math.min(520, window.innerWidth - 16, Math.max(240, panelWidth - 16));
      const above = rect.top - 8;
      const below = window.innerHeight - rect.bottom - 8;
      const useAbove = below < 240 && above > below;
      const contentHeight = Math.max(providersRef.current?.scrollHeight ?? 0, modelsRef.current?.scrollHeight ?? 0) + 10;
      const maxHeight = Math.min(320, contentHeight || 120, Math.max(100, useAbove ? above : below));
      const minLeft = Math.max(8, (panelRect?.left ?? 0) + 8);
      const maxLeft = Math.min(window.innerWidth - width - 8, (panelRect?.right ?? window.innerWidth) - width - 8);
      setPosition({ left: Math.max(minLeft, Math.min(rect.left, Math.max(minLeft, maxLeft))), top: useAbove ? Math.max(8, rect.top - maxHeight - 6) : rect.bottom + 6, width, maxHeight });
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => { window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [open, activeGroup?.id, groups.length]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      else if (event.key === "Tab") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); };
  }, [open]);
  return <div className="model-cascade-select" ref={rootRef}>
    <button ref={triggerRef} type="button" className="model-cascade-trigger" aria-label={ariaLabel} title={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled}
      onClick={() => open ? close() : show()} onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); show(); requestAnimationFrame(() => providersRef.current?.querySelector<HTMLButtonElement>("button")?.focus()); }
      }}><span>{label}</span><Icon name="chevron" size={14} /></button>
    {open && createPortal(<div className="model-cascade-menu" ref={menuRef} style={position} role="menu" aria-label="选择供应商及模型">
      <div className="model-cascade-providers" ref={providersRef} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); moveFocus(providersRef.current, event.key === "ArrowDown" ? 1 : -1); }
      }}>
        <button type="button" role="menuitem" className="model-cascade-default" onClick={() => select("")}>使用项目默认模型</button>
        {groups.map((group) => <button key={group.id} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={activeGroup?.id === group.id}
          className={`model-cascade-provider ${activeGroup?.id === group.id ? "active" : ""}`}
          onPointerEnter={() => setActiveId(group.id)} onFocus={() => setActiveId(group.id)} onClick={() => { setActiveId(group.id); requestAnimationFrame(() => modelsRef.current?.querySelector<HTMLButtonElement>("button")?.focus()); }}
          onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); setActiveId(group.id); requestAnimationFrame(() => modelsRef.current?.querySelector<HTMLButtonElement>("button")?.focus()); } }}>
          <span>{group.label}</span>{group.models.some((model) => model.value === value) && <Icon name="check" size={14} />}<Icon name="chevron" className="cascade-right-arrow" size={14} />
        </button>)}
        {onManageModels && <button type="button" role="menuitem" className="model-cascade-manage" onClick={() => { close(); onManageModels(); }}>管理模型</button>}
      </div>
      <div className="model-cascade-models" ref={modelsRef} role="menu" aria-label={activeGroup?.label ?? "模型"} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); moveFocus(modelsRef.current, event.key === "ArrowDown" ? 1 : -1); }
        else if (event.key === "ArrowLeft") { event.preventDefault(); providersRef.current?.querySelector<HTMLButtonElement>(".model-cascade-provider.active")?.focus(); }
      }}>
        {activeGroup?.models.map((model) => <button key={model.value} type="button" role="menuitemradio" aria-checked={model.value === value} className={model.value === value ? "selected" : ""} title={model.label} onClick={() => select(model.value)}>
          <span>{model.label}</span>{model.vision && <span className="model-vision-tag">视觉</span>}{model.value === value && <Icon name="check" size={14} />}
        </button>)}
      </div>
    </div>, document.body)}
  </div>;
}
