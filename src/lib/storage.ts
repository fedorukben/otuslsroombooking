// Remembers the booker's details and their manage links on this device only.

export interface SavedBooking {
  token: string;
  seriesId: number;
  title: string;
  teamName: string;
  roomName: string;
  firstStart: string;
  recurring: boolean;
  savedAt: string;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode etc.) */
  }
}

export const me = {
  get: () => read<{ name: string; email: string }>("rs_me", { name: "", email: "" }),
  set: (v: { name: string; email: string }) => write("rs_me", v),
};

export const savedBookings = {
  list: () => read<SavedBooking[]>("rs_bookings", []),
  add: (b: SavedBooking) => write("rs_bookings", [b, ...savedBookings.list().filter((x) => x.token !== b.token)].slice(0, 50)),
  remove: (token: string) => write("rs_bookings", savedBookings.list().filter((x) => x.token !== token)),
};
