import { tr, trError } from "./i18n";
import { useState, type ReactNode, type FormEvent } from "react";
import { useI18n } from "./i18n";
import { Dialog, Tooltip, Select, Switch, AlertDialog } from "radix-ui";
import { XIcon, CaretDownIcon, CheckIcon, ArrowUpRightIcon, SpinnerGapIcon, CopyIcon, PlusIcon } from "@phosphor-icons/react";

export function Button({ children, className = "", busy, icon, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; icon?: ReactNode }) {
  return <button {...props} disabled={props.disabled || busy} className={`button ${className}`}>{busy ? <SpinnerGapIcon className="spin" size={16}/> : icon}{children}</button>;
}
export function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <Tooltip.Root><Tooltip.Trigger asChild><button {...props} className={`icon-button ${props.className || ""}`} aria-label={label}>{children}</button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={8}>{label}<Tooltip.Arrow/></Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
}
export function Panel({ children, className = "", ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`panel ${className}`} {...props}><div className="panel-inner">{children}</div></div>;
}
export function Modal({ title, children, open, onOpenChange, wide = false }: { title: string; children: ReactNode; open: boolean; onOpenChange: (value: boolean) => void; wide?: boolean }) {
  const { t } = useI18n();
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="modal-overlay"/><Dialog.Content aria-describedby={undefined} className={`modal ${wide ? "modal-wide" : ""}`}><div className="modal-heading"><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><button className="icon-button" aria-label={t("common.close")}><XIcon size={20}/></button></Dialog.Close></div>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return <label className={`field ${className}`}><span>{label}</span>{children}</label>;
}
export function Dropdown({ value, onChange, items, label }: { value: string; onChange: (value: string) => void; items: { value: string; label: string }[]; label?: string }) {
  const { t } = useI18n();
  return <Select.Root value={value || undefined} onValueChange={onChange}><Select.Trigger className="select" aria-label={label}><Select.Value placeholder={t("common.select")}/><Select.Icon><CaretDownIcon/></Select.Icon></Select.Trigger><Select.Portal><Select.Content className="select-content" position="popper" sideOffset={6}><Select.Viewport>{items.map(item => <Select.Item className="select-item" key={item.value} value={item.value}><Select.ItemText>{item.label}</Select.ItemText><Select.ItemIndicator><CheckIcon/></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root>;
}
export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <Switch.Root className="toggle" checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled}><Switch.Thumb className="toggle-thumb"/></Switch.Root>;
}
export function Copy({ value, label }: { value: string; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return <IconButton label={copied ? t("common.copied") : label || t("common.copy")} onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? <CheckIcon size={17}/> : <CopyIcon size={17}/>}</IconButton>;
}
export function Confirm({ children, title, onConfirm }: { children: ReactNode; title: string; onConfirm: () => Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  return <AlertDialog.Root open={open} onOpenChange={setOpen}><AlertDialog.Trigger asChild>{children}</AlertDialog.Trigger><AlertDialog.Portal><AlertDialog.Overlay className="modal-overlay"/><AlertDialog.Content className="modal confirm-modal"><AlertDialog.Title>{title}</AlertDialog.Title><AlertDialog.Description className="sr-only">{tr("common.confirm.description")}</AlertDialog.Description>{error && <div role="alert" className="form-error">{trError(error)}</div>}<div className="form-actions"><AlertDialog.Cancel asChild><Button>{t("common.cancel")}</Button></AlertDialog.Cancel><Button className="danger" busy={busy} onClick={async () => { setBusy(true); try { await onConfirm(); setOpen(false); } catch { setError("error.operation"); } finally { setBusy(false); } }}>{t("common.confirm")}</Button></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>;
}
export function Empty({ icon, title, action }: { icon: ReactNode; title: string; action?: ReactNode }) {
  return <div className="empty"><span className="empty-symbol">{icon}</span><span>{title}</span>{action}</div>;
}
export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Loading() { return <div className="loading"><SpinnerGapIcon className="spin" size={22}/></div>; }
export function Header({ title, count, children }: { title: string; count?: number; children?: ReactNode }) {
  return <div className="section-heading"><div className="section-title"><h2>{title}</h2>{count !== undefined && <span className="count">{count}</span>}</div><div className="section-actions">{children}</div></div>;
}
