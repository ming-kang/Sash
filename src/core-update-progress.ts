export type CoreUpdateStage =
  | "checking"
  | "resolving"
  | "downloading"
  | "extracting"
  | "verifying"
  | "validating"
  | "waiting"
  | "installing";
export interface CoreUpdateProgress {
  stage: CoreUpdateStage;
  startedAt: string;
  target: string | null;
  downloading: boolean;
  downloaded: number;
  total: number | null;
}
