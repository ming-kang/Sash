import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

function isCidr(value: string): boolean {
  const match = /^([^/]+)\/(\d{1,3})$/.exec(value);
  if (!match?.[1] || !match[2]) return false;
  const family = isIP(match[1]);
  return family !== 0 && Number(match[2]) <= (family === 4 ? 32 : 128);
}

const tunFields = z.strictObject({
  enable: z.boolean(),
  stack: z.enum(["mixed", "system", "gvisor"]),
  autoRoute: z.boolean(),
  strictRoute: z.boolean(),
  dnsHijack: z.array(z.string().min(1).max(256).regex(/^\S+$/)).max(32),
  device: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\w.-]+$/)
    .refine((name) => process.platform !== "darwin" || /^utun\d+$/.test(name), "Use utunN on macOS")
    .optional(),
  routeExcludeAddress: z.array(z.string().refine(isCidr, "Expected an IP CIDR")).max(256),
});

export const tunSettingsPatchSchema = tunFields.partial().extend({
  // null removes a previously configured interface name.
  device: tunFields.shape.device.nullable(),
});
export type TunSettings = z.output<typeof tunFields>;
export type TunSettingsPatch = z.input<typeof tunSettingsPatchSchema>;

export const sameTunSettings: (left: TunSettings, right: TunSettings) => boolean =
  isDeepStrictEqual;

export function defaultTunSettings(): TunSettings {
  return {
    enable: false,
    stack: "mixed",
    autoRoute: true,
    strictRoute: false,
    dnsHijack: ["any:53", "tcp://any:53"],
    routeExcludeAddress: [],
  };
}

export function applyTunPatch(base: TunSettings, patch: TunSettingsPatch): TunSettings {
  const hasDevicePatch = Object.hasOwn(patch, "device");
  const { device, ...fields } = patch;
  const merged: TunSettings = { ...base, ...fields };
  if (device === null) delete merged.device;
  else if (hasDevicePatch) merged.device = device;
  return merged;
}

export const tunSettingsSchema = tunFields.partial().transform((value): TunSettings => {
  const { device, ...rest } = value;
  return { ...defaultTunSettings(), ...rest, ...(typeof device === "string" ? { device } : {}) };
});

export function parseStoredTunSettings(value: unknown): TunSettings {
  const parsed = tunSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultTunSettings();
}
