/**
 * Heuristic to detect built-in/internal microphones from their label.
 * Case-insensitive keyword match — easy to extend.
 */
const BUILTIN_KEYWORDS = ["built-in", "internal", "macbook"];

export function isBuiltInMic(label: string): boolean {
  const lower = label.toLowerCase();
  return BUILTIN_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Browsers expose a virtual "default" entry (deviceId === "default") whose
 * label looks like "Default - <real device name>". The real device is also
 * enumerated separately with its own deviceId (and matching groupId).
 *
 * Given a list of devices and the currently-selected deviceId, return the
 * underlying real device. Falls back to the original device if no resolution
 * is possible.
 */
export function resolveDefaultDevice(
  devices: MediaDeviceInfo[],
  deviceId: string,
): MediaDeviceInfo | undefined {
  const selected = devices.find((d) => d.deviceId === deviceId);
  if (!selected) return undefined;
  if (selected.deviceId !== "default") return selected;

  // Try matching by groupId — the most reliable signal.
  const byGroup = devices.find(
    (d) => d.deviceId !== "default" && d.groupId && d.groupId === selected.groupId,
  );
  if (byGroup) return byGroup;

  // Fallback: parse "Default - <name>" and match a device whose label ends
  // with that name (Chrome wraps with "Default - ", Safari/Firefox vary).
  const match = selected.label.match(/^Default\s*[-–—]\s*(.+)$/i);
  if (match) {
    const underlyingName = match[1].trim().toLowerCase();
    const byLabel = devices.find(
      (d) =>
        d.deviceId !== "default" &&
        d.label.toLowerCase().includes(underlyingName),
    );
    if (byLabel) return byLabel;
  }

  return selected;
}

/**
 * Decide whether the currently-selected mic should trigger the built-in
 * warning. Resolves OS-default to its underlying real device first so that
 * "Default - <my Focusrite>" doesn't trip the heuristic.
 */
export function isSelectedMicBuiltIn(
  devices: MediaDeviceInfo[],
  deviceId: string,
): boolean {
  const resolved = resolveDefaultDevice(devices, deviceId);
  if (!resolved) return false;
  return isBuiltInMic(resolved.label);
}
