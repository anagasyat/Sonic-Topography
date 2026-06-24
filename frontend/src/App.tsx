import { Canvas } from '@react-three/fiber';
import { UI } from './components/UI/UI';
import { MapScene } from './components/AudioVisualizer/MapScene';
import { useEffect, useState } from 'react';
import { readGroundEqSettingsStorage, writeGroundEqSettingsStorage, type StoredGroundEqSettings } from './lib/groundEqSettings';
import {
  BUILT_IN_THEME_IDS,
  CUSTOM_THEME_ID,
  createCustomThemeColors,
  readActiveCustomThemeStorage,
  readActiveThemeStorage,
  readCustomThemeStorage,
  readThemeRotationStorage,
  themes,
  writeActiveCustomThemeStorage,
  writeActiveThemeStorage,
  writeCustomThemeStorage,
  writeThemeRotationStorage,
  type CustomThemeSettings,
  type ThemeRotationSettings,
  type ThemeColors, // 导入 ThemeColors 类型
} from './lib/themes';

function readInitialCustomThemeState() {
  const presets = readCustomThemeStorage();
  return {
    presets,
    activeId: readActiveCustomThemeStorage(presets),
  };
}

export default function App() {
  const [theme, setTheme] = useState(readActiveThemeStorage);
  const [groundEqSettings, setGroundEqSettings] = useState<StoredGroundEqSettings>(readGroundEqSettingsStorage);
  const [customThemeState, setCustomThemeState] = useState(readInitialCustomThemeState);
  const customThemes = customThemeState.presets;
  const activeCustomThemeId = customThemeState.activeId;
  const activeCustomTheme = customThemes.find((preset) => preset.id === activeCustomThemeId) || customThemes[0];
  const availableRotationThemeIds = [...BUILT_IN_THEME_IDS, ...customThemes.map((preset) => preset.id)];
  const [themeRotation, setThemeRotation] = useState<ThemeRotationSettings>(() => readThemeRotationStorage(availableRotationThemeIds));
  
  // 新增预览主题状态
  const [previewTheme, setPreviewTheme] = useState<ThemeColors | null>(null);

  // 计算基础主题
  const baseTheme = theme === CUSTOM_THEME_ID ? createCustomThemeColors(activeCustomTheme) : (themes[theme] || themes['nocturnal']);
  // 如果有预览则使用预览，否则使用基础主题
  const resolvedTheme = previewTheme || baseTheme;

  const sceneRotationSpeed = activeCustomTheme?.rotationSpeed ?? resolvedTheme.uRotationSpeed;
  const showPlayerPanel = activeCustomTheme?.showPlayerPanel ?? resolvedTheme.uShowPlayerPanel;

  const updateTheme = (themeId: string) => {
    setTheme(themeId);
    writeActiveThemeStorage(themeId);
  };

  const activateThemeId = (themeId: string) => {
    if (BUILT_IN_THEME_IDS.includes(themeId)) {
      updateTheme(themeId);
      return;
    }

    if (customThemes.some((preset) => preset.id === themeId)) {
      updateCustomThemes(customThemes, themeId);
      updateTheme(CUSTOM_THEME_ID);
    }
  };

  const updateCustomThemes = (settings: CustomThemeSettings[], activeId = activeCustomThemeId) => {
    setCustomThemeState({ presets: settings, activeId });
    writeCustomThemeStorage(settings);
    writeActiveCustomThemeStorage(activeId);
  };

  const updateThemeRotation = (settings: ThemeRotationSettings) => {
    setThemeRotation(settings);
    writeThemeRotationStorage(settings, availableRotationThemeIds);
  };

  const updateGroundEqSettings = (settings: StoredGroundEqSettings) => {
    setGroundEqSettings(settings);
    writeGroundEqSettingsStorage(settings);
  };

  useEffect(() => {
    const normalized = readThemeRotationStorage(availableRotationThemeIds);
    setThemeRotation((current) => {
      const nextThemeIds = current.themeIds.filter((id) => availableRotationThemeIds.includes(id));
      const next = { ...current, themeIds: nextThemeIds.length ? nextThemeIds : normalized.themeIds };
      writeThemeRotationStorage(next, availableRotationThemeIds);
      return next;
    });
  }, [customThemes.length]);

  useEffect(() => {
    if (!themeRotation.enabled || themeRotation.themeIds.length < 2) return;

    const timer = window.setInterval(() => {
      const currentThemeId = theme === CUSTOM_THEME_ID ? activeCustomThemeId : theme;
      const currentIndex = themeRotation.themeIds.indexOf(currentThemeId);
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % themeRotation.themeIds.length : 0;
      activateThemeId(themeRotation.themeIds[nextIndex]);
    }, themeRotation.intervalSeconds * 1000);

    return () => window.clearInterval(timer);
  }, [themeRotation, theme, activeCustomThemeId, customThemes]);

  // ===== 新增：Escape 键切换全屏 =====
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        try {
          await window.go.main.App.ToggleFullscreen();
        } catch (err) {
          console.error('ToggleFullscreen failed:', err);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  // Convert THREE.Color to css strings
  const bgDark = `#${resolvedTheme.uBaseColor1.getHexString()}`;

  return (
    <div className="relative w-screen h-screen overflow-hidden text-[#94a3b8] font-sans selection:bg-blue-500/30 transition-colors duration-1000" style={{ backgroundColor: bgDark }}>
      <UI
        theme={theme}
        resolvedTheme={resolvedTheme}
        customThemes={customThemes}
        activeCustomThemeId={activeCustomThemeId}
        themeRotation={themeRotation}
        groundEqSettings={groundEqSettings}
        showPlayerPanel={showPlayerPanel}
        onThemeChange={updateTheme}
        onCustomThemesChange={updateCustomThemes}
        onThemeRotationChange={updateThemeRotation}
        onGroundEqSettingsChange={updateGroundEqSettings}
        onPreviewTheme={setPreviewTheme}
      />
      <div className="absolute inset-0 z-0">
        <Canvas camera={{ position: [35, 25, 35], fov: 45 }}>
          <MapScene themeColors={resolvedTheme} groundEqSettings={groundEqSettings} rotationSpeed={sceneRotationSpeed} />
        </Canvas>
      </div>
    </div>
  );
}