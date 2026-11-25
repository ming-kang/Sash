import { z } from "zod";
import { tunSettingsPatchSchema } from "./tun-settings.js";

export const coreUpdateBodySchema = z.object({ version: z.string().optional() }).strict();

export const coreModeBodySchema = z.object({ mode: z.enum(["rule", "global", "direct"]) }).strict();

export const coreDelayBodySchema = z.object({ name: z.string() }).strict();

export const profilesReorderBodySchema = z.object({
  ids: z.array(z.string()),
});

export const profileAddBodySchema = z.object({
  url: z.string().optional(),
  name: z.string().optional(),
  activate: z.boolean().optional(),
});

export const profileImportBodySchema = z.object({
  name: z.string().optional(),
  content: z.string().optional(),
});

export const profileActivateBodySchema = z.object({
  id: z.union([z.string(), z.null()]),
});

export const profileContentBodySchema = z.object({
  content: z.string().optional(),
  revision: z.number().int().min(1).safe(),
});

export const profileRenameBodySchema = z.object({
  name: z.string().optional(),
});

export const settingsPatchBodySchema = z
  .object({
    expectedRevision: z.number().int().min(0).safe().optional(),
    mixedPort: z.number().int().min(1).max(65_535).optional(),
    allowLan: z.boolean().optional(),
    systemProxy: z.boolean().optional(),
    tun: tunSettingsPatchSchema.optional(),
  })
  .strict();

export const tunHelperBodySchema = z
  .object({ helperAuth: z.enum(["sudo", "pkexec"]).optional() })
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
export type SettingsPatchBody = z.infer<typeof settingsPatchBodySchema>;
