// Types shared by the frontend and the API.

/** ISO weekday (1 = Monday ... 7 = Sunday) -> list of [startMinute, endMinute] ranges. */
export type WeeklyHours = Record<string, [number, number][]>;

export type CapacityMode = "warn" | "block";

export interface BookingRules {
  slotMinutes: number;
  minMinutes: number;
  maxMinutes: number;
  maxDaysAhead: number;
  bufferMinutes: number;
  capacityMode: CapacityMode;
}

export type RuleOverrides = { [K in keyof BookingRules]: BookingRules[K] | null };

export interface RequiredFields {
  email: boolean;
  attendance: boolean;
  description: boolean;
}

export interface Category {
  id: number;
  name: string;
  color: string;
  sortOrder: number;
  active: boolean;
}

export interface Room {
  id: number;
  teamId: number;
  name: string;
  code: string;
  building: string;
  campus: string;
  floor: string;
  capacity: number | null;
  description: string;
  color: string;
  requiresApproval: boolean;
  active: boolean;
  allowedCategoryIds: number[];
  hours: WeeklyHours;
  overrides: RuleOverrides;
  /** Overrides merged over team defaults. */
  rules: BookingRules;
  sortOrder: number;
}

export interface Closure {
  id: number;
  roomId: number | null;
  startDate: string;
  endDate: string;
  reason: string;
}

/** What members see about a team (no secrets). */
export interface PublicTeam {
  name: string;
  description: string;
  timezone: string;
  accentColor: string;
  logoDataUrl: string | null;
  pinRequired: boolean;
  rules: BookingRules;
  requiredFields: RequiredFields;
}

export interface AdminTeam extends PublicTeam {
  id: number;
  shareToken: string;
  feedToken: string;
  adminFeedToken: string;
  hasPin: boolean;
  defaultHours: WeeklyHours;
  roomCount: number;
  pendingCount: number;
  createdAt: string;
}

export type RecurrenceFreq = "daily" | "weekly" | "monthly";

export interface Recurrence {
  freq: RecurrenceFreq;
  /** Every N days/weeks/months. */
  interval: number;
  /** ISO weekdays, used when freq = weekly. */
  byWeekday?: number[];
  /** monthly: same date each month (e.g. the 15th) or same weekday position (e.g. 2nd Tuesday). */
  monthlyMode?: "date" | "weekday";
  end: { type: "until"; date: string } | { type: "count"; count: number };
}

export type BookingStatus = "confirmed" | "pending" | "cancelled";

export interface BookingInput {
  roomId: number;
  categoryId: number;
  title: string;
  staffName: string;
  staffEmail: string;
  attendance: number | null;
  description: string;
  isPrivate: boolean;
  allDay: boolean;
  /** Local date in the team time zone, YYYY-MM-DD. */
  date: string;
  /** Local times HH:mm (ignored when allDay). */
  startTime: string;
  endTime: string;
  recurrence: Recurrence | null;
  /** Dates (YYYY-MM-DD) the booker chose to skip because they had problems. */
  skipDates?: string[];
  /** Admin only: ignore booking rules (hours, closures, limits). Overlaps are never allowed. */
  override?: boolean;
  /** Honeypot. Must stay empty. */
  website?: string;
}

export type IssueCode =
  | "conflict"
  | "buffer"
  | "closed"
  | "outside_hours"
  | "closure"
  | "past"
  | "too_far"
  | "too_short"
  | "too_long"
  | "step"
  | "capacity"
  | "category"
  | "inactive";

export interface Issue {
  code: IssueCode;
  message: string;
  /** block = cannot book this date; warn = can book, but the booker should know. */
  severity: "block" | "warn";
}

export interface OccurrencePreview {
  date: string;
  startsAt: string;
  endsAt: string;
  issues: Issue[];
}

export interface PreviewResult {
  occurrences: OccurrencePreview[];
  /** Number of occurrences that would be booked (not blocked, not skipped). */
  bookable: number;
  willBePending: boolean;
  truncated: boolean;
}

/** A booking as shown on calendars. Private bookings are masked for members. */
export interface CalendarBooking {
  id: number;
  seriesId: number;
  roomId: number;
  categoryId: number | null;
  title: string;
  staffName: string;
  staffEmail?: string;
  attendance: number | null;
  description: string;
  isPrivate: boolean;
  masked: boolean;
  allDay: boolean;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  recurring: boolean;
}

export interface ManagedBooking extends CalendarBooking {
  isException: boolean;
}

export interface ManageView {
  team: PublicTeam;
  rooms: Room[];
  categories: Category[];
  recurrence: Recurrence | null;
  bookings: ManagedBooking[];
  admin: boolean;
  teamId?: number;
}

export type EditScope = "this" | "following" | "all";

export interface CreateResult {
  manageToken: string;
  seriesId: number;
  created: number;
  status: BookingStatus;
}

export interface FreeRoomResult {
  roomId: number;
  available: boolean;
  freeCount: number;
  total: number;
  reasons: string[];
}

export interface ActivityEntry {
  id: number;
  teamId: number | null;
  teamName: string;
  actorType: "admin" | "member" | "system";
  actorName: string;
  ip: string;
  action: string;
  summary: string;
  createdAt: string;
}

export interface AdminAccount {
  id: number;
  email: string;
  name: string;
  isSuper: boolean;
  teamIds: number[];
  createdAt: string;
  lastLoginAt: string | null;
}
