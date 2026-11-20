import { z } from "zod";

/**
 * Request-body shapes for the daemon API. Fields left as `z.unknown()`
 * intentionally stay lenient: handlers extract them with their historical
 * coercion so wire behavior does not change. Handlers keep their historical
 * validation messages; these schemas exist so shape checks and inferred
 * types share one source instead of hand-rolled key scans.
 */
export const apiErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

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

export const SETTINGS_PATCHABLE_KEYS = [
  "expectedRevision",
  "mixedPort",
  "allowLan",
  "systemProxy",
] as const;

// Values stay unvalidated: SettingsService owns range/type rules and its
// error messages; the API boundary only enforces the patchable key set.
export const settingsPatchBodySchema = z
  .object({
    expectedRevision: z.unknown().optional(),
    mixedPort: z.unknown().optional(),
    allowLan: z.unknown().optional(),
    systemProxy: z.unknown().optional(),
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
export type SettingsPatchBody = z.infer<typeof settingsPatchBodySchema>;
