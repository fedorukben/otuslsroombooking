export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: any,
  ) {
    super(message);
  }
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data);
  return data as T;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/** Member PINs are remembered per team link on this device. */
export const pinStore = {
  get: (token: string) => {
    try {
      return localStorage.getItem(`rs_pin_${token}`) ?? "";
    } catch {
      return "";
    }
  },
  set: (token: string, pin: string) => {
    try {
      localStorage.setItem(`rs_pin_${token}`, pin);
    } catch {
      /* storage unavailable */
    }
  },
};

/** Endpoints differ between members (share link) and admins; everything else is the same UI. */
export interface Endpoints {
  events: string;
  preview: string;
  create: string;
  headers: Record<string, string>;
  admin: boolean;
}

export function memberEndpoints(token: string): Endpoints {
  const pin = pinStore.get(token);
  return {
    events: `/t/${token}/events`,
    preview: `/t/${token}/bookings/preview`,
    create: `/t/${token}/bookings`,
    headers: pin ? { "x-team-pin": pin } : {},
    admin: false,
  };
}

/** Signed-in staff: book as themselves, no team link or PIN needed. */
export function staffEndpoints(teamId: number): Endpoints {
  return {
    events: `/s/teams/${teamId}/events`,
    preview: `/s/teams/${teamId}/bookings/preview`,
    create: `/s/teams/${teamId}/bookings`,
    headers: {},
    admin: false,
  };
}

export function adminEndpoints(teamId: number): Endpoints {
  return {
    events: `/admin/teams/${teamId}/events`,
    preview: `/admin/teams/${teamId}/bookings/preview`,
    create: `/admin/teams/${teamId}/bookings`,
    headers: {},
    admin: true,
  };
}
