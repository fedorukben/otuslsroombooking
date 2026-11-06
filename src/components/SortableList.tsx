import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Drag-to-reorder list. Works with mouse and touch (pointer events) and keyboard:
 * focus a handle and press ↑/↓ to move that item. Calls onReorder with the new id order.
 */
export function SortableList<T extends { id: number }>({
  items,
  onReorder,
  render,
  label,
  className = "",
}: {
  items: T[];
  onReorder: (ids: number[]) => void;
  render: (item: T) => ReactNode;
  label: (item: T) => string;
  className?: string;
}) {
  const [order, setOrder] = useState(items);
  const [dragId, setDragId] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const orderRef = useRef(order);
  orderRef.current = order;

  useEffect(() => setOrder(items), [items]);

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= orderRef.current.length) return orderRef.current;
    const next = [...orderRef.current];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    setOrder(next);
    return next;
  };

  const startDrag = (e: React.PointerEvent, id: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragId(id);
  };

  const onMove = (e: React.PointerEvent) => {
    if (dragId === null || !listRef.current) return;
    const rows = [...listRef.current.querySelectorAll<HTMLElement>(":scope > li")];
    const from = orderRef.current.findIndex((x) => x.id === dragId);
    let to = rows.findIndex((r) => {
      const b = r.getBoundingClientRect();
      return e.clientY < b.top + b.height / 2;
    });
    if (to === -1) to = rows.length - 1;
    else if (to > from) to -= 1;
    move(from, to);
  };

  const endDrag = () => {
    if (dragId === null) return;
    setDragId(null);
    const ids = orderRef.current.map((x) => x.id);
    if (ids.join() !== items.map((x) => x.id).join()) onReorder(ids);
  };

  return (
    <>
      <ul ref={listRef} className={`sortable ${className} ${dragId !== null ? "is-dragging" : ""}`} onPointerMove={onMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
        {order.map((item, i) => (
          <li key={item.id} className={dragId === item.id ? "dragging" : ""}>
            <button
              type="button"
              className="drag-handle"
              aria-label={`Reorder ${label(item)}: position ${i + 1} of ${order.length}. Use arrow keys to move.`}
              onPointerDown={(e) => startDrag(e, item.id)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                e.preventDefault();
                const to = i + (e.key === "ArrowUp" ? -1 : 1);
                const next = move(i, to);
                if (next !== orderRef.current || to !== i) {
                  onReorder(next.map((x) => x.id));
                  setAnnounce(`${label(item)} moved to position ${Math.min(Math.max(to, 0), order.length - 1) + 1}`);
                  requestAnimationFrame(() => {
                    const handles = listRef.current?.querySelectorAll<HTMLButtonElement>(".drag-handle");
                    handles?.[Math.min(Math.max(to, 0), order.length - 1)]?.focus();
                  });
                }
              }}
            >
              <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden>
                {[3, 9, 15].map((y) => (
                  <g key={y}>
                    <circle cx="4" cy={y} r="1.6" />
                    <circle cx="10" cy={y} r="1.6" />
                  </g>
                ))}
              </svg>
            </button>
            {render(item)}
          </li>
        ))}
      </ul>
      <span className="sr-only" aria-live="polite">{announce}</span>
    </>
  );
}
