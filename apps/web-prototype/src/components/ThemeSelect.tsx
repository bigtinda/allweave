import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./ui";

export interface ThemeSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface ThemeSelectProps {
  options: ThemeSelectOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  menuMinWidth?: number;
  menuClassName?: string;
}

interface MenuPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export function ThemeSelect({ options, value, onChange, ariaLabel, ariaLabelledBy, placeholder, disabled = false, className = "", menuMinWidth = 0, menuClassName = "" }: ThemeSelectProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const enabledIndices = options.flatMap((option, index) => option.disabled ? [] : [index]);

  const updatePosition = (): void => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const desiredHeight = Math.min(280, Math.max(44, options.length * 46 + 10));
    const placeAbove = below < Math.min(desiredHeight, 180) && above > below;
    const maxHeight = Math.max(100, Math.min(desiredHeight, placeAbove ? above : below));
    const width = Math.min(Math.max(rect.width, menuMinWidth), window.innerWidth - 16);
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: placeAbove ? Math.max(8, rect.top - maxHeight - 8) : Math.min(rect.bottom + 8, window.innerHeight - maxHeight - 8),
      width,
      maxHeight,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const reposition = (): void => updatePosition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, options.length, menuMinWidth]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const focusOption = (index: number): void => {
    requestAnimationFrame(() => optionRefs.current[index]?.focus());
  };
  const openAt = (index: number): void => {
    if (disabled || !options.length) return;
    setOpen(true);
    focusOption(enabledIndices.includes(index) ? index : enabledIndices[0] ?? 0);
  };
  const moveFocus = (index: number, direction: 1 | -1): void => {
    if (!enabledIndices.length) return;
    const current = enabledIndices.indexOf(index);
    const next = current < 0
      ? (direction > 0 ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1])
      : enabledIndices[(current + direction + enabledIndices.length) % enabledIndices.length];
    focusOption(next ?? 0);
  };
  const select = (option: ThemeSelectOption): void => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return <div className={`theme-select ${className}`} ref={rootRef}>
    <button
      ref={triggerRef}
      type="button"
      className="theme-select-trigger"
      title={selected ? [selected.label, selected.description].filter(Boolean).join(" · ") : placeholder}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? `${id}-options` : undefined}
      disabled={disabled}
      onClick={() => open ? setOpen(false) : openAt(selectedIndex >= 0 ? selectedIndex : enabledIndices[0] ?? 0)}
      onKeyDown={(event) => {
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
          event.preventDefault();
          openAt(selectedIndex >= 0 ? selectedIndex : (event.key === "ArrowUp" ? enabledIndices.at(-1) ?? 0 : enabledIndices[0] ?? 0));
        }
      }}
    >
      <span className="theme-select-trigger-copy"><strong>{selected?.label ?? placeholder ?? "请选择"}</strong>{selected?.description && <small>{selected.description}</small>}</span>
      <Icon name="chevron" size={16} className={open ? "theme-select-chevron open" : "theme-select-chevron"} />
    </button>
    {open && position && createPortal(<div ref={menuRef} className={`theme-select-menu ${menuClassName}`} id={`${id}-options`} role="listbox" aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}>
      {options.map((option, index) => <button
        key={`${option.value}-${index}`}
        ref={(element) => { optionRefs.current[index] = element; }}
        type="button"
        role="option"
        aria-selected={option.value === value}
        disabled={option.disabled}
        tabIndex={selectedIndex === index ? 0 : -1}
        className={`theme-select-option${option.value === value ? " selected" : ""}`}
        onClick={() => select(option)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveFocus(index, event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            focusOption(event.key === "Home" ? enabledIndices[0] ?? 0 : enabledIndices.at(-1) ?? 0);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            select(option);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
          } else if (event.key === "Tab") {
            setOpen(false);
          }
        }}
      >
        <span className="theme-select-option-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        {option.value === value && <Icon name="check" size={16} />}
      </button>)}
    </div>, document.body)}
  </div>;
}
