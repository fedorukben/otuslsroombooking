import type { Config, Context } from "@netlify/functions";
import { router } from "../../server/routes.js";

export default async (req: Request, context: Context) => {
  return router.handle(req, context.ip ?? "unknown");
};

export const config: Config = {
  path: "/api/*",
};
