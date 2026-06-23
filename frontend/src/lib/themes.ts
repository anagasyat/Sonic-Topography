import * as THREE from 'three';

export interface CustomThemeSettings {
  id: string;
  name: string;
  background: string;
  cool: string;
  warm: string;
  accent: string;
  glowIntensity: number;
  rotationSpeed: number;
  showPlayerPanel: boolean;
}

export interface ThemeColors {
  name: string;
  id: string;
  uBaseColor1: THREE.Color;
  uBaseColor2: THREE.Color;
  uCoolCore: THREE.Color;
  uCoolEdge: THREE.Color;
  uWarmCore: THREE.Color;
  uWarmEdge: THREE.Color;
  uRippleColor: THREE.Color;
  uGlowIntensity: number;
  uRotationSpeed: number;
  uShowPlayerPanel: boolean;
}

export interface ThemeRotationSettings {
  enabled: boolean;
  intervalSeconds: number;
  themeIds: string[];
}

export const CUSTOM_THEME_ID = 'custom';
export const BUILT_IN_THEME_IDS = ['nocturnal', 'neon-tokyo', 'cyber-forest', 'minimal-monochrome'];
export const CUSTOM_THEME_STORAGE_KEY = 'sonic-topography-custom-themes-v2';
export const LEGACY_CUSTOM_THEME_STORAGE_KEY = 'sonic-topography-custom-theme-v1';
export const ACTIVE_CUSTOM_THEME_STORAGE_KEY = 'sonic-topography-active-custom-theme-v1';
export const ACTIVE_THEME_STORAGE_KEY = 'sonic-topography-active-theme-v1';
export const THEME_ROTATION_STORAGE_KEY = 'sonic-topography-theme-rotation-v1';

export const defaultCustomThemeSettings: CustomThemeSettings = {
  id: 'custom-default',
  name: '自定义主题 1',
  background: '#07111f',
  cool: '#38bdf8',
  warm: '#f97316',
  accent: '#22d3ee',
  glowIntensity: 1.1,
  rotationSpeed: 0.5,
  showPlayerPanel: true,
};

export const defaultThemeRotationSettings: ThemeRotationSettings = {
  enabled: false,
  intervalSeconds: 10,
  themeIds: BUILT_IN_THEME_IDS,
};

function normalizeHexColor(value: unknown, fallback: string) {
  const color = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}

function clampGlowIntensity(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return defaultCustomThemeSettings.glowIntensity;
  return Math.max(0.4, Math.min(numeric, 2.2));
}

function clampSceneRotationSpeed(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return defaultCustomThemeSettings.rotationSpeed;
  return Math.max(0, Math.min(numeric, 2));
}

function clampRotationInterval(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return defaultThemeRotationSettings.intervalSeconds;
  return Math.max(3, Math.min(Math.round(numeric), 300));
}

export function normalizeCustomThemeSettings(value: Partial<CustomThemeSettings> | null | undefined): CustomThemeSettings {
  const legacyValue = value as (Partial<CustomThemeSettings> & { showThemeButton?: unknown }) | null | undefined;
  return {
    id: String(value?.id || defaultCustomThemeSettings.id),
    name: String(value?.name || defaultCustomThemeSettings.name).trim() || defaultCustomThemeSettings.name,
    background: normalizeHexColor(value?.background, defaultCustomThemeSettings.background),
    cool: normalizeHexColor(value?.cool, defaultCustomThemeSettings.cool),
    warm: normalizeHexColor(value?.warm, defaultCustomThemeSettings.warm),
    accent: normalizeHexColor(value?.accent, defaultCustomThemeSettings.accent),
    glowIntensity: clampGlowIntensity(value?.glowIntensity),
    rotationSpeed: clampSceneRotationSpeed(value?.rotationSpeed),
    showPlayerPanel: value?.showPlayerPanel === undefined
      ? (legacyValue?.showThemeButton === undefined ? defaultCustomThemeSettings.showPlayerPanel : Boolean(legacyValue.showThemeButton))
      : Boolean(value.showPlayerPanel),
  };
}

function createCustomThemeId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `custom-${crypto.randomUUID()}`;
  return `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createCustomThemePreset(seed: Partial<CustomThemeSettings> = {}): CustomThemeSettings {
  return normalizeCustomThemeSettings({
    ...defaultCustomThemeSettings,
    ...seed,
    id: seed.id || createCustomThemeId(),
  });
}

export function readCustomThemeStorage(): CustomThemeSettings[] {
  if (typeof window === 'undefined') return [defaultCustomThemeSettings];

  try {
    const raw = window.localStorage.getItem(CUSTOM_THEME_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((preset) => normalizeCustomThemeSettings(preset));
    }

    const legacyRaw = window.localStorage.getItem(LEGACY_CUSTOM_THEME_STORAGE_KEY);
    const legacyPreset = legacyRaw ? normalizeCustomThemeSettings(JSON.parse(legacyRaw)) : defaultCustomThemeSettings;
    return [legacyPreset];
  } catch (error) {
    console.warn('Unable to read custom theme settings:', error);
    return [defaultCustomThemeSettings];
  }
}

export function writeCustomThemeStorage(settings: CustomThemeSettings[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(settings.map((preset) => normalizeCustomThemeSettings(preset))));
}

export function readActiveCustomThemeStorage(presets: CustomThemeSettings[]) {
  if (typeof window === 'undefined') return presets[0]?.id || defaultCustomThemeSettings.id;

  const stored = window.localStorage.getItem(ACTIVE_CUSTOM_THEME_STORAGE_KEY) || '';
  return presets.some((preset) => preset.id === stored) ? stored : (presets[0]?.id || defaultCustomThemeSettings.id);
}

export function writeActiveCustomThemeStorage(presetId: string) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ACTIVE_CUSTOM_THEME_STORAGE_KEY, presetId);
}

export function readActiveThemeStorage() {
  if (typeof window === 'undefined') return 'nocturnal';

  const stored = window.localStorage.getItem(ACTIVE_THEME_STORAGE_KEY) || '';
  return stored === CUSTOM_THEME_ID || BUILT_IN_THEME_IDS.includes(stored) ? stored : 'nocturnal';
}

export function writeActiveThemeStorage(themeId: string) {
  if (typeof window === 'undefined') return;
  if (themeId === CUSTOM_THEME_ID || BUILT_IN_THEME_IDS.includes(themeId)) {
    window.localStorage.setItem(ACTIVE_THEME_STORAGE_KEY, themeId);
  }
}

export function normalizeThemeRotationSettings(
  value: Partial<ThemeRotationSettings> | null | undefined,
  availableThemeIds: string[],
): ThemeRotationSettings {
  const fallbackThemeIds = availableThemeIds.length ? availableThemeIds : BUILT_IN_THEME_IDS;
  const incomingThemeIds = Array.isArray(value?.themeIds) ? value.themeIds.map(String) : fallbackThemeIds;
  const themeIds = incomingThemeIds.filter((id, index, ids) => fallbackThemeIds.includes(id) && ids.indexOf(id) === index);

  return {
    enabled: Boolean(value?.enabled),
    intervalSeconds: clampRotationInterval(value?.intervalSeconds),
    themeIds: themeIds.length ? themeIds : fallbackThemeIds,
  };
}

export function readThemeRotationStorage(availableThemeIds: string[]) {
  if (typeof window === 'undefined') return normalizeThemeRotationSettings(defaultThemeRotationSettings, availableThemeIds);

  try {
    const raw = window.localStorage.getItem(THEME_ROTATION_STORAGE_KEY);
    return normalizeThemeRotationSettings(raw ? JSON.parse(raw) : defaultThemeRotationSettings, availableThemeIds);
  } catch (error) {
    console.warn('Unable to read theme rotation settings:', error);
    return normalizeThemeRotationSettings(defaultThemeRotationSettings, availableThemeIds);
  }
}

export function writeThemeRotationStorage(settings: ThemeRotationSettings, availableThemeIds: string[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(THEME_ROTATION_STORAGE_KEY, JSON.stringify(normalizeThemeRotationSettings(settings, availableThemeIds)));
}

export function createCustomThemeColors(settings: CustomThemeSettings): ThemeColors {
  const normalized = normalizeCustomThemeSettings(settings);
  const base = new THREE.Color(normalized.background);
  const cool = new THREE.Color(normalized.cool);
  const warm = new THREE.Color(normalized.warm);

  return {
    name: 'Custom',
    id: CUSTOM_THEME_ID,
    uBaseColor1: base.clone(),
    uBaseColor2: base.clone().lerp(new THREE.Color(0xffffff), 0.12),
    uCoolCore: cool.clone(),
    uCoolEdge: cool.clone().lerp(base, 0.35),
    uWarmCore: warm.clone(),
    uWarmEdge: warm.clone().lerp(base, 0.35),
    uRippleColor: new THREE.Color(normalized.accent),
    uGlowIntensity: normalized.glowIntensity,
    uRotationSpeed: normalized.rotationSpeed,
    uShowPlayerPanel: normalized.showPlayerPanel,
  };
}

export const themes: Record<string, ThemeColors> = {
  'nocturnal': {
    name: 'Nocturnal',
    id: 'nocturnal',
    uBaseColor1: new THREE.Color(0.01, 0.02, 0.04),
    uBaseColor2: new THREE.Color(0.03, 0.05, 0.09),
    uCoolCore: new THREE.Color(0.0, 0.3, 1.0),
    uCoolEdge: new THREE.Color(0.6, 0.2, 1.0),
    uWarmCore: new THREE.Color(1.0, 0.2, 0.1),
    uWarmEdge: new THREE.Color(1.0, 0.6, 0.0),
    uRippleColor: new THREE.Color(0.2, 0.9, 1.0),
    uGlowIntensity: 1.0,
    uRotationSpeed: 0.5,
    uShowPlayerPanel: true,
  },
  'neon-tokyo': {
    name: 'Neon Tokyo',
    id: 'neon-tokyo',
    uBaseColor1: new THREE.Color(0.01, 0.005, 0.02),
    uBaseColor2: new THREE.Color(0.04, 0.01, 0.06),
    uCoolCore: new THREE.Color(1.0, 0.1, 0.6), // Hot pink
    uCoolEdge: new THREE.Color(0.6, 0.1, 1.0), // Deep purple
    uWarmCore: new THREE.Color(0.1, 1.0, 0.8), // Mint cyan
    uWarmEdge: new THREE.Color(0.1, 0.4, 1.0), // Royal blue
    uRippleColor: new THREE.Color(1.0, 1.0, 1.0),
    uGlowIntensity: 1.5,
    uRotationSpeed: 0.5,
    uShowPlayerPanel: true,
  },
  'cyber-forest': {
    name: 'Cyber Forest',
    id: 'cyber-forest',
    uBaseColor1: new THREE.Color(0.01, 0.02, 0.01),
    uBaseColor2: new THREE.Color(0.02, 0.05, 0.02),
    uCoolCore: new THREE.Color(0.1, 1.0, 0.5), // Bright emerald
    uCoolEdge: new THREE.Color(0.05, 0.5, 0.3), // Dark green
    uWarmCore: new THREE.Color(0.8, 1.0, 0.1), // Lime yellow
    uWarmEdge: new THREE.Color(0.9, 0.5, 0.1), // Orange
    uRippleColor: new THREE.Color(0.6, 1.0, 0.3),
    uGlowIntensity: 1.3,
    uRotationSpeed: 0.5,
    uShowPlayerPanel: true,
  },
  'minimal-monochrome': {
    name: 'Minimal Monochrome',
    id: 'minimal-monochrome',
    uBaseColor1: new THREE.Color(0.02, 0.02, 0.02),
    uBaseColor2: new THREE.Color(0.06, 0.06, 0.06),
    uCoolCore: new THREE.Color(0.9, 0.9, 0.9), // Bright silver
    uCoolEdge: new THREE.Color(0.4, 0.4, 0.4), // Mid grey
    uWarmCore: new THREE.Color(1.0, 1.0, 1.0), // Pure white
    uWarmEdge: new THREE.Color(0.7, 0.7, 0.7), // Light grey
    uRippleColor: new THREE.Color(1.0, 1.0, 1.0),
    uGlowIntensity: 0.8,
    uRotationSpeed: 0.5,
    uShowPlayerPanel: true,
  }
};
