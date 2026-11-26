import { z } from "zod";

export const failureCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
