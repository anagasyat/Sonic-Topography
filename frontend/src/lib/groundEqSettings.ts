export const GROUND_EQ_STORAGE_KEY = 'sonic-topography-ground-eq-v1';
export const GROUND_EQ_POINT_COUNT = 16;
export const DEFAULT_GROUND_EQ_VALUE = 50;

export interface StoredGroundEqSettings {
  curve: number[];
}

export const defaultGroundEqCurve = new Array(GROUND_EQ_POINT_COUNT).fill(DEFAULT_GROUND_EQ_VALUE);

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeGroundEqSettings(value: Partial<StoredGroundEqSettings> | null | undefined): StoredGroundEqSettings {
  const source = Array.isArray(value?.curve) ? value.curve : defaultGroundEqCurve;
  const curve = Array.from({ length: GROUND_EQ_POINT_COUNT }, (_, index) => {
    const numeric = Number(source[index]);
    return Number.isFinite(numeric) ? clamp(Math.round(numeric), 0, 100) : DEFAULT_GROUND_EQ_VALUE;
  });

  return { curve };
}

export function readGroundEqSettingsStorage(): StoredGroundEqSettings {
  if (typeof window === 'undefined') return { curve: defaultGroundEqCurve };

  try {
    const raw = window.localStorage.getItem(GROUND_EQ_STORAGE_KEY);
    return normalizeGroundEqSettings(raw ? JSON.parse(raw) : undefined);
  } catch (error) {
    console.warn('Unable to read ground EQ settings:', error);
    return { curve: defaultGroundEqCurve };
  }
}

export function writeGroundEqSettingsStorage(settings: StoredGroundEqSettings) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(GROUND_EQ_STORAGE_KEY, JSON.stringify(normalizeGroundEqSettings(settings)));
}

export function readGroundEqCurveValue(curve: number[], unit: number) {
  const normalized = normalizeGroundEqSettings({ curve }).curve;
  const safeUnit = clamp(unit, 0, 1);
  const scaled = safeUnit * (GROUND_EQ_POINT_COUNT - 1);
  const leftIndex = Math.floor(scaled);
  const rightIndex = Math.min(GROUND_EQ_POINT_COUNT - 1, leftIndex + 1);
  const mix = scaled - leftIndex;
  return normalized[leftIndex] * (1 - mix) + normalized[rightIndex] * mix;
}

export function applyGroundEqValue(value: number, curve: number[], unit: number) {
  const eq = readGroundEqCurveValue(curve, unit);
  const delta = (eq - DEFAULT_GROUND_EQ_VALUE) / DEFAULT_GROUND_EQ_VALUE;

  if (delta >= 0) {
    return clamp(value * (1 + delta * 1.8), 0, 1);
  }

  const dullness = Math.abs(delta);
  return clamp(Math.max(0, value - dullness * 0.35) * (1 - dullness * 0.35), 0, 1);
}
