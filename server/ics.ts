// iCalendar (RFC 5545) feed generation for calendar subscriptions (Outlook, Google, Apple).

export interface FeedEvent {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  location: string;
  description: string;
  status: "CONFIRMED" | "TENTATIVE";
  categories?: string;
  updated: Date;
}

function esc(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function utc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Lines must be folded at 75 octets (UTF-8 aware). */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
    if (size + n > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += n;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export function buildCalendar(name: string, description: string, events: FeedEvent[]): string {
  const now = utc(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Room Scheduler//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`,
    `X-WR-CALDESC:${esc(description)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `DTSTAMP:${now}`,
      `LAST-MODIFIED:${utc(e.updated)}`,
      `DTSTART:${utc(e.start)}`,
      `DTEND:${utc(e.end)}`,
      `SUMMARY:${esc(e.summary)}`,
      `LOCATION:${esc(e.location)}`,
      ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
      ...(e.categories ? [`CATEGORIES:${esc(e.categories)}`] : []),
      `STATUS:${e.status}`,
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
