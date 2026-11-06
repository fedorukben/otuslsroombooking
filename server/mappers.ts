import type {
  AdminTeam,
  BookingRules,
  CalendarBooking,
  Category,
  Closure,
  ManagedBooking,
  PublicTeam,
  Room,
  RuleOverrides,
  WeeklyHours,
} from "../shared/types.js";

export interface TeamRow {
  id: number;
  name: string;
  description: string;
  timezone: string;
  share_token: string;
  feed_token: string;
  admin_feed_token: string;
  pin_hash: string | null;
  accent_color: string;
  logo_data_url: string | null;
  slot_minutes: number;
  min_minutes: number;
  max_minutes: number;
  max_days_ahead: number;
  buffer_minutes: number;
  capacity_mode: "warn" | "block";
  require_email: boolean;
  require_attendance: boolean;
  require_description: boolean;
  default_hours: WeeklyHours;
  created_at: Date;
}

export interface RoomRow {
  id: number;
  team_id: number;
  name: string;
  code: string;
  building: string;
  campus: string;
  floor: string;
  capacity: number | null;
  description: string;
  color: string;
  requires_approval: boolean;
  active: boolean;
  allowed_category_ids: number[];
  hours: WeeklyHours;
  slot_minutes: number | null;
  min_minutes: number | null;
  max_minutes: number | null;
  max_days_ahead: number | null;
  buffer_minutes: number | null;
  capacity_mode: "warn" | "block" | null;
  sort_order: number;
}

export interface BookingRow {
  id: number;
  team_id: number;
  room_id: number;
  series_id: number;
  category_id: number;
  title: string;
  staff_name: string;
  staff_email: string;
  attendance: number | null;
  description: string;
  is_private: boolean;
  all_day: boolean;
  starts_at: Date;
  ends_at: Date;
  status: "confirmed" | "pending" | "cancelled";
  is_exception: boolean;
  updated_at?: Date;
  recurring?: boolean;
}

export function teamRules(t: TeamRow): BookingRules {
  return {
    slotMinutes: t.slot_minutes,
    minMinutes: t.min_minutes,
    maxMinutes: t.max_minutes,
    maxDaysAhead: t.max_days_ahead,
    bufferMinutes: t.buffer_minutes,
    capacityMode: t.capacity_mode,
  };
}

export function roomOverrides(r: RoomRow): RuleOverrides {
  return {
    slotMinutes: r.slot_minutes,
    minMinutes: r.min_minutes,
    maxMinutes: r.max_minutes,
    maxDaysAhead: r.max_days_ahead,
    bufferMinutes: r.buffer_minutes,
    capacityMode: r.capacity_mode,
  };
}

export function effectiveRules(t: TeamRow, r: RoomRow): BookingRules {
  const base = teamRules(t);
  const o = roomOverrides(r);
  return {
    slotMinutes: o.slotMinutes ?? base.slotMinutes,
    minMinutes: o.minMinutes ?? base.minMinutes,
    maxMinutes: o.maxMinutes ?? base.maxMinutes,
    maxDaysAhead: o.maxDaysAhead ?? base.maxDaysAhead,
    bufferMinutes: o.bufferMinutes ?? base.bufferMinutes,
    capacityMode: o.capacityMode ?? base.capacityMode,
  };
}

export function publicTeam(t: TeamRow): PublicTeam {
  return {
    name: t.name,
    description: t.description,
    timezone: t.timezone,
    accentColor: t.accent_color,
    logoDataUrl: t.logo_data_url,
    pinRequired: !!t.pin_hash,
    rules: teamRules(t),
    requiredFields: { email: t.require_email, attendance: t.require_attendance, description: t.require_description },
  };
}

export function adminTeam(t: TeamRow & { room_count?: number; pending_count?: number }): AdminTeam {
  return {
    ...publicTeam(t),
    id: t.id,
    shareToken: t.share_token,
    feedToken: t.feed_token,
    adminFeedToken: t.admin_feed_token,
    hasPin: !!t.pin_hash,
    defaultHours: t.default_hours,
    roomCount: Number(t.room_count ?? 0),
    pendingCount: Number(t.pending_count ?? 0),
    createdAt: new Date(t.created_at).toISOString(),
  };
}

export function room(r: RoomRow, t: TeamRow): Room {
  return {
    id: r.id,
    teamId: r.team_id,
    name: r.name,
    code: r.code,
    building: r.building,
    campus: r.campus,
    floor: r.floor,
    capacity: r.capacity,
    description: r.description,
    color: r.color,
    requiresApproval: r.requires_approval,
    active: r.active,
    allowedCategoryIds: r.allowed_category_ids ?? [],
    hours: r.hours,
    overrides: roomOverrides(r),
    rules: effectiveRules(t, r),
    sortOrder: r.sort_order,
  };
}

export function category(c: { id: number; name: string; color: string; sort_order: number; active: boolean }): Category {
  return { id: c.id, name: c.name, color: c.color, sortOrder: c.sort_order, active: c.active };
}

const ymd = (d: Date | string) => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));

export function closure(c: { id: number; room_id: number | null; start_date: Date | string; end_date: Date | string; reason: string }): Closure {
  return { id: c.id, roomId: c.room_id, startDate: ymd(c.start_date), endDate: ymd(c.end_date), reason: c.reason };
}

export function calendarBooking(b: BookingRow, { admin }: { admin: boolean }): CalendarBooking {
  const masked = b.is_private && !admin;
  return {
    id: b.id,
    seriesId: b.series_id,
    roomId: b.room_id,
    categoryId: masked ? null : b.category_id,
    title: masked ? "Busy" : b.title,
    staffName: masked ? "" : b.staff_name,
    ...(admin ? { staffEmail: b.staff_email } : {}),
    attendance: masked ? null : b.attendance,
    description: masked ? "" : b.description,
    isPrivate: b.is_private,
    masked,
    allDay: b.all_day,
    startsAt: new Date(b.starts_at).toISOString(),
    endsAt: new Date(b.ends_at).toISOString(),
    status: b.status,
    recurring: !!b.recurring,
  };
}

/** For the manage page: the booker (holder of the private link) sees everything about their own booking. */
export function managedBooking(b: BookingRow): ManagedBooking {
  return { ...calendarBooking(b, { admin: true }), isException: b.is_exception };
}
