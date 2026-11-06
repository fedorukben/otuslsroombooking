/**
 * Room Scheduler mark: a calendar page with a door cut into it (room + schedule).
 * `bare` drops the dark tile, for use on dark backgrounds like the admin bar.
 */
export function LogoMark({ size = 32, bare = false, title }: { size?: number; bare?: boolean; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={bare ? "8 6 48 50" : "0 0 64 64"}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className="logo-mark"
    >
      {!bare && <rect width="64" height="64" rx="15" fill="#16130f" />}
      <rect x="12" y="15" width="40" height="38" rx="6" fill="#f5f2ea" />
      <path d="M18 15h28a6 6 0 0 1 6 6v5H12v-5a6 6 0 0 1 6-6z" fill="#e8c547" />
      <rect x="20" y="9" width="5" height="11" rx="2.5" fill="#f5f2ea" stroke="#16130f" strokeWidth="2" />
      <rect x="39" y="9" width="5" height="11" rx="2.5" fill="#f5f2ea" stroke="#16130f" strokeWidth="2" />
      <path d="M25 53V35.5a3.5 3.5 0 0 1 3.5-3.5h7a3.5 3.5 0 0 1 3.5 3.5V53z" fill="#16130f" />
      <circle cx="35" cy="43.5" r="1.6" fill="#e8c547" />
    </svg>
  );
}

/** Mark + name, for headers. */
export function Wordmark({ size = 30, bare = false, sub }: { size?: number; bare?: boolean; sub?: string }) {
  return (
    <span className="wordmark-inner">
      <LogoMark size={size} bare={bare} />
      <span className="wordmark-text">Room Scheduler</span>
      {sub && <em>{sub}</em>}
    </span>
  );
}
