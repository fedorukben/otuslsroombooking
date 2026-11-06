import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import listPlugin from "@fullcalendar/list";
import luxonPlugin from "@fullcalendar/luxon3";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import type { EventInput, EventSourceFuncArg } from "@fullcalendar/core";
import { DateTime } from "luxon";
import { useEffect, useMemo, useRef } from "react";
import type { CalendarBooking, Category, Closure, Room } from "../../shared/types";
import { api, type Endpoints } from "../api";
import { onColor, toHm } from "../lib/time";

/** Week / month / list calendar for a single room. Drag across open time to book. */
export function RoomCalendar({
  zone,
  room,
  categories,
  endpoints,
  refreshKey,
  onSelect,
  onOpen,
}: {
  zone: string;
  room: Room;
  categories: Category[];
  endpoints: Endpoints;
  refreshKey: number;
  onSelect: (date: string, startMin: number, endMin: number) => void;
  onOpen: (b: CalendarBooking) => void;
}) {
  const ref = useRef<FullCalendar>(null);
  const catColor = useMemo(() => new Map(categories.map((c) => [c.id, c.color])), [categories]);

  useEffect(() => {
    ref.current?.getApi().refetchEvents();
  }, [refreshKey, room.id]);

  const businessHours = Object.entries(room.hours).flatMap(([wd, ranges]) =>
    (ranges as [number, number][]).map(([a, b]) => ({
      daysOfWeek: [Number(wd) % 7],
      startTime: toHm(a),
      endTime: b >= 1440 ? "24:00" : toHm(b),
    })),
  );
  const all = Object.values(room.hours).flat() as [number, number][];
  const slotMin = all.length ? Math.min(...all.map((r) => r[0])) : 480;
  const slotMax = all.length ? Math.max(...all.map((r) => r[1])) : 1080;

  async function fetchEvents(info: EventSourceFuncArg): Promise<EventInput[]> {
    const r = await api<{ bookings: CalendarBooking[]; closures: Closure[] }>(
      `${endpoints.events}?start=${encodeURIComponent(info.start.toISOString())}&end=${encodeURIComponent(info.end.toISOString())}&roomId=${room.id}`,
      { headers: endpoints.headers },
    );
    const events: EventInput[] = r.bookings.map((b) => {
      const bg = b.categoryId ? catColor.get(b.categoryId) ?? "#6e7781" : "#9a948a";
      return {
        id: String(b.id),
        title: `${b.status === "pending" ? "[Pending] " : ""}${b.title}${b.masked ? "" : ` · ${b.staffName}`}`,
        start: b.startsAt,
        end: b.endsAt,
        backgroundColor: bg,
        borderColor: bg,
        textColor: onColor(bg),
        classNames: [b.status, b.masked ? "masked" : ""],
        extendedProps: { booking: b },
      };
    });
    for (const c of r.closures.filter((c) => c.roomId === null || c.roomId === room.id)) {
      events.push({
        start: `${c.startDate}T00:00:00`,
        end: `${DateTime.fromISO(c.endDate).plus({ days: 1 }).toISODate()}T00:00:00`,
        display: "background",
        title: c.reason ? `Closed: ${c.reason}` : "Closed",
        classNames: ["closure-bg"],
      });
    }
    return events;
  }

  return (
    <div className="room-calendar">
      <FullCalendar
        ref={ref}
        plugins={[luxonPlugin, timeGridPlugin, dayGridPlugin, listPlugin, interactionPlugin]}
        timeZone={zone}
        initialView={window.innerWidth < 700 ? "listWeek" : "timeGridWeek"}
        headerToolbar={{ left: "prev,next today", center: "title", right: "timeGridDay,timeGridWeek,dayGridMonth,listWeek" }}
        buttonText={{ today: "Today", day: "Day", week: "Week", month: "Month", list: "List" }}
        firstDay={1}
        height="auto"
        allDaySlot={false}
        nowIndicator
        slotMinTime={toHm(Math.floor(slotMin / 60) * 60)}
        slotMaxTime={slotMax >= 1440 ? "24:00" : toHm(Math.ceil(slotMax / 60) * 60)}
        slotDuration={{ minutes: room.rules.slotMinutes >= 30 ? 30 : room.rules.slotMinutes }}
        snapDuration={{ minutes: room.rules.slotMinutes }}
        businessHours={businessHours}
        selectable
        selectMirror
        selectConstraint="businessHours"
        select={(info) => {
          const s = DateTime.fromISO(info.startStr).setZone(zone);
          const e = DateTime.fromISO(info.endStr).setZone(zone);
          const endMin = e.toISODate() !== s.toISODate() ? 1440 : e.hour * 60 + e.minute;
          onSelect(s.toISODate()!, s.hour * 60 + s.minute, endMin);
          ref.current?.getApi().unselect();
        }}
        events={(info, success, failure) => {
          fetchEvents(info).then(success, failure);
        }}
        eventClick={(info) => {
          const b = info.event.extendedProps.booking as CalendarBooking | undefined;
          if (b) onOpen(b);
        }}
        eventTimeFormat={{ hour: "numeric", minute: "2-digit", meridiem: "short" }}
      />
    </div>
  );
}
