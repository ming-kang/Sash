import { z } from "zod";
import { tunSettingsPatchSchema } from "./tun-settings.js";

export const coreUpdateBodySchema = z.object({ version: z.string().optional() }).strict();

export const coreModeBodySchema = z.object({ mode: z.enum(["rule", "global", "direct"]) }).strict();

export const coreDelayBodySchema = z.object({ name: z.unknown() }).strict();

export const profilesReorderBodySchema = z.object({
  ids: z.array(z.string()),
});

export const profileAddBodySchema = z.object({
  url: z.unknown().optional(),
  name: z.unknown().optional(),
  activate: z.unknown().optional(),
});

export const profileImportBodySchema = z.object({
  name: z.unknown().optional(),
  content: z.unknown().optional(),
});

export const profileActivateBodySchema = z.object({
  id: z.union([z.string(), z.null()]),
});

export const profileContentBodySchema = z.object({
  content: z.unknown().optional(),
  revision: z.number().int().min(1).safe(),
});

export const profileRenameBodySchema = z.object({
  name: z.unknown().optional(),
});

export const unvalidatedSettingsPatchBodySchema = z
  .object({
    expectedRevision: z.unknown().optional(),
    mixedPort: z.unknown().optional(),
    allowLan: z.unknown().optional(),
    systemProxy: z.unknown().optional(),
    tun: tunSettingsPatchSchema.optional(),
  })
  .strict();

export type CoreUpdateBody = z.infer<typeof coreUpdateBodySchema>;
export type CoreModeBody = z.infer<typeof coreModeBodySchema>;
export type CoreDelayBody = z.infer<typeof coreDelayBodySchema>;
export type ProfilesReorderBody = z.infer<typeof profilesReorderBodySchema>;
export type ProfileAddBody = z.infer<typeof profileAddBodySchema>;
export type ProfileImportBody = z.infer<typeof profileImportBodySchema>;
export type ProfileActivateBody = z.infer<typeof profileActivateBodySchema>;
export type ProfileContentBody = z.infer<typeof profileContentBodySchema>;
export type ProfileRenameBody = z.infer<typeof profileRenameBodySchema>;
export type SettingsPatchBody = z.infer<typeof unvalidatedSettingsPatchBodySchema>;
