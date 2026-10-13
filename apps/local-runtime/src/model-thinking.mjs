import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

export { getSupportedThinkingLevels };

export function normalizeThinkingLevel(value, model) {
  if (value === undefined || value === "default") return undefined;
  if (typeof value !== "string" || !getSupportedThinkingLevels(model).includes(value)) {
    throw new Error("所选模型不支持此思考强度，请重新选择");
  }
  return value;
}
