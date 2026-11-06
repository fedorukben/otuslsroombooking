import type { Room } from "../../shared/types";
import { roomLabel } from "../lib/time";
import { Modal } from "./Modal";
import { CopyLink } from "./Scheduler";

function feedUrl(token: string, roomId?: number) {
  return `${location.origin}/api/feed/${token}.ics${roomId ? `?room=${roomId}` : ""}`;
}

function FeedRow({ label, url }: { label: string; url: string }) {
  return (
    <li className="feed-row">
      <span className="feed-label">{label}</span>
      <CopyLink url={url} />
      <a className="btn small ghost" href={url.replace(/^https?:/, "webcal:")}>
        Open in calendar app
      </a>
    </li>
  );
}

/** Calendar subscription links (.ics) for Outlook, Google Calendar and Apple Calendar. */
export function SubscribeModal({
  teamName,
  rooms,
  feedToken,
  adminFeedToken,
  onClose,
}: {
  teamName: string;
  rooms: Room[];
  feedToken: string;
  adminFeedToken?: string;
  onClose: () => void;
}) {
  return (
    <Modal title="Subscribe in your calendar" onClose={onClose} wide>
      <div className="stack">
        <p>
          Add these links to Outlook, Google Calendar or Apple Calendar and bookings will appear there and stay up to date. Calendar apps
          refresh subscriptions on their own schedule: Outlook and Apple usually within an hour, Google can take up to a day.
        </p>
        <details className="howto">
          <summary>How to add a link</summary>
          <ul>
            <li>
              <strong>Outlook:</strong> Calendar → Add calendar → Subscribe from web → paste the link.
            </li>
            <li>
              <strong>Google Calendar:</strong> Other calendars → + → From URL → paste the link.
            </li>
            <li>
              <strong>Apple Calendar:</strong> click “Open in calendar app”, or File → New Calendar Subscription.
            </li>
          </ul>
        </details>
        <h3>{adminFeedToken ? "Staff view (private bookings show as “Busy”)" : "Feeds"}</h3>
        <ul className="feed-list">
          <FeedRow label={`All rooms — ${teamName}`} url={feedUrl(feedToken)} />
          {rooms.map((r) => (
            <FeedRow key={r.id} label={roomLabel(r)} url={feedUrl(feedToken, r.id)} />
          ))}
        </ul>
        {adminFeedToken && (
          <>
            <h3>Admin view (full details)</h3>
            <p className="warn-text">
              This feed shows private booking titles and staff emails. Keep it to yourself. Regenerating the team link in Settings also resets
              every feed link.
            </p>
            <ul className="feed-list">
              <FeedRow label={`All rooms — ${teamName} (admin)`} url={feedUrl(adminFeedToken)} />
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
