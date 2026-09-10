import YAML from "yaml";

/** The single YAML entry point for subscriptions, local sources and runtime handoffs. */
export function parseCoreYaml(text: string): unknown {
  return YAML.parse(text);
}
