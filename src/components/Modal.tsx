import { useEffect, useRef } from "react";

export function Modal({
  titleId,
  title,
  body,
  cancelLabel,
  confirmLabel,
  alternateLabel,
  onCancel,
  onConfirm,
  onAlternate,
}: {
  titleId: string;
  title: string;
  body: string;
  cancelLabel: string;
  confirmLabel: string;
  /** 破棄して切り替える、のように確認と取消のあいだの選択。 */
  alternateLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
  onAlternate?: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    document.body.classList.add("modal-open");
    return () => document.body.classList.remove("modal-open");
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>{title}</h2>
        <p>{body}</p>
        <div className={alternateLabel ? "modal-actions is-stack" : "modal-actions"}>
          <button ref={cancelRef} type="button" className="btn secondary" onClick={onCancel}>
            {cancelLabel}
          </button>
          {alternateLabel && onAlternate && (
            <button type="button" className="btn secondary" onClick={onAlternate}>
              {alternateLabel}
            </button>
          )}
          <button type="button" className="btn primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
