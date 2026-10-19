export type OpenCodePin = {
  OPENCODE_RELEASE_TAG: string;
  OPENCODE_VERSION: string;
  OPENCODE_SOURCE_SHA: string;
  OPENCODE_ARCHIVE_SHA256: string;
  OPENCODE_BINARY_SHA256: string;
};

export const PIN_FIELDS: readonly string[];

export function readOpenCodePin(workflowText: string): OpenCodePin;
export function assertOpenCodePin(pin: Partial<OpenCodePin>): OpenCodePin;
export function writeOpenCodePin(workflowText: string, pin: Partial<OpenCodePin>): string;
export function pinFromDecision(decision: unknown): OpenCodePin;
