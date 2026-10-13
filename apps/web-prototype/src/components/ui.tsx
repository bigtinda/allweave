import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const PageHeadingTargetContext = createContext<HTMLElement | null>(null);

export type IconName =
  | "home" | "team" | "chat" | "board" | "package" | "settings" | "plus" | "search" | "bell"
  | "sun" | "moon"
  | "chevron" | "arrow" | "check" | "clock" | "play" | "pause" | "sparkle" | "file" | "code"
  | "flask" | "shield" | "database" | "monitor" | "user" | "send" | "close" | "menu" | "calendar"
  | "more" | "filter" | "download" | "upload" | "list" | "folder" | "layers" | "alert" | "external" | "info" | "trash" | "archive" | "pencil" | "maximize" | "minimize" | "refresh";

const iconPaths: Record<IconName, string> = {
  home: "M3 10.8 12 3l9 7.8v9.7a.5.5 0 0 1-.5.5h-5.2v-6.2h-6.6V21H3.5a.5.5 0 0 1-.5-.5z",
  team: "M16 21v-1.7a3.3 3.3 0 0 0-3.3-3.3H6.3A3.3 3.3 0 0 0 3 19.3V21m16 0v-1.7a3.3 3.3 0 0 0-2.6-3.2M9.5 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7-7.7a4 4 0 0 1 0 7.5",
  chat: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z",
  board: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  package: "m12 3 8.5 4.5v9L12 21l-8.5-4.5v-9L12 3Zm-8.5 4.5L12 12l8.5-4.5M12 12v9M7.8 5.2l8.6 4.6",
  settings: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8.2 3.5a8.4 8.4 0 0 0-.1-1.2l1.6-1.3-1.6-2.8-1.9.7a8 8 0 0 0-2-1.2L15.9 3h-3.8l-.3 2.2a8 8 0 0 0-2 1.2l-1.9-.7-1.6 2.8 1.6 1.3a8.4 8.4 0 0 0 0 2.4l-1.6 1.3 1.6 2.8 1.9-.7a8 8 0 0 0 2 1.2l.3 2.2h3.8l.3-2.2a8 8 0 0 0 2-1.2l1.9.7 1.6-2.8-1.6-1.3c.1-.4.1-.8.1-1.2Z",
  sun: "M12 3v2m0 14v2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42M3 12h2m14 0h2M5.64 18.36l1.42-1.42m9.88-9.88 1.42-1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  moon: "M20.9 13A8.5 8.5 0 0 1 11 3.1 8.5 8.5 0 1 0 20.9 13Z",
  plus: "M12 5v14M5 12h14",
  search: "m20 20-4.2-4.2M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12a2 2 0 0 0 4 0",
  chevron: "m7 10 5 5 5-5",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  check: "m5 12 4 4L19 6",
  clock: "M12 8v4l2.5 1.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  play: "m8 5 11 7-11 7V5Z",
  pause: "M8 5h3v14H8zM15 5h3v14h-3z",
  sparkle: "m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Zm7 11 .9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14Z",
  file: "M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10Zm0 0v7h7M8 14h8M8 18h8",
  code: "m8 17-5-5 5-5m8 0 5 5-5 5m-3-12-2 14",
  flask: "M9 3h6m-5 0v6.2l-5.2 8.6A1.5 1.5 0 0 0 6.1 20h11.8a1.5 1.5 0 0 0 1.3-2.2L14 9.2V3m-6 11h12",
  shield: "M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Zm-4-11 3 3 5-5",
  database: "M20 6c0 1.7-3.6 3-8 3S4 7.7 4 6s3.6-3 8-3 8 1.3 8 3ZM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6m-16 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  monitor: "M4 4h16v12H4zM8 20h8m-4-4v4",
  user: "M20 21a8 8 0 0 0-16 0m8-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  send: "m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13",
  close: "m18 6-12 12M6 6l12 12",
  menu: "M4 6h16M4 12h16M4 18h16",
  calendar: "M8 3v4m8-4v4M4 9h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  filter: "M4 5h16M7 12h10m-7 7h4",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5-5 5 5m-5-5v12",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  folder: "M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  layers: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 5 9 5 9-5",
  alert: "M12 9v4m0 4h.01M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z",
  external: "M14 3h7v7m0-7-9 9M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  info: "M12 16v-4m0-4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  trash: "M3 6h18m-2 0-.9 14H5.9L5 6m4 0V4h6v2m-5 4v6m4-6v6",
  archive: "M3 4h18v4H3zM5 8v12h14V8m-9 4h4",
  pencil: "m16 4 4 4M4 20l4.2-.8L19 8.4 15.6 5 4.8 15.8 4 20Z",
  maximize: "M15 3h6v6m0-6-7 7M9 21H3v-6m0 6 7-7",
  minimize: "M4 14h6v6m0-6-7 7m17-7h-6V4m0 6 7-7",
  refresh: "M20 7v5h-5M4 17v-5h5m11-1a8 8 0 0 0-14.6-4L4 7m0 5a8 8 0 0 0 14.6 4L20 17",
};

export function Icon({ name, size = 18, className = "" }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]} /></svg>;
}

export function StatusBadge({ children, tone = "gray", dot = false }: { children: ReactNode; tone?: string; dot?: boolean }) {
  return <span className={`status-badge tone-${tone}`}>{dot && <i aria-hidden="true" />}{children}</span>;
}

export function PageHeading({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  const target = useContext(PageHeadingTargetContext);
  if (!target) return null;
  return createPortal(<div className="topbar-page-heading">
    <div className="topbar-page-heading-copy">
      {eyebrow && <span className="topbar-page-eyebrow">{eyebrow}</span>}
      <h1>{title}</h1>
      {description && <p title={description}>{description}</p>}
    </div>
    {actions && <div className="topbar-page-heading-actions">{actions}</div>}
  </div>, target);
}

export function SectionTitle({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="section-title"><div><h2>{title}</h2>{detail && <span>{detail}</span>}</div>{action}</div>;
}

export function Progress({ value }: { value: number }) {
  const normalizedValue = Math.max(0, Math.min(value, 100));
  return <div className="progress-track" role="progressbar" aria-valuenow={normalizedValue} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${normalizedValue}%` }} /></div>;
}

export function MiniStat({ label, value }: { label: string; value: string }) {
  return <div className="mini-stat"><span>{label}</span><strong>{value}</strong></div>;
}

export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="detail-section"><h3>{title}</h3>{children}</section>;
}

export function MetaRow({ label, value }: { label: string; value: string }) {
  return <div className="meta-row"><span>{label}</span><strong>{value}</strong></div>;
}
