import { z, type ZodType } from "zod";
import { badRequest } from "./errors.js";

export function parse<S extends ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      "Request validation failed",
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}

export const uuid = z.uuid();
export const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
export const limit = z.coerce.number().int().min(1).max(100).default(20);

export const encodeCursor = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
export function decodeCursor<T>(c: string | undefined): T | undefined {
  if (!c) return undefined;
  try {
    return JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as T;
  } catch {
    throw badRequest("Invalid cursor");
  }
}
