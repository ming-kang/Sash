import {
  RiArrowLeftRightLine,
  RiCheckboxCircleLine,
  RiClipboardLine,
  RiCloseLine,
  RiComputerLine,
  RiDashboardLine,
  RiDeleteBin6Line,
  RiDownload2Line,
  RiErrorWarningLine,
  RiFilter3Line,
  RiFlashlightLine,
  RiGlobalLine,
  RiInformationLine,
  RiMoonLine,
  RiPauseLine,
  RiPlayLine,
  RiQuestionLine,
  RiRefreshLine,
  RiSearchLine,
  RiSettings3Line,
  RiShutDownLine,
  RiStackLine,
  RiSunLine,
  RiTerminalBoxLine,
  RiUpload2Line,
} from "@remixicon/vue";
import type { Component } from "vue";

/** Semantic Sash names mapped to official Remix Icon line components. */
export const iconComponents = {
  alert: RiErrorWarningLine,
  "check-circle": RiCheckboxCircleLine,
  clipboard: RiClipboardLine,
  download: RiDownload2Line,
  globe: RiGlobalLine,
  grid: RiDashboardLine,
  info: RiInformationLine,
  layers: RiStackLine,
  "list-filter": RiFilter3Line,
  monitor: RiComputerLine,
  moon: RiMoonLine,
  pause: RiPauseLine,
  play: RiPlayLine,
  power: RiShutDownLine,
  refresh: RiRefreshLine,
  search: RiSearchLine,
  settings: RiSettings3Line,
  sun: RiSunLine,
  swap: RiArrowLeftRightLine,
  terminal: RiTerminalBoxLine,
  trash: RiDeleteBin6Line,
  upload: RiUpload2Line,
  x: RiCloseLine,
  zap: RiFlashlightLine,
} satisfies Record<string, Component>;

export type IconName = keyof typeof iconComponents;

export function resolveIcon(name: string): Component {
  return iconComponents[name as IconName] ?? RiQuestionLine;
}
