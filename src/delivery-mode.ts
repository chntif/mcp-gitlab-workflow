export const DELIVERY_METHOD_VALUES = ["local_git", "remote_api"] as const;

export type DeliveryMethod = (typeof DELIVERY_METHOD_VALUES)[number];

export function isDeliveryMethod(value: string): value is DeliveryMethod {
  return DELIVERY_METHOD_VALUES.includes(value as DeliveryMethod);
}

export function normalizeDeliveryMethod(value: string): DeliveryMethod {
  const normalized = value.trim().toLowerCase();
  if (!isDeliveryMethod(normalized)) {
    throw new Error("Invalid delivery method. Use 'local_git' or 'remote_api'.");
  }
  return normalized;
}
