import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Play, Pause, Volume2, SkipForward, SkipBack, Palette, Plus, ListMusic, Shuffle, Repeat, Trash2 } from 'lucide-react';
import { engine } from '../../lib/AudioEngine';
import { BUILT_IN_THEME_IDS, CUSTOM_THEME_ID, createCustomThemePreset, themes, type CustomThemeSettings, type ThemeColors, type ThemeRotationSettings, createCustomThemeColors } from '../../lib/themes';
import {
  GROUND_EQ_POINT_COUNT,
  defaultGroundEqCurve,
  readGroundEqCurveValue,
  type StoredGroundEqSettings,
} from '../../lib/groundEqSettings';
import { LyricsDisplay } from './LyricsDisplay';
import { extractLyricsFromAudio } from '../../lib/metadata';
import {
  createNeteaseCookieHeaders,
  readNeteaseCookieStorage,
  writeNeteaseCookieStorage,
} from '../../lib/neteaseCookie';
import {
  readTriggerSettingsStorage,
  writeTriggerSettingsStorage,
  type StoredTriggerConfig,
} from '../../lib/triggerSettings';
import {
  createPresetTransferPackage,
  normalizePresetTransferPackage,
  writePresetTransferPackage,
  type PresetTransferPackage,
} from '../../lib/presetTransfer';
import { createPortal } from 'react-dom';

interface UIProps {
  theme: string;
  resolvedTheme: ThemeColors;
  customThemes: CustomThemeSettings[];
  activeCustomThemeId: string;
  themeRotation: ThemeRotationSettings;
  groundEqSettings: StoredGroundEqSettings;
  showPlayerPanel: boolean;
  onThemeChange: (theme: string) => void;
  onCustomThemesChange: (settings: CustomThemeSettings[], activeId?: string) => void;
  onThemeRotationChange: (settings: ThemeRotationSettings) => void;
  onGroundEqSettingsChange: (settings: StoredGroundEqSettings) => void;
  onPreviewTheme?: (themeColors?: ThemeColors) => void;
}

interface NeteaseSong {
  id: number;
  name: string;
  artist: string;
  album: string;
  duration: number;
  fee: number;
}

interface SavedPlaylist {
  id: string;
  name: string;
  songs: NeteaseSong[];
}

interface NeteasePlaylistSummary {
  id: number;
  name: string;
  trackCount: number;
}

type PlayMode = 'sequence' | 'shuffle';
type OptionsTab = 'Pulse' | 'Meteor' | 'GroundEq' | 'Color' | 'Cookie' | 'API' | 'Preset';
type NeteaseCloudTab = 'liked' | 'playlists' | 'daily';
type PendingDelete =
  | { type: 'song'; playlistId: string; songId: number; label: string }
  | { type: 'playlist'; playlistId: string; label: string };

const PLAYLIST_STORAGE_KEY = 'sonic-topography-playlists-v1';
const SIDE_NAV_HINT_STORAGE_KEY = 'sonic-topography-side-nav-hint-seen-v1';
const API_BASE_URL_STORAGE_KEY = 'sonic-api-base-url';

declare global {
  interface ImportMetaEnv {
    PROD: any;
    readonly BASE_URL?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

const baseUrl = import.meta.env.BASE_URL || '/';

const menuStyles = `
  @keyframes menuSlideIn {
    0% { opacity: 0; transform: translateY(-12px) scale(0.96); }
    100% { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes ripple {
    0% { transform: scale(1); opacity: 0.6; }
    100% { transform: scale(2.5); opacity: 0; }
  }
  .menu-enter {
    animation: menuSlideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  .brand-ripple::after {
    content: '';
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0;
    pointer-events: none;
    animation: ripple 0.6s ease-out;
  }
`;

const globalStyles = `
  @keyframes fadeSlideUp {
    0% { opacity: 0; transform: translateY(20px) scale(0.96); }
    100% { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes glowPulse {
    0%, 100% { box-shadow: 0 0 20px var(--glow-color, rgba(255,255,255,0.1)); }
    50% { box-shadow: 0 0 40px var(--glow-color, rgba(255,255,255,0.2)); }
  }
  .scrollbar-hide::-webkit-scrollbar {
    display: none;
  }
  .scrollbar-hide {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
`;

function createDefaultPlaylists(): SavedPlaylist[] {
  return [
    { id: 'favorites', name: 'Favorites', songs: [] },
    { id: 'visual-set', name: 'Visual Set', songs: [] },
  ];
}

function readSavedPlaylists(): SavedPlaylist[] {
  try {
    const raw = window.localStorage.getItem(PLAYLIST_STORAGE_KEY);
    if (!raw) return createDefaultPlaylists();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return createDefaultPlaylists();
    return parsed.map((playlist: SavedPlaylist) => ({
      id: playlist.id,
      name: playlist.name,
      songs: Array.isArray(playlist.songs) ? playlist.songs : [],
    }));
  } catch (error) {
    console.warn('Unable to read saved playlists:', error);
    return createDefaultPlaylists();
  }
}

function hasSavedSongs(playlists: SavedPlaylist[]): boolean {
  return playlists.some((playlist) => playlist.songs.length > 0);
}

function applyStoredTriggerConfig(config: typeof engine.pulseTrigger, stored?: Partial<StoredTriggerConfig>) {
  if (!stored) return;
  if (typeof stored.enabled === 'boolean') config.enabled = stored.enabled;
  if (stored.mode === 'Auto Beat' || stored.mode === 'Advanced') config.mode = stored.mode;
  if (Number.isFinite(stored.freqIndex)) config.freqIndex = Number(stored.freqIndex);
  if (Number.isFinite(stored.threshold)) config.threshold = Number(stored.threshold);
  if (Number.isFinite(stored.sensitivity)) config.sensitivity = Number(stored.sensitivity);
  if (Number.isFinite(stored.cooldown)) config.cooldown = Number(stored.cooldown);
  if (Number.isFinite(stored.bandStart)) config.bandStart = Number(stored.bandStart);
  if (Number.isFinite(stored.bandEnd)) config.bandEnd = Number(stored.bandEnd);
  if (Number.isFinite(stored.pulseStrength)) config.pulseStrength = Number(stored.pulseStrength);
}

function snapshotTriggerConfig(config: typeof engine.pulseTrigger): StoredTriggerConfig {
  return {
    enabled: config.enabled,
    mode: config.mode,
    freqIndex: config.freqIndex,
    threshold: config.threshold,
    sensitivity: config.sensitivity,
    cooldown: config.cooldown,
    bandStart: config.bandStart,
    bandEnd: config.bandEnd,
    pulseStrength: config.pulseStrength,
  };
}

function loadStoredTriggerSettings() {
  const settings = readTriggerSettingsStorage();
  applyStoredTriggerConfig(engine.pulseTrigger, settings.Pulse);
  applyStoredTriggerConfig(engine.meteorTrigger, settings.Meteor);
}

loadStoredTriggerSettings();

export function UI({ theme, resolvedTheme, customThemes, activeCustomThemeId, themeRotation, groundEqSettings, showPlayerPanel, onThemeChange, onCustomThemesChange, onThemeRotationChange, onGroundEqSettingsChange, onPreviewTheme }: UIProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [trackName, setTrackName] = useState<string>('No track selected');
  const [lyricsText, setLyricsText] = useState<string>('');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [showOptionsPanel, setShowOptionsPanel] = useState(false);
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [showNeteasePanel, setShowNeteasePanel] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<NeteaseSong[]>([]);
  const [searchStatus, setSearchStatus] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [neteaseCloudTab, setNeteaseCloudTab] = useState<NeteaseCloudTab>('daily');
  const [neteaseCloudSongs, setNeteaseCloudSongs] = useState<NeteaseSong[]>([]);
  const [neteaseCloudPlaylists, setNeteaseCloudPlaylists] = useState<NeteasePlaylistSummary[]>([]);
  const [activeNeteasePlaylistId, setActiveNeteasePlaylistId] = useState<number | null>(null);
  const [neteaseCloudStatus, setNeteaseCloudStatus] = useState('');
  const [isLoadingNeteaseCloud, setIsLoadingNeteaseCloud] = useState(false);
  const [showPlaylistPanel, setShowPlaylistPanel] = useState(false);
  const [playlists, setPlaylists] = useState<SavedPlaylist[]>(readSavedPlaylists);
  const [activePlaylistId, setActivePlaylistId] = useState('favorites');
  const [songToAdd, setSongToAdd] = useState<NeteaseSong | null>(null);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [playMode, setPlayMode] = useState<PlayMode>('sequence');
  const [playQueue, setPlayQueue] = useState<NeteaseSong[]>([]);
  const [currentSongId, setCurrentSongId] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [neteaseCookie, setNeteaseCookie] = useState(readNeteaseCookieStorage);
  const [cookieStatus, setCookieStatus] = useState('');
  const [isNeteaseCookieValid, setIsNeteaseCookieValid] = useState(false);
  const [isSyncingNeteaseCookie, setIsSyncingNeteaseCookie] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [presetTransferStatus, setPresetTransferStatus] = useState('');
  const hasLoadedPlaylistsRef = useRef(false);

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLButtonElement>(null);

  // ---------- 沉浸式主题编辑模式 ----------
  const [isThemeEditorMode, setIsThemeEditorMode] = useState(false);
  const [editingThemeData, setEditingThemeData] = useState<CustomThemeSettings | null>(null);

  // ---------- API 地址配置 ----------
  const [apiBaseUrl, setApiBaseUrl] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(API_BASE_URL_STORAGE_KEY) || 'http://127.0.0.1:7200';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(API_BASE_URL_STORAGE_KEY, apiBaseUrl);
  }, [apiBaseUrl]);

  const getApiUrl = (path: string) => {
    if (apiBaseUrl) {
      const cleanPath = path.startsWith('/') ? path : `/${path}`;
      return `${apiBaseUrl}${cleanPath}`;
    }
    return path;
  };

  const enterThemeEditor = (preset?: CustomThemeSettings) => {
    if (preset) {
      setEditingThemeData({ ...preset });
    } else {
      // 新建：基于当前主题创建
      const basePreset = customThemes.find(p => p.id === activeCustomThemeId) || customThemes[0];
      const newPreset = createCustomThemePreset({
        ...basePreset,
        id: undefined,
        name: `自定义主题 ${customThemes.length + 1}`,
      });
      setEditingThemeData(newPreset);
    }
    setIsThemeEditorMode(true);
  };

  const exitThemeEditor = () => {
    setIsThemeEditorMode(false);
    setEditingThemeData(null);
  };

  const saveThemeFromEditor = (updatedPreset: CustomThemeSettings) => {
    const existing = customThemes.find(p => p.id === updatedPreset.id);
    let nextPresets;
    if (existing) {
      nextPresets = customThemes.map(p => p.id === updatedPreset.id ? updatedPreset : p);
    } else {
      nextPresets = [...customThemes, updatedPreset];
    }
    onCustomThemesChange(nextPresets, updatedPreset.id);
    onThemeChange(CUSTOM_THEME_ID);
    exitThemeEditor();
  };

  const closeFloatingPanels = () => {
    setShowOptionsPanel(false);
    setShowSearchPanel(false);
    setShowNeteasePanel(false);
    setShowPlaylistPanel(false);
    setIsMenuOpen(false);
  };

  const openOptionsPanel = () => {
    setShowSearchPanel(false);
    setShowNeteasePanel(false);
    setShowPlaylistPanel(false);
    setShowOptionsPanel(true);
  };

  const openSearchPanel = () => {
    setShowOptionsPanel(false);
    setShowNeteasePanel(false);
    setShowPlaylistPanel(false);
    setShowSearchPanel(true);
  };

  const openNeteasePanel = () => {
    setShowOptionsPanel(false);
    setShowSearchPanel(false);
    setShowPlaylistPanel(false);
    setShowNeteasePanel(true);
  };

  const openPlaylistPanel = () => {
    setShowOptionsPanel(false);
    setShowSearchPanel(false);
    setShowNeteasePanel(false);
    setShowPlaylistPanel(true);
  };

  useEffect(() => {
    if (!hasLoadedPlaylistsRef.current) return;
    window.localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(playlists));
  }, [playlists]);

  const syncNeteaseCookie = async (cookie: string, options: { silent?: boolean } = {}) => {
    const normalizedCookie = cookie.trim();
    if (normalizedCookie && !options.silent) {
      setCookieStatus('正在校验 Cookie...');
    }

    setIsSyncingNeteaseCookie(true);
    try {
      const response = await fetch(getApiUrl('/api/netease/cookie'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie }),
      });
      const data = await response.json();
      const valid = Boolean(data.valid);
      setIsNeteaseCookieValid(valid);
      if (!options.silent) {
        setCookieStatus(normalizedCookie ? (valid ? 'Cookie 可用，已开启网易云' : 'Cookie 已保存，但校验失败') : 'Cookie 已清除');
      }
      if (normalizedCookie && !valid) {
        fetch(getApiUrl('/api/netease/cookie'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookie: '' }),
        }).catch((error) => {
          console.warn('Unable to clear invalid Netease proxy cookie:', error);
        });
      }
      return valid;
    } catch (error) {
      console.warn('Unable to sync Netease cookie:', error);
      if (!options.silent) {
        setIsNeteaseCookieValid(false);
      }
      if (!options.silent) {
        setCookieStatus('已保存到浏览器，但同步到本地代理失败');
      }
      return options.silent && isNeteaseCookieValid;
    } finally {
      setIsSyncingNeteaseCookie(false);
    }
  };

  useEffect(() => {
    const savedCookie = readNeteaseCookieStorage();
    if (savedCookie) {
      setNeteaseCookie(savedCookie);
      syncNeteaseCookie(savedCookie);
    }
  }, []);

  const saveNeteaseCookie = () => {
    writeNeteaseCookieStorage(neteaseCookie);
    const normalizedCookie = readNeteaseCookieStorage();
    setNeteaseCookie(normalizedCookie);
    syncNeteaseCookie(normalizedCookie);
  };

  const clearNeteaseCookie = () => {
    writeNeteaseCookieStorage('');
    setNeteaseCookie('');
    setIsNeteaseCookieValid(false);
    syncNeteaseCookie('');
  };

  const applyPresetTransferPackage = async (presetPackage: PresetTransferPackage) => {
    const normalized = writePresetTransferPackage(presetPackage);
    const data = normalized.data;

    applyStoredTriggerConfig(engine.pulseTrigger, data.triggerSettings.Pulse);
    applyStoredTriggerConfig(engine.meteorTrigger, data.triggerSettings.Meteor);
    onCustomThemesChange(data.customThemes, data.activeCustomThemeId);
    onThemeRotationChange(data.themeRotation);
    onGroundEqSettingsChange(data.groundEqSettings);
    onThemeChange(data.activeThemeId);

    setPlaylists(data.playlists);
    setActivePlaylistId(data.playlists[0]?.id || 'favorites');

    const importedCookie = data.neteaseCookie || '';
    setNeteaseCookie(importedCookie);
    if (importedCookie) {
      await syncNeteaseCookie(importedCookie);
    } else {
      setIsNeteaseCookieValid(false);
      await syncNeteaseCookie('', { silent: true });
    }

    setPresetTransferStatus('预设已导入，当前页面已更新');
  };

  const ensureNeteaseCookieReady = async () => {
    const savedCookie = readNeteaseCookieStorage();
    if (!savedCookie.trim()) {
      setIsNeteaseCookieValid(false);
      setNeteaseCloudStatus('请先在设置里保存可用的网易云 Cookie');
      openOptionsPanel();
      return '';
    }

    setNeteaseCookie(savedCookie);
    const valid = await syncNeteaseCookie(savedCookie, { silent: isNeteaseCookieValid });
    if (!valid) {
      setNeteaseCloudStatus('Cookie 需要重新保存');
      openOptionsPanel();
      return '';
    }

    return savedCookie;
  };

  const fetchNeteaseSongs = async (url: string, emptyMessage: string) => {
    const readyCookie = await ensureNeteaseCookieReady();
    if (!readyCookie) return;

    setIsLoadingNeteaseCloud(true);
    setNeteaseCloudStatus('正在加载...');

    try {
      const response = await fetch(getApiUrl(url), {
        headers: createNeteaseCookieHeaders(readyCookie),
      });
      const data = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          setIsNeteaseCookieValid(false);
          setNeteaseCloudStatus('网易云 Cookie 失效了，请重新保存');
          openOptionsPanel();
        } else {
          setNeteaseCloudStatus('网易云接口临时失败，请稍后再试');
        }
        return;
      }

      const songs = Array.isArray(data.songs) ? data.songs : [];
      if (songs.length === 0) {
        setNeteaseCloudSongs([]);
        setNeteaseCloudStatus(emptyMessage);
        return;
      }

      setNeteaseCloudSongs(songs);
      setNeteaseCloudStatus('');
    } catch (error) {
      console.warn('Unable to load Netease cloud songs:', error);
      setNeteaseCloudStatus('加载失败，请稍后再试');
    } finally {
      setIsLoadingNeteaseCloud(false);
    }
  };

  const loadDailyRecommendations = async () => {
    setNeteaseCloudTab('daily');
    setActiveNeteasePlaylistId(null);
    await fetchNeteaseSongs('/api/netease/daily-recommend?limit=50', '每日推荐里暂时没有可播放歌曲');
  };

  const loadLikedSongs = async () => {
    setNeteaseCloudTab('liked');
    setActiveNeteasePlaylistId(null);
    await fetchNeteaseSongs('/api/netease/liked?limit=50', '喜欢列表里暂时没有可播放歌曲');
  };

  const loadNeteasePlaylists = async () => {
    setNeteaseCloudTab('playlists');
    setNeteaseCloudSongs([]);
    setActiveNeteasePlaylistId(null);
    const readyCookie = await ensureNeteaseCookieReady();
    if (!readyCookie) return;

    setIsLoadingNeteaseCloud(true);
    setNeteaseCloudStatus('正在加载歌单...');

    try {
      const response = await fetch(getApiUrl('/api/netease/playlists'), {
        headers: createNeteaseCookieHeaders(readyCookie),
      });
      const data = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          setIsNeteaseCookieValid(false);
          setNeteaseCloudStatus('网易云 Cookie 失效了，请重新保存');
          openOptionsPanel();
        } else {
          setNeteaseCloudStatus('网易云接口临时失败，请稍后再试');
        }
        return;
      }

      const cloudPlaylists = Array.isArray(data.playlists) ? data.playlists : [];
      setNeteaseCloudPlaylists(cloudPlaylists);
      setNeteaseCloudStatus(cloudPlaylists.length ? '请选择一个歌单' : '没有找到网易云歌单');
    } catch (error) {
      console.warn('Unable to load Netease playlists:', error);
      setNeteaseCloudStatus('歌单加载失败，请稍后再试');
    } finally {
      setIsLoadingNeteaseCloud(false);
    }
  };

  const loadNeteasePlaylistSongs = async (playlist: NeteasePlaylistSummary) => {
    setActiveNeteasePlaylistId(playlist.id);
    await fetchNeteaseSongs(`/api/netease/playlist?id=${playlist.id}&limit=50`, '这个歌单里暂时没有可播放歌曲');
  };

  useEffect(() => {
    // 直接从 localStorage 读取歌单
    const browserPlaylists = readSavedPlaylists();
    setPlaylists(browserPlaylists);
    hasLoadedPlaylistsRef.current = true;
  }, []);

  // Audio state poller
  useEffect(() => {
    const initEngine = async () => {
      await engine.init();
    };
    initEngine();

    let animationFrameId: number;
    const poll = () => {
      setIsPlaying(engine.isPlaying);
      setCurrentTime(engine.audioElement.currentTime);
      setDuration(engine.audioElement.duration || 0);
      setVolume(engine.audioElement.volume);
      setIsCapturing(engine.isCapturing);
      animationFrameId = requestAnimationFrame(poll);
    };
    poll();

    return () => cancelAnimationFrame(animationFrameId);
  }, []);

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    syncFullscreenState();
    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch (error) {
      console.warn('Unable to toggle fullscreen:', error);
    } finally {
    }
  };

  const processFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    let audioFile: File | null = null;
    let lrcFile: File | null = null;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('audio/') || file.name.endsWith('.mp3') || file.name.endsWith('.wav') || file.name.endsWith('.flac')) {
        audioFile = file;
      } else if (file.name.endsWith('.lrc')) {
        lrcFile = file;
      }
    }

    if (lrcFile) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        setLyricsText(text);
      };
      reader.readAsText(lrcFile);
    } else if (audioFile) {
      setLyricsText('');
      const extractedLyrics = await extractLyricsFromAudio(audioFile);
      if (extractedLyrics) {
        setLyricsText(extractedLyrics);
      }
    } else {
      setLyricsText('');
    }

    if (audioFile) {
      setTrackName(audioFile.name);
      engine.init();
      engine.loadFile(audioFile);
      engine.play();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    processFiles(e.target.files);
    e.target.value = '';
  };

  const togglePlay = () => {
    engine.init();
    engine.togglePlay();
  };

  const searchNetease = async () => {
    const keywords = searchQuery.trim();
    if (!keywords) return;
    const requestCookie = isNeteaseCookieValid ? neteaseCookie : '';

    setIsSearching(true);
    setSearchStatus('正在搜索可播放歌曲...');
    setSearchResults([]);

    try {
      const searchUrl = requestCookie
        ? `/api/netease/search?keywords=${encodeURIComponent(keywords)}&limit=30`
        : `/api/netease/search?keywords=${encodeURIComponent(keywords)}`;
      const response = await fetch(getApiUrl(searchUrl), {
        headers: createNeteaseCookieHeaders(requestCookie),
      });
      if (!response.ok) throw new Error('Search request failed');

      const data = await response.json();
      const songs = Array.isArray(data.songs) ? data.songs : [];
      const rawCount = Number(data.rawCount || 0);
      setSearchResults(songs);
      setSearchStatus(songs.length ? '' : (rawCount > 0
        ? (requestCookie
          ? `搜到 ${rawCount} 首，但当前账号没有可播放版本，可能受版权、会员或地区限制。`
          : `搜到 ${rawCount} 首，但未登录只能显示可播放歌曲；保存网易云 Cookie 后可能会显示更多。`)
        : '没有搜到歌曲，请换个关键词试试。'));
    } catch (error) {
      console.warn('Netease search failed:', error);
      setSearchStatus('搜索失败，请稍后再试');
    } finally {
      setIsSearching(false);
    }
  };

  const loadNeteaseSong = async (song: NeteaseSong, queue?: NeteaseSong[]) => {
    if (queue) setPlayQueue(queue);
    setCurrentSongId(song.id);
    setTrackName(`${song.artist ? `${song.artist} - ` : ''}${song.name}`);
    setLyricsText('');
    setSearchStatus('正在加载歌曲...');
    const requestCookie = isNeteaseCookieValid ? neteaseCookie : '';

    try {
      const [urlResponse, lyricResponse] = await Promise.all([
        fetch(getApiUrl(`/api/netease/url?id=${song.id}`), {
          headers: createNeteaseCookieHeaders(requestCookie),
        }),
        fetch(getApiUrl(`/api/netease/lyric?id=${song.id}`), {
          headers: createNeteaseCookieHeaders(requestCookie),
        }),
      ]);

      const urlData = await urlResponse.json();
      const lyricData = await lyricResponse.json();
      const lyric = lyricData.lyric || lyricData.translatedLyric || '';
      setLyricsText(lyric);

      if (!urlData.url) {
        setSearchStatus('这首歌可能需要 Cookie、会员或地区权限，正在尝试下一首...');
        playFromQueue(1, song.id);
        return;
      }

      engine.init();
      engine.loadUrl(getApiUrl(`/api/netease/audio?id=${song.id}`));
      engine.play();
      setSearchStatus('');
      setShowSearchPanel(false);
    } catch (error) {
      console.warn('Unable to load Netease song:', error);
      setSearchStatus('加载失败，正在尝试下一首...');
      playFromQueue(1, song.id);
    }
  };

  const getCurrentQueue = () => playQueue.length > 0 ? playQueue : activePlaylist?.songs || [];

  const playFromQueue = (direction: 1 | -1, fromSongId = currentSongId) => {
    const queue = getCurrentQueue();
    if (queue.length === 0) return;

    let nextIndex = 0;
    const currentIndex = queue.findIndex((song) => song.id === fromSongId);

    if (playMode === 'shuffle' && queue.length > 1) {
      do {
        nextIndex = Math.floor(Math.random() * queue.length);
      } while (nextIndex === currentIndex);
    } else {
      const baseIndex = currentIndex >= 0 ? currentIndex : 0;
      nextIndex = (baseIndex + direction + queue.length) % queue.length;
    }

    loadNeteaseSong(queue[nextIndex], queue);
  };

  useEffect(() => {
    const handleEnded = () => {
      const queue = getCurrentQueue();
      if (queue.length > 1) playFromQueue(1);
    };

    engine.audioElement.addEventListener('ended', handleEnded);
    return () => engine.audioElement.removeEventListener('ended', handleEnded);
  }, [playQueue, currentSongId, playMode, activePlaylistId, playlists]);

  const addSongToPlaylist = (playlistId: string, song: NeteaseSong) => {
    setPlaylists((current) => current.map((playlist) => {
      if (playlist.id !== playlistId) return playlist;
      const exists = playlist.songs.some((savedSong) => savedSong.id === song.id);
      if (exists) return playlist;
      return { ...playlist, songs: [...playlist.songs, song] };
    }));
    const playlistName = playlists.find((playlist) => playlist.id === playlistId)?.name || 'playlist';
    setSearchStatus(`已加入 ${playlistName}`);
    setSongToAdd(null);
  };

  const addSongToFavorites = (song: NeteaseSong) => {
    setPlaylists((current) => current.map((playlist) => {
      if (playlist.id !== 'favorites') return playlist;
      const exists = playlist.songs.some((savedSong) => savedSong.id === song.id);
      if (exists) return playlist;
      return { ...playlist, songs: [...playlist.songs, song] };
    }));
    setSearchStatus('已加入喜欢');
    setNeteaseCloudStatus('已加入喜欢');
  };

  const createPlaylistAndAddSong = () => {
    const name = newPlaylistName.trim();
    if (!name || !songToAdd) return;

    const id = `playlist-${Date.now()}`;
    setPlaylists((current) => [...current, { id, name, songs: [songToAdd] }]);
    setActivePlaylistId(id);
    setSearchStatus(`已加入 ${name}`);
    setSongToAdd(null);
    setNewPlaylistName('');
  };

  const deleteSongFromPlaylist = (playlistId: string, songId: number) => {
    setPlaylists((current) => current.map((playlist) => {
      if (playlist.id !== playlistId) return playlist;
      return { ...playlist, songs: playlist.songs.filter((song) => song.id !== songId) };
    }));

    setPlayQueue((queue) => queue.filter((song) => song.id !== songId));
    if (currentSongId === songId) {
      setCurrentSongId(null);
    }
  };

  const deletePlaylist = (playlistId: string) => {
    if (playlists.length <= 1) return;

    const nextPlaylists = playlists.filter((playlist) => playlist.id !== playlistId);
    setPlaylists(nextPlaylists);

    if (activePlaylistId === playlistId) {
      setActivePlaylistId(nextPlaylists[0]?.id || 'favorites');
    }

    const deletedPlaylist = playlists.find((playlist) => playlist.id === playlistId);
    if (deletedPlaylist?.songs.some((song) => song.id === currentSongId)) {
      setPlayQueue([]);
      setCurrentSongId(null);
    }
  };

  const confirmPendingDelete = () => {
    if (!pendingDelete) return;

    if (pendingDelete.type === 'song') {
      deleteSongFromPlaylist(pendingDelete.playlistId, pendingDelete.songId);
    } else {
      deletePlaylist(pendingDelete.playlistId);
    }

    setPendingDelete(null);
  };

  useEffect(() => {
    if (isThemeEditorMode && editingThemeData) {
      const previewColors = createCustomThemeColors(editingThemeData);
      onPreviewTheme?.(previewColors);
    } else {
      onPreviewTheme?.(undefined);
    }
  }, [isThemeEditorMode, editingThemeData, onPreviewTheme]);

  const activePlaylist = playlists.find((playlist) => playlist.id === activePlaylistId) || playlists[0];

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        engine.init();
        engine.togglePlay();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const formatTime = (time: number) => {
    if (isNaN(time)) return "0:00";
    const min = Math.floor(time / 60);
    const sec = Math.floor(time % 60);
    return `${min}:${sec.toString().padStart(2, '0')}`;
  };

  // Drag and drop global listeners
  useEffect(() => {
    const handleDragOverGlobal = (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(true);
    };
    const handleDragLeaveGlobal = (e: DragEvent) => {
      e.preventDefault();
      if (e.clientX === 0 || e.clientY === 0) {
        setIsDragging(false);
      }
    };
    const handleDropGlobal = (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      processFiles(e.dataTransfer?.files || null);
    };

    window.addEventListener('dragover', handleDragOverGlobal);
    window.addEventListener('dragleave', handleDragLeaveGlobal);
    window.addEventListener('drop', handleDropGlobal);

    return () => {
      window.removeEventListener('dragover', handleDragOverGlobal);
      window.removeEventListener('dragleave', handleDragLeaveGlobal);
      window.removeEventListener('drop', handleDropGlobal);
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        isMenuOpen &&
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        brandRef.current &&
        !brandRef.current.contains(event.target as Node)
      ) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isMenuOpen]);

  const accentHex = `#${resolvedTheme.uRippleColor.getHexString()}`;

  // 检测是否运行在 Wails 环境
  const isWails = typeof window !== 'undefined' && !!(window as any).runtime;

  return (
    <div
      className="absolute inset-0 pointer-events-none z-10 flex w-full h-full"
      style={{ fontFamily: "'Helvetica Neue', Arial, sans-serif", color: '#94a3b8' }}
    >
      <style>{menuStyles}</style>
      <style>{globalStyles}</style>

      {/* ============================================================ */}
      {/* 非编辑模式下显示的 UI */}
      {/* ============================================================ */}
      {!isThemeEditorMode && (
        <>
          {/* ===== 拖放遮罩 ===== */}
          {isDragging && (
            <div
              className="absolute inset-0 z-[60] backdrop-blur-sm border-2 border-dashed m-4 rounded-xl flex items-center justify-center font-mono text-2xl tracking-widest pointer-events-none"
              style={{ backgroundColor: `${accentHex}1a`, borderColor: accentHex, color: accentHex }}
            >
              DROP AUDIO FILE TO PLAY
            </div>
          )}

          {/* ===== 品牌名 ===== */}
          <button
            ref={brandRef}
            type="button"
            className={`brand-mark absolute top-[38px] left-[56px] font-black text-[24px] leading-[40px] tracking-[-1px] text-white z-50 select-none pointer-events-auto cursor-pointer transition-all duration-300 hover:opacity-80 ${isMenuOpen ? 'scale-90 -translate-y-2' : ''
              }`}
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            style={{ color: isMenuOpen ? accentHex : undefined }}
          >
            YANN. & AJIN.
          </button>

          {/* ===== 隐藏的文件输入框 ===== */}
          <input
            type="file"
            ref={fileInputRef}
            accept="audio/*,.lrc"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />

          {/* ===== 菜单 ===== */}
          {isMenuOpen && (
            <div
              ref={menuRef}
              className={`absolute top-[80px] left-[56px] z-[60] pointer-events-auto backdrop-blur-[24px] border border-white/15 rounded-lg p-6 min-w-[180px] transition-all duration-300 ease-out ${isMenuOpen
                ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto'
                : 'opacity-0 -translate-y-3 scale-95 pointer-events-none'
                }`}
              style={{
                background: 'linear-gradient(145deg, rgba(10,15,25,0.85), rgba(2,4,10,0.92))',
                boxShadow: `0 20px 60px rgba(0,0,0,0.6), 0 0 40px ${accentHex}22, inset 0 1px 0 rgba(255,255,255,0.08)`,
                borderColor: `${accentHex}33`,
              }}
            >
              <div className="flex flex-col gap-3">
                {/* 第一组：设置、搜索、网易云、歌单 */}
                <div className="flex flex-col gap-1.5 border-b border-white/5 pb-3 relative">
                  <div className="absolute bottom-0 left-1/4 right-1/4 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
                  <MenuButton onClick={() => { closeFloatingPanels(); openOptionsPanel(); }} accentHex={accentHex}>
                    设置
                  </MenuButton>
                  <MenuButton onClick={() => { closeFloatingPanels(); openSearchPanel(); }} accentHex={accentHex}>
                    搜索
                  </MenuButton>
                  {isNeteaseCookieValid && (
                    <MenuButton onClick={() => { closeFloatingPanels(); openNeteasePanel(); loadDailyRecommendations(); }} accentHex={accentHex}>
                      网易云
                    </MenuButton>
                  )}
                  <MenuButton onClick={() => { closeFloatingPanels(); openPlaylistPanel(); }} accentHex={accentHex}>
                    歌单
                  </MenuButton>
                </div>

                {/* 第二组：上传、捕获音频 */}
                <div className="flex flex-col gap-1.5 border-b border-white/5 pb-3 relative">
                  <div className="absolute bottom-0 left-1/4 right-1/4 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
                  <MenuButton onClick={() => { fileInputRef.current?.click(); setIsMenuOpen(false); }} accentHex={accentHex}>
                    上传
                  </MenuButton>
                  <MenuButton onClick={() => {
                    if (engine.isCapturing) {
                      engine.stopCapture();
                      setTrackName('No track selected');
                      setLyricsText('');
                    } else {
                      setLyricsText('');
                      engine.startCapture().then(() => {
                        if (engine.isCapturing) setTrackName('System Audio Capture');
                      });
                    }
                    setIsMenuOpen(false);
                  }} accentHex={accentHex}>
                    {isCapturing ? '停止捕获' : '捕获音频'}
                  </MenuButton>
                </div>

                {/* 第三组：全屏按钮（Wails 环境下隐藏） */}
                {!isWails && (
                  <div className="flex flex-col gap-1.5">
                    <MenuButton onClick={() => { toggleFullscreen(); setIsMenuOpen(false); }} accentHex={accentHex}>
                      {isFullscreen ? '退出全屏' : '全屏'}
                    </MenuButton>
                  </div>
                )}

                {/* 底部装饰光晕 */}
                <div
                  className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-3/4 h-6 rounded-full blur-2xl"
                  style={{ background: `radial-gradient(ellipse, ${accentHex}33, transparent 70%)` }}
                />
              </div>
            </div>
          )}

          {/* ===== 搜索面板 ===== */}
          {showSearchPanel && (
            <div
              className="absolute top-[40px] left-[100px] w-[440px] max-h-[75vh] z-50 pointer-events-auto rounded-2xl border border-white/15 shadow-2xl overflow-hidden"
              style={{
                background: 'linear-gradient(160deg, rgba(10,15,30,0.92), rgba(2,4,12,0.96))',
                boxShadow: `0 30px 80px rgba(0,0,0,0.7), 0 0 60px ${accentHex}22, inset 0 1px 0 rgba(255,255,255,0.06)`,
                borderColor: `${accentHex}44`,
                animation: 'fadeSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            >
              {/* 头部 */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
                <div className="flex items-center gap-3">
                  <span className="text-[14px] font-medium text-white/90 tracking-wide">搜索音乐</span>
                  <span className="text-[10px] text-white/30">· 网易云</span>
                  {isSearching && (
                    <span className="text-[10px] text-white/40 animate-pulse">加载中...</span>
                  )}
                </div>
                <button
                  onClick={() => setShowSearchPanel(false)}
                  className="text-white/40 hover:text-white transition-colors text-[10px] uppercase tracking-[0.15em] px-3 py-1.5 rounded-full border border-white/10 hover:border-white/30"
                >
                  关闭
                </button>
              </div>

              {/* 搜索框 */}
              <div className="px-5 py-4">
                <form className="flex gap-3" onSubmit={(e) => { e.preventDefault(); searchNetease(); }}>
                  <div className="flex-1 relative">
                    <input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="输入歌曲或歌手名称..."
                      className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-[13px] text-white outline-none focus:border-white/30 transition-colors placeholder:text-white/25"
                    />
                    <div
                      className="absolute -bottom-px left-1/2 -translate-x-1/2 w-0 h-px transition-all duration-300"
                      style={{ background: `linear-gradient(90deg, transparent, ${accentHex}, transparent)` }}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isSearching}
                    className="px-5 py-2.5 rounded-xl text-[11px] uppercase tracking-[0.15em] text-black font-medium transition-all hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100"
                    style={{ backgroundColor: accentHex }}
                  >
                    {isSearching ? '...' : '搜索'}
                  </button>
                </form>
                {searchStatus && (
                  <div className="mt-3 text-[12px] text-white/45 bg-white/5 rounded-lg px-4 py-2.5 border border-white/5 leading-relaxed">
                    {searchStatus}
                  </div>
                )}
              </div>

              {/* 搜索结果列表 */}
              <div className="max-h-[48vh] overflow-y-auto scrollbar-hide border-t border-white/5">
                {searchResults.length > 0 ? (
                  searchResults.map((song) => (
                    <button
                      key={song.id}
                      onClick={() => loadNeteaseSong(song, searchResults)}
                      className="relative w-full text-left px-5 py-4 pr-16 hover:bg-white/5 transition-colors border-b border-white/5 last:border-0 group"
                    >
                      <div className="flex items-start gap-3">
                        <div className="shrink-0 w-6 text-center text-[11px] text-white/25 font-mono mt-0.5">
                          {currentSongId === song.id ? (
                            <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: accentHex }} />
                          ) : (
                            <span>{(searchResults.indexOf(song) + 1).toString().padStart(2, '0')}</span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className={`text-[13px] truncate ${currentSongId === song.id ? 'text-white' : 'text-white/80'}`}>
                            {song.name}
                          </div>
                          <div className="mt-1 text-[11px] text-white/40 truncate">
                            {song.artist || '未知歌手'} · {song.album || '未知专辑'}
                          </div>
                        </div>
                      </div>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); setSongToAdd(song); }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            setSongToAdd(song);
                          }
                        }}
                        className="absolute right-4 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full border border-white/10 text-white/40 hover:text-black hover:border-transparent transition-all hover:scale-110 flex items-center justify-center group-hover:border-white/20"
                        title="添加到歌单"
                      >
                        <Plus size={15} />
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-5 py-16 text-center">
                    <div className="text-[13px] text-white/30">
                      {isSearching ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: accentHex }} />
                          搜索中...
                        </span>
                      ) : (
                        '输入关键词开始搜索'
                      )}
                    </div>
                    <div className="mt-2 text-[10px] text-white/15">支持歌曲名、歌手名搜索</div>
                  </div>
                )}
              </div>

              {/* 底部装饰光晕 */}
              <div
                className="absolute -bottom-6 left-1/2 -translate-x-1/2 w-2/3 h-12 rounded-full blur-3xl pointer-events-none"
                style={{ background: `radial-gradient(ellipse, ${accentHex}33, transparent 70%)` }}
              />
            </div>
          )}

          {/* ===== 添加到歌单弹窗 ===== */}
          {songToAdd && (
            <div
              className="fixed inset-0 z-[70] flex items-center justify-center pointer-events-auto"
              style={{
                background: 'rgba(0,0,0,0.6)',
                backdropFilter: 'blur(8px)',
                animation: 'fadeIn 0.25s ease-out',
              }}
            >
              <div
                className="w-[340px] max-h-[80vh] overflow-y-auto scrollbar-hide rounded-2xl border border-white/15 shadow-2xl"
                style={{
                  background: 'linear-gradient(160deg, rgba(12,18,34,0.96), rgba(4,6,14,0.98))',
                  boxShadow: `0 40px 100px rgba(0,0,0,0.85), 0 0 60px ${accentHex}22, inset 0 1px 0 rgba(255,255,255,0.06)`,
                  borderColor: `${accentHex}44`,
                  animation: 'scaleIn 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
                }}
              >
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-white/40">添加到歌单</div>
                    <div className="text-[14px] text-white/90 truncate mt-1">{songToAdd.name}</div>
                    <div className="text-[11px] text-white/35 truncate">{songToAdd.artist || '未知歌手'}</div>
                  </div>
                  <button
                    onClick={() => setSongToAdd(null)}
                    className="shrink-0 text-white/40 hover:text-white transition-colors text-[18px] leading-none w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/5"
                  >
                    ✕
                  </button>
                </div>
                <div className="p-2">
                  {playlists.map((playlist) => (
                    <button
                      key={playlist.id}
                      onClick={() => { addSongToPlaylist(playlist.id, songToAdd); setSongToAdd(null); }}
                      className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl hover:bg-white/5 transition-colors group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
                          <ListMusic size={14} className="text-white/30" />
                        </div>
                        <span className="min-w-0 text-[13px] text-white/80 truncate group-hover:text-white transition-colors">
                          {playlist.name}
                        </span>
                      </div>
                      <span className="shrink-0 text-[11px] text-white/25">{playlist.songs.length}</span>
                    </button>
                  ))}
                </div>
                <div className="px-4 pb-4 pt-2 border-t border-white/5">
                  <form className="flex gap-2" onSubmit={(e) => {
                    e.preventDefault();
                    createPlaylistAndAddSong();
                    setSongToAdd(null);
                  }}>
                    <div className="flex-1 relative">
                      <input
                        value={newPlaylistName}
                        onChange={(e) => setNewPlaylistName(e.target.value)}
                        placeholder="新建歌单名称..."
                        className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-[13px] text-white outline-none focus:border-white/30 transition-colors placeholder:text-white/20"
                        autoFocus
                      />
                      <div
                        className="absolute -bottom-px left-1/2 -translate-x-1/2 w-0 h-px transition-all duration-300"
                        style={{ background: `linear-gradient(90deg, transparent, ${accentHex}, transparent)` }}
                      />
                    </div>
                    <button
                      type="submit"
                      className="shrink-0 w-10 h-10 rounded-xl text-black flex items-center justify-center transition-all hover:scale-105 active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
                      style={{ backgroundColor: accentHex }}
                      disabled={!newPlaylistName.trim()}
                      title="创建歌单"
                    >
                      <Plus size={18} />
                    </button>
                  </form>
                </div>
                <div
                  className="absolute -bottom-6 left-1/2 -translate-x-1/2 w-2/3 h-12 rounded-full blur-3xl pointer-events-none"
                  style={{ background: `radial-gradient(ellipse, ${accentHex}33, transparent 70%)` }}
                />
              </div>
            </div>
          )}

          {/* ===== 歌单面板 ===== */}
          {showPlaylistPanel && (
            <div
              className="absolute top-[40px] left-[100px] w-[480px] max-h-[75vh] z-[65] pointer-events-auto rounded-2xl border border-white/15 shadow-2xl overflow-hidden"
              style={{
                background: 'linear-gradient(160deg, rgba(10,15,30,0.92), rgba(2,4,12,0.96))',
                boxShadow: `0 30px 80px rgba(0,0,0,0.7), 0 0 60px ${accentHex}22, inset 0 1px 0 rgba(255,255,255,0.06)`,
                borderColor: `${accentHex}44`,
                animation: 'fadeSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
                <div className="flex items-center gap-3">
                  <ListMusic size={16} className="text-white/50" />
                  <span className="text-[14px] font-medium text-white/90 tracking-wide">我的歌单</span>
                  <span className="text-[10px] text-white/30">· {playlists.length} 个</span>
                </div>
                <button
                  onClick={() => setShowPlaylistPanel(false)}
                  className="text-white/40 hover:text-white transition-colors text-[10px] uppercase tracking-[0.15em] px-3 py-1.5 rounded-full border border-white/10 hover:border-white/30"
                >
                  关闭
                </button>
              </div>
              <div className="px-5 py-3 border-b border-white/5">
                <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide">
                  {playlists.map((playlist) => (
                    <button
                      key={playlist.id}
                      onClick={() => setActivePlaylistId(playlist.id)}
                      className={`shrink-0 px-4 py-1.5 rounded-full border text-[11px] uppercase tracking-[0.12em] transition-all ${activePlaylist?.id === playlist.id
                        ? 'text-black border-transparent shadow-lg'
                        : 'border-white/10 text-white/45 hover:text-white hover:bg-white/5'
                        }`}
                      style={{
                        backgroundColor: activePlaylist?.id === playlist.id ? accentHex : 'transparent',
                        boxShadow: activePlaylist?.id === playlist.id ? `0 4px 16px ${accentHex}66` : 'none',
                      }}
                    >
                      {playlist.name}
                      <span className="ml-1.5 text-[9px] opacity-60">{playlist.songs.length}</span>
                    </button>
                  ))}
                  <button
                    onClick={() => activePlaylist && setPendingDelete({ type: 'playlist', playlistId: activePlaylist.id, label: activePlaylist.name })}
                    disabled={!activePlaylist || playlists.length <= 1}
                    className="shrink-0 w-8 h-8 rounded-full border border-white/10 text-white/40 hover:text-[#ef4444] disabled:opacity-20 disabled:hover:text-white/40 flex items-center justify-center transition-colors"
                    title="删除歌单"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="max-h-[48vh] overflow-y-auto scrollbar-hide">
                {activePlaylist && activePlaylist.songs.length > 0 ? (
                  activePlaylist.songs.map((song) => (
                    <button
                      key={song.id}
                      onClick={() => loadNeteaseSong(song, activePlaylist.songs)}
                      className="relative w-full text-left px-5 py-4 pr-16 hover:bg-white/5 transition-colors border-b border-white/5 last:border-0 group"
                    >
                      <div className="flex items-start gap-3">
                        <div className="shrink-0 w-6 text-center text-[11px] text-white/25 font-mono mt-0.5">
                          {currentSongId === song.id ? (
                            <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: accentHex }} />
                          ) : (
                            <span>{(activePlaylist.songs.indexOf(song) + 1).toString().padStart(2, '0')}</span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className={`text-[13px] truncate ${currentSongId === song.id ? 'text-white' : 'text-white/80'}`}>
                            {song.name}
                          </div>
                          <div className="mt-1 text-[11px] text-white/40 truncate">
                            {song.artist || '未知歌手'} · {song.album || '未知专辑'}
                          </div>
                        </div>
                      </div>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDelete({ type: 'song', playlistId: activePlaylist.id, songId: song.id, label: song.name });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            setPendingDelete({ type: 'song', playlistId: activePlaylist.id, songId: song.id, label: song.name });
                          }
                        }}
                        className="absolute right-4 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full border border-white/10 text-white/30 hover:text-[#ef4444] hover:border-[#ef4444]/30 transition-all hover:scale-110 flex items-center justify-center"
                        title="移除歌曲"
                      >
                        <Trash2 size={14} />
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-5 py-16 text-center">
                    <div className="text-[13px] text-white/30">这个歌单还是空的</div>
                    <div className="mt-2 text-[10px] text-white/15">从搜索结果中添加歌曲</div>
                  </div>
                )}
              </div>
              <div
                className="absolute -bottom-6 left-1/2 -translate-x-1/2 w-2/3 h-12 rounded-full blur-3xl pointer-events-none"
                style={{ background: `radial-gradient(ellipse, ${accentHex}33, transparent 70%)` }}
              />
            </div>
          )}

          {/* ===== 网易云面板 ===== */}
          {showNeteasePanel && (
            <div
              className="absolute top-[40px] left-[100px] w-[500px] max-h-[78vh] z-[66] pointer-events-auto rounded-2xl border border-white/15 shadow-2xl overflow-hidden"
              style={{
                background: 'linear-gradient(160deg, rgba(10,15,30,0.92), rgba(2,4,12,0.96))',
                boxShadow: `0 30px 80px rgba(0,0,0,0.7), 0 0 60px ${accentHex}22, inset 0 1px 0 rgba(255,255,255,0.06)`,
                borderColor: `${accentHex}44`,
                animation: 'fadeSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
                <div className="flex items-center gap-3">
                  <span className="text-[14px] font-medium text-white/90 tracking-wide">网易云</span>
                  <span className="text-[10px] text-white/30">· 云音乐</span>
                  {isLoadingNeteaseCloud && (
                    <span className="text-[10px] text-white/40 animate-pulse">加载中...</span>
                  )}
                </div>
                <button
                  onClick={() => setShowNeteasePanel(false)}
                  className="text-white/40 hover:text-white transition-colors text-[10px] uppercase tracking-[0.15em] px-3 py-1.5 rounded-full border border-white/10 hover:border-white/30"
                >
                  关闭
                </button>
              </div>
              <div className="px-5 py-3 border-b border-white/10">
                <div className="flex gap-1.5">
                  <button
                    onClick={loadLikedSongs}
                    className={`px-4 py-1.5 text-[10px] uppercase tracking-widest rounded-full border transition-all duration-300 ${neteaseCloudTab === 'liked'
                      ? 'text-black border-transparent shadow-lg'
                      : 'border-white/10 text-white/40 hover:text-white hover:bg-white/5'
                      }`}
                    style={{
                      backgroundColor: neteaseCloudTab === 'liked' ? accentHex : 'transparent',
                      boxShadow: neteaseCloudTab === 'liked' ? `0 4px 16px ${accentHex}66` : 'none',
                    }}
                  >
                    喜欢
                  </button>
                  <button
                    onClick={loadNeteasePlaylists}
                    className={`px-4 py-1.5 text-[10px] uppercase tracking-widest rounded-full border transition-all duration-300 ${neteaseCloudTab === 'playlists'
                      ? 'text-black border-transparent shadow-lg'
                      : 'border-white/10 text-white/40 hover:text-white hover:bg-white/5'
                      }`}
                    style={{
                      backgroundColor: neteaseCloudTab === 'playlists' ? accentHex : 'transparent',
                      boxShadow: neteaseCloudTab === 'playlists' ? `0 4px 16px ${accentHex}66` : 'none',
                    }}
                  >
                    歌单
                  </button>
                  <button
                    onClick={loadDailyRecommendations}
                    className={`px-4 py-1.5 text-[10px] uppercase tracking-widest rounded-full border transition-all duration-300 ${neteaseCloudTab === 'daily'
                      ? 'text-black border-transparent shadow-lg'
                      : 'border-white/10 text-white/40 hover:text-white hover:bg-white/5'
                      }`}
                    style={{
                      backgroundColor: neteaseCloudTab === 'daily' ? accentHex : 'transparent',
                      boxShadow: neteaseCloudTab === 'daily' ? `0 4px 16px ${accentHex}66` : 'none',
                    }}
                  >
                    每日推荐
                  </button>
                </div>
              </div>
              {neteaseCloudTab === 'playlists' && (
                <div className="max-h-[140px] overflow-y-auto scrollbar-hide border-b border-white/5">
                  {neteaseCloudPlaylists.length > 0 ? (
                    neteaseCloudPlaylists.map((playlist) => (
                      <button
                        key={playlist.id}
                        onClick={() => loadNeteasePlaylistSongs(playlist)}
                        className={`w-full flex items-center justify-between gap-3 px-5 py-3 text-left hover:bg-white/5 transition-colors ${activeNeteasePlaylistId === playlist.id ? 'bg-white/5' : ''
                          }`}
                      >
                        <span className="min-w-0 text-[12px] text-white/80 truncate">{playlist.name}</span>
                        <span className="text-[10px] text-white/30">{playlist.trackCount}</span>
                      </button>
                    ))
                  ) : (
                    <div className="px-5 py-6 text-[12px] text-white/30 text-center">
                      {isLoadingNeteaseCloud ? '加载歌单中...' : '点击"歌单"加载你的网易云歌单'}
                    </div>
                  )}
                </div>
              )}
              {neteaseCloudStatus && (
                <div className="px-5 py-2.5 border-b border-white/5 text-[11px] text-white/45 bg-white/5">
                  {neteaseCloudStatus}
                </div>
              )}
              <div className="max-h-[44vh] overflow-y-auto scrollbar-hide">
                {neteaseCloudSongs.length > 0 ? (
                  neteaseCloudSongs.map((song) => (
                    <button
                      key={song.id}
                      onClick={() => loadNeteaseSong(song, neteaseCloudSongs)}
                      className="relative w-full text-left px-5 py-4 pr-16 hover:bg-white/5 transition-colors border-b border-white/5 last:border-0 group"
                    >
                      <div className="flex items-start gap-3">
                        <div className="shrink-0 w-6 text-center text-[11px] text-white/25 font-mono mt-0.5">
                          {currentSongId === song.id ? (
                            <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: accentHex }} />
                          ) : (
                            <span>{(neteaseCloudSongs.indexOf(song) + 1).toString().padStart(2, '0')}</span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className={`text-[13px] truncate ${currentSongId === song.id ? 'text-white' : 'text-white/80'}`}>
                            {song.name}
                          </div>
                          <div className="mt-1 text-[11px] text-white/40 truncate">
                            {song.artist || '未知歌手'} · {song.album || '未知专辑'}
                          </div>
                        </div>
                      </div>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); addSongToFavorites(song); }}
                        className="absolute right-4 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full border border-white/10 text-white/40 hover:text-black hover:border-transparent transition-all hover:scale-110 flex items-center justify-center group-hover:border-white/20"
                        title="加入喜欢"
                      >
                        <Plus size={15} />
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-5 py-16 text-center">
                    <div className="text-[13px] text-white/30">
                      {isLoadingNeteaseCloud ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: accentHex }} />
                          加载中...
                        </span>
                      ) : (
                        '暂无歌曲'
                      )}
                    </div>
                    <div className="mt-2 text-[10px] text-white/15">
                      {neteaseCloudTab === 'playlists' ? '请选择一个歌单' : '点击上方标签加载内容'}
                    </div>
                  </div>
                )}
              </div>
              <div
                className="absolute -bottom-6 left-1/2 -translate-x-1/2 w-2/3 h-12 rounded-full blur-3xl pointer-events-none"
                style={{ background: `radial-gradient(ellipse, ${accentHex}33, transparent 70%)` }}
              />
            </div>
          )}

          {/* ===== 删除确认弹窗 ===== */}
          {pendingDelete && (
            <div className="absolute inset-0 z-[120] pointer-events-auto flex items-center justify-center bg-black/40 backdrop-blur-sm">
              <div className="w-[320px] border border-white/10 rounded-sm p-5" style={{ background: 'rgba(5,10,15,0.96)' }}>
                <div className="text-[12px] uppercase tracking-[0.2em] text-white/70 mb-3">
                  Confirm Delete
                </div>
                <div className="text-[13px] text-white/80 leading-relaxed mb-5">
                  Delete {pendingDelete.type === 'playlist' ? 'playlist' : 'song'} <span className="text-white">{pendingDelete.label}</span>?
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setPendingDelete(null)}
                    className="px-3 py-2 rounded-sm border border-white/10 text-[10px] uppercase tracking-[0.15em] text-white/45 hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmPendingDelete}
                    className="px-3 py-2 rounded-sm border border-[#ef4444]/40 text-[10px] uppercase tracking-[0.15em] text-[#ef4444] hover:bg-[#ef4444] hover:text-black"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ===== 播放器卡片 ===== */}
          {showPlayerPanel && trackName !== 'No track selected' && (
            <div
              className="player-panel absolute top-[30px] right-[30px] z-50 pointer-events-auto rounded-2xl border border-white/10 shadow-2xl overflow-hidden"
              style={{
                background: 'rgba(10, 15, 30, 0.25)',
                backdropFilter: 'blur(40px)',
                WebkitBackdropFilter: 'blur(40px)',
                boxShadow: `0 20px 60px rgba(0,0,0,0.3), 0 0 60px ${accentHex}22, inset 0 1px 0 rgba(255,255,255,0.08)`,
                borderColor: `${accentHex}33`,
                animation: 'fadeSlideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
                minWidth: '240px',
                maxWidth: '420px',
                width: 'auto',
              }}
            >
              <div className="px-4 py-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] leading-5 font-light tracking-[0.05em] text-white/90 truncate" title={trackName}>
                      {trackName}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className="text-[9px] uppercase tracking-[0.12em] text-white/40 whitespace-nowrap">
                        {isCapturing ? '系统采集' : '本地音频'}
                      </span>
                      <span className="w-1 h-1 rounded-full bg-white/20 shrink-0" />
                      <span className="text-[9px] text-white/35 truncate max-w-[100px]">{resolvedTheme.name}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      const keys = Object.keys(themes);
                      const themeKeys = [...keys, CUSTOM_THEME_ID];
                      const currentIndex = themeKeys.indexOf(theme);
                      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % themeKeys.length : 0;
                      onThemeChange(themeKeys[nextIndex]);
                    }}
                    className="shrink-0 text-white/40 hover:text-white transition-colors w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10"
                    title="切换主题"
                  >
                    <Palette size={14} />
                  </button>
                </div>
                <div className={`mt-2.5 h-[14px] relative flex items-end group ${isCapturing ? 'opacity-30 pointer-events-none' : ''}`}>
                  <div className="w-full relative h-[2px] bg-white/15 group-hover:h-[3px] transition-all rounded-full overflow-hidden">
                    <div
                      className="absolute top-0 left-0 h-full rounded-full transition-all"
                      style={{
                        backgroundColor: accentHex,
                        width: `${duration ? (currentTime / duration) * 100 : 0}%`,
                        boxShadow: `0 0 16px ${accentHex}aa`,
                      }}
                    />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={duration || 100}
                    step="0.01"
                    value={currentTime}
                    onChange={(e) => {
                      if (engine.audioElement) {
                        const newTime = parseFloat(e.target.value);
                        engine.audioElement.currentTime = newTime;
                        setCurrentTime(newTime);
                      }
                    }}
                    className="absolute bottom-0 left-0 w-full opacity-0 cursor-pointer h-full"
                  />
                </div>
                <div className={`flex items-center justify-between mt-1.5 gap-2 ${isCapturing ? 'opacity-30 pointer-events-none' : ''}`}>
                  <span className="text-[10px] font-mono text-white/50 shrink-0 w-9">{formatTime(currentTime)}</span>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={() => playFromQueue(-1)}
                      className="text-white/50 hover:text-white transition-colors w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 disabled:opacity-25 disabled:hover:text-inherit disabled:hover:bg-transparent"
                      disabled={getCurrentQueue().length === 0}
                      title="上一首"
                    >
                      <SkipBack size={14} />
                    </button>
                    <button
                      onClick={togglePlay}
                      className="text-black transition-all hover:scale-105 active:scale-95 w-9 h-9 rounded-full flex items-center justify-center shadow-lg shrink-0"
                      style={{
                        backgroundColor: accentHex,
                        boxShadow: `0 4px 20px ${accentHex}88`,
                      }}
                    >
                      {isPlaying ? <Pause size={16} className="fill-current" /> : <Play size={16} className="fill-current ml-0.5" />}
                    </button>
                    <button
                      onClick={() => playFromQueue(1)}
                      className="text-white/50 hover:text-white transition-colors w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 disabled:opacity-25 disabled:hover:text-inherit disabled:hover:bg-transparent"
                      disabled={getCurrentQueue().length === 0}
                      title="下一首"
                    >
                      <SkipForward size={14} />
                    </button>
                    <button
                      onClick={() => setPlayMode((mode) => mode === 'sequence' ? 'shuffle' : 'sequence')}
                      className="w-7 h-7 rounded-full flex items-center justify-center transition-colors hover:bg-white/10 shrink-0"
                      title={playMode === 'sequence' ? '顺序播放' : '随机播放'}
                      style={{ color: playMode === 'shuffle' ? accentHex : 'rgba(255,255,255,0.4)' }}
                    >
                      {playMode === 'sequence' ? <Repeat size={13} /> : <Shuffle size={13} />}
                    </button>
                  </div>
                  <div className="flex items-center gap-1 group shrink-0">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={volume}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        engine.audioElement.volume = val;
                        setVolume(val);
                      }}
                      className="w-10 h-1 accent-current opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer bg-white/20 appearance-none rounded-full"
                      style={{ accentColor: accentHex }}
                    />
                    <Volume2
                      size={13}
                      className="text-white/50 hover:text-white transition-colors cursor-pointer shrink-0"
                      onClick={() => {
                        const val = volume > 0 ? 0 : 1;
                        engine.audioElement.volume = val;
                        setVolume(val);
                      }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-white/50 shrink-0 w-9 text-right">{formatTime(duration)}</span>
                </div>
              </div>
              <div
                className="absolute -bottom-6 left-1/2 -translate-x-1/2 w-2/3 h-12 rounded-full blur-3xl pointer-events-none"
                style={{ background: `radial-gradient(ellipse, ${accentHex}22, transparent 70%)` }}
              />
            </div>
          )}

          {/* ===== 歌词 ===== */}
          {trackName !== 'No track selected' && !isCapturing && lyricsText && (
            <LyricsDisplay lrcText={lyricsText} currentTime={currentTime} accentHex={accentHex} isPlaying={isPlaying} />
          )}

          {/* ===== Stats Panel & Lyrics Status ===== */}
          {trackName !== 'No track selected' && (
            <div className="absolute bottom-[40px] left-[100px] z-50 pointer-events-none flex flex-col gap-6">
              {!lyricsText && (
                <div
                  className="text-[10px] text-white/40 uppercase tracking-[0.2em] flex items-center gap-2 pointer-events-auto cursor-pointer hover:text-white/80 transition-colors w-fit"
                  onClick={() => fileInputRef.current?.click()}
                  title="Upload .lrc file"
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-red-500/50"></div>
                  No Lyrics - Click to upload .lrc
                </div>
              )}
              <div className="mobile-hide-aux-ui">
                <StatsPanel accentHex={accentHex} />
              </div>
            </div>
          )}

          {/* ===== 底部提示 ===== */}
          <div className="mobile-hide-aux-ui absolute bottom-[40px] right-[40px] text-[10px] uppercase tracking-[0.1em] opacity-30 select-none">
            Drag to orbit - Click to pulse
          </div>

          {/* ===== 设置面板 ===== */}
          {showOptionsPanel && (
            <OptionsPanel
              onClose={() => setShowOptionsPanel(false)}
              accentHex={accentHex}
              neteaseCookie={neteaseCookie}
              setNeteaseCookie={setNeteaseCookie}
              onSaveCookie={saveNeteaseCookie}
              onClearCookie={clearNeteaseCookie}
              cookieStatus={cookieStatus}
              isNeteaseCookieValid={isNeteaseCookieValid}
              isSyncingNeteaseCookie={isSyncingNeteaseCookie}
              theme={theme}
              customThemes={customThemes}
              activeCustomThemeId={activeCustomThemeId}
              themeRotation={themeRotation}
              groundEqSettings={groundEqSettings}
              presetTransferStatus={presetTransferStatus}
              setPresetTransferStatus={setPresetTransferStatus}
              onImportPresetPackage={applyPresetTransferPackage}
              onThemeChange={onThemeChange}
              onCustomThemesChange={onCustomThemesChange}
              onThemeRotationChange={onThemeRotationChange}
              onGroundEqSettingsChange={onGroundEqSettingsChange}
              apiBaseUrl={apiBaseUrl}
              setApiBaseUrl={setApiBaseUrl}
              onEnterThemeEditor={enterThemeEditor}
            />
          )}
        </>
      )}

      {/* ============================================================ */}
      {/* ===== 沉浸式主题编辑模式浮层（始终渲染，不受 isThemeEditorMode 影响） ===== */}
      {/* ============================================================ */}
      {isThemeEditorMode && editingThemeData && createPortal(
        <div className="fixed inset-0 z-[9999] pointer-events-none">
          <div
            className="absolute bottom-8 right-8 w-[420px] max-h-[75vh] overflow-y-auto scrollbar-hide p-6 rounded-2xl border border-white/15 shadow-2xl pointer-events-auto"
            style={{
              background: 'linear-gradient(160deg, rgba(12,18,34,0.95), rgba(4,6,14,0.98))',
              boxShadow: `0 40px 100px rgba(0,0,0,0.85), 0 0 80px ${accentHex}33, inset 0 1px 0 rgba(255,255,255,0.06)`,
              borderColor: `${accentHex}55`,
              animation: 'fadeSlideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            <ThemeEditorPanel
              preset={editingThemeData}
              accentHex={accentHex}
              customThemes={customThemes}
              onUpdate={(updated) => setEditingThemeData(updated)}
              onSave={() => saveThemeFromEditor(editingThemeData)}
              onCancel={exitThemeEditor}
              onDelete={() => {
                if (editingThemeData && customThemes.some(p => p.id === editingThemeData.id)) {
                  const nextPresets = customThemes.filter(p => p.id !== editingThemeData.id);
                  if (nextPresets.length > 0) {
                    onCustomThemesChange(nextPresets, nextPresets[0].id);
                  }
                }
                exitThemeEditor();
              }}
            />
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function ThemeEditorPanel({
  preset,
  accentHex,
  customThemes,
  onUpdate,
  onSave,
  onCancel,
  onDelete,
}: {
  preset: CustomThemeSettings;
  accentHex: string;
  customThemes: CustomThemeSettings[];
  onUpdate: (preset: CustomThemeSettings) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const isExisting = customThemes.some(p => p.id === preset.id);

  const colorControls: Array<{ key: keyof Pick<CustomThemeSettings, 'background' | 'cool' | 'warm' | 'accent'>; label: string; hint: string }> = [
    { key: 'background', label: '背景色', hint: '控制页面背景、雾色和地形暗部' },
    { key: 'cool', label: '冷色', hint: '控制亮部、冷调和高频地形发光' },
    { key: 'warm', label: '暖色', hint: '控制暖调地形发光，也会影响流星颜色' },
    { key: 'accent', label: '强调色', hint: '控制按钮、歌词、进度条、脉冲波纹和设置滑块' },
  ];

  return (
    <div>
      {/* 头部 */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-[17px] font-medium text-white/95 tracking-wide">
            {isExisting ? '编辑主题' : '新建主题'}
          </div>
          <div className="text-[11px] text-white/35">调整配色，背景实时变化</div>
        </div>
        <button
          onClick={onCancel}
          className="text-white/40 hover:text-white text-[18px] leading-none w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/5"
        >
          ✕
        </button>
      </div>

      {/* 主题名称 */}
      <div className="grid gap-1.5 mb-3">
        <label className="text-[10px] uppercase tracking-[0.18em] text-white/40">主题名称</label>
        <input
          value={preset.name}
          onChange={(e) => onUpdate({ ...preset, name: e.target.value })}
          className="bg-black/30 border border-white/10 rounded-xl px-4 py-2 text-[13px] text-white outline-none focus:border-white/30 transition-colors"
          placeholder="输入主题名称"
          autoFocus
        />
      </div>

      {/* 配色预览 */}
      <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 mb-3">
        <span className="text-[10px] uppercase tracking-[0.15em] text-white/35 shrink-0">预览</span>
        <div className="flex gap-1.5 flex-1">
          {[preset.background, preset.cool, preset.warm, preset.accent].map((color, idx) => (
            <div
              key={`preview-${idx}`}
              className="h-5 flex-1 rounded-full"
              style={{ backgroundColor: color, boxShadow: `0 0 16px ${color}88` }}
            />
          ))}
        </div>
      </div>

      {/* 颜色选择器 */}
      <div className="grid grid-cols-2 gap-2.5 mb-3">
        {colorControls.map((control) => (
          <label
            key={control.key}
            className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-black/20 px-3 py-2 hover:border-white/20 transition-colors cursor-pointer"
          >
            <input
              type="color"
              value={preset[control.key]}
              onChange={(e) => onUpdate({ ...preset, [control.key]: e.target.value })}
              className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-white/10 bg-transparent p-0.5"
            />
            <span className="min-w-0">
              <span className="block text-[11px] text-white/75">{control.label}</span>
              <span className="block text-[8px] leading-relaxed text-white/25">{control.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {/* 参数控制 */}
      <div className="grid grid-cols-2 gap-2.5 mb-3">
        <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-white/50">旋转速度</span>
            <span className="text-[11px]" style={{ color: accentHex }}>{preset.rotationSpeed.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            value={preset.rotationSpeed}
            onChange={(e) => onUpdate({ ...preset, rotationSpeed: Number(e.target.value) })}
            className="mt-1 w-full accent-current h-1"
            style={{ accentColor: accentHex }}
          />
        </div>
        <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-white/50">发光强度</span>
            <span className="text-[11px]" style={{ color: accentHex }}>{preset.glowIntensity.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min="0.4"
            max="2.2"
            step="0.05"
            value={preset.glowIntensity}
            onChange={(e) => onUpdate({ ...preset, glowIntensity: Number(e.target.value) })}
            className="mt-1 w-full accent-current h-1"
            style={{ accentColor: accentHex }}
          />
        </div>
      </div>

      {/* 播放器卡片开关 */}
      <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/20 px-3 py-2 mb-4">
        <div>
          <span className="text-[11px] text-white/70">显示播放器卡片</span>
          <span className="block text-[8px] text-white/25">控制右上角播放卡片是否显示</span>
        </div>
        <button
          onClick={() => onUpdate({ ...preset, showPlayerPanel: !preset.showPlayerPanel })}
          className={`shrink-0 px-4 py-1.5 rounded-full border text-[9px] uppercase tracking-[0.15em] transition-all ${preset.showPlayerPanel
            ? 'text-black border-transparent shadow-lg'
            : 'border-white/10 text-white/45 hover:text-white'
            }`}
          style={{
            backgroundColor: preset.showPlayerPanel ? accentHex : 'transparent',
            boxShadow: preset.showPlayerPanel ? `0 4px 12px ${accentHex}66` : 'none',
          }}
        >
          {preset.showPlayerPanel ? '显示' : '隐藏'}
        </button>
      </div>

      {/* 底部操作 */}
      <div className="flex items-center justify-between pt-3 border-t border-white/5">
        <div>
          {isExisting && (
            <button
              onClick={onDelete}
              disabled={customThemes.length <= 1}
              className="px-3 py-1.5 rounded-full border border-white/10 text-[9px] uppercase tracking-[0.15em] text-white/35 hover:text-[#ef4444] disabled:opacity-25 disabled:hover:text-white/35 transition-colors"
            >
              删除主题
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 rounded-full border border-white/10 text-[9px] uppercase tracking-[0.15em] text-white/45 hover:text-white transition-colors"
          >
            取消
          </button>
          <button
            onClick={onSave}
            className="px-6 py-1.5 rounded-full text-[9px] uppercase tracking-[0.15em] text-black font-medium transition-all hover:scale-105 active:scale-95"
            style={{ backgroundColor: accentHex }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function MenuButton({
  onClick,
  children,
  accentHex,
}: {
  onClick: () => void;
  children: React.ReactNode;
  accentHex: string;
}) {
  return (
    <button
      onClick={onClick}
      className="relative text-center text-[15px] uppercase tracking-[0.15em] text-white/60 hover:text-white transition-all duration-300 py-2 w-full rounded-sm group overflow-hidden"
      style={{ fontFamily: "'Helvetica Neue', Arial, sans-serif" }}
    >
      {/* 背景光晕（悬浮时显示） */}
      <span
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{
          background: `linear-gradient(90deg, transparent, ${accentHex}22, transparent)`,
        }}
      />
      {/* 下划线动画 */}
      <span
        className="absolute bottom-0 left-1/2 -translate-x-1/2 w-0 group-hover:w-2/3 h-[2px] transition-all duration-300 ease-out"
        style={{ background: `linear-gradient(90deg, transparent, ${accentHex}, transparent)` }}
      />
      {/* 文字内容 */}
      <span className="relative z-10 group-hover:scale-105 inline-block transition-transform duration-300">
        {children}
      </span>
    </button>
  );
}

// ========== 子组件 ==========

import { TriggerPreset } from '../../lib/AudioEngine';

function NeteaseSongList({
  songs,
  currentSongId,
  queue,
  onPlay,
  onFavorite,
  emptyText,
}: {
  songs: NeteaseSong[];
  currentSongId: number | null;
  queue: NeteaseSong[];
  onPlay: (song: NeteaseSong, queue?: NeteaseSong[]) => void;
  onFavorite: (song: NeteaseSong) => void;
  emptyText: string;
}) {
  return (
    <div className="max-h-[44vh] overflow-y-auto">
      {songs.length > 0 ? songs.map((song) => (
        <button
          key={song.id}
          onClick={() => onPlay(song, queue)}
          className="relative w-full text-left px-5 py-4 pr-16 border-b border-white/5 hover:bg-white/5 transition-colors"
        >
          <div className={`text-[13px] truncate ${currentSongId === song.id ? 'text-white' : 'text-white/80'}`}>{song.name}</div>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onFavorite(song);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onFavorite(song);
              }
            }}
            className="absolute right-5 top-1/2 -translate-y-1/2 h-8 w-8 rounded-sm border border-white/10 text-white/55 hover:text-black hover:border-transparent transition-colors flex items-center justify-center"
            title="加入喜欢"
          >
            <Plus size={15} />
          </span>
          <div className="mt-1 text-[11px] text-white/45 truncate">{song.artist || '未知歌手'} - {song.album || '未知专辑'}</div>
        </button>
      )) : (
        <div className="px-5 py-8 text-[12px] text-white/40">{emptyText}</div>
      )}
    </div>
  );
}

function OptionsPanel({
  onClose,
  accentHex,
  neteaseCookie,
  setNeteaseCookie,
  onSaveCookie,
  onClearCookie,
  cookieStatus,
  isNeteaseCookieValid,
  isSyncingNeteaseCookie,
  theme,
  customThemes,
  activeCustomThemeId,
  themeRotation,
  groundEqSettings,
  presetTransferStatus,
  setPresetTransferStatus,
  onImportPresetPackage,
  onThemeChange,
  onCustomThemesChange,
  onThemeRotationChange,
  onGroundEqSettingsChange,
  apiBaseUrl,
  setApiBaseUrl,
  onEnterThemeEditor,
}: {
  onClose: () => void;
  accentHex: string;
  neteaseCookie: string;
  setNeteaseCookie: (cookie: string) => void;
  onSaveCookie: () => void;
  onClearCookie: () => void;
  cookieStatus: string;
  isNeteaseCookieValid: boolean;
  isSyncingNeteaseCookie: boolean;
  theme: string;
  customThemes: CustomThemeSettings[];
  activeCustomThemeId: string;
  themeRotation: ThemeRotationSettings;
  groundEqSettings: StoredGroundEqSettings;
  presetTransferStatus: string;
  setPresetTransferStatus: (status: string) => void;
  onImportPresetPackage: (presetPackage: PresetTransferPackage) => Promise<void>;
  onThemeChange: (theme: string) => void;
  onCustomThemesChange: (settings: CustomThemeSettings[], activeId?: string) => void;
  onThemeRotationChange: (settings: ThemeRotationSettings) => void;
  onGroundEqSettingsChange: (settings: StoredGroundEqSettings) => void;
  apiBaseUrl: string;
  setApiBaseUrl: (url: string) => void;
  onEnterThemeEditor?: (preset?: CustomThemeSettings) => void;
}) {
  const [activeTab, setActiveTab] = useState<OptionsTab>('Meteor');
  const [includeCookieInExport, setIncludeCookieInExport] = useState(false);
  const importPresetInputRef = useRef<HTMLInputElement>(null);
  const tabs: OptionsTab[] = ['Pulse', 'Meteor', 'GroundEq', 'Color', 'Cookie', 'API', 'Preset'];
  const tabLabels: Record<OptionsTab, string> = {
    Pulse: '脉冲特效',
    Meteor: '流星特效',
    GroundEq: '地面 EQ',
    Color: '自定义主题',
    Cookie: '网易云 Cookie',
    API: 'API 地址',
    Preset: '预设导出',
  };

  const exportPreset = () => {
    try {
      const presetPackage = createPresetTransferPackage({ includeNeteaseCookie: includeCookieInExport });
      const blob = new Blob([JSON.stringify(presetPackage, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      link.href = url;
      link.download = `sonic-topography-presets-${stamp}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setPresetTransferStatus(includeCookieInExport ? '预设已导出，包含网易云 Cookie' : '预设已导出，未包含网易云 Cookie');
    } catch (error) {
      console.warn('Unable to export presets:', error);
      setPresetTransferStatus('导出失败，请稍后重试');
    }
  };

  const importPresetFile = async (file: File | undefined) => {
    if (!file) return;

    try {
      setPresetTransferStatus('正在导入预设...');
      const text = await file.text();
      const parsed = JSON.parse(text);
      await onImportPresetPackage(normalizePresetTransferPackage(parsed));
    } catch (error) {
      console.warn('Unable to import presets:', error);
      setPresetTransferStatus(error instanceof Error ? error.message : '导入失败，请选择正确的预设文件');
    } finally {
      if (importPresetInputRef.current) importPresetInputRef.current.value = '';
    }
  };


  return (
    <div
      className="fixed inset-0 z-[100] overflow-y-auto scrollbar-hide pointer-events-auto"
      style={{
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(6px)',
        animation: 'fadeIn 0.3s ease-out',
      }}
    >
      <div
        className="relative mx-auto w-[min(900px,calc(100vw-40px))] pt-[40px] pb-[60px] pointer-events-none"
        style={{
          animation: 'fadeSlideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div
          className="pointer-events-auto rounded-2xl p-8 backdrop-blur-2xl border border-white/15 shadow-2xl"
          style={{
            background: 'linear-gradient(160deg, rgba(10,15,30,0.92), rgba(2,4,12,0.96))',
            boxShadow: `0 30px 80px rgba(0,0,0,0.7), 0 0 60px ${accentHex}22, inset 0 1px 0 rgba(255,255,255,0.06)`,
            borderColor: `${accentHex}44`,
          }}
        >
          {/* 顶部标题 */}
          <div className="flex justify-between items-center mb-8">
            <div>
              <div className="text-2xl font-light tracking-widest text-white/95">设置</div>
              <div className="mt-2 text-[11px] uppercase tracking-[0.2em] text-white/40 flex items-center gap-2">
                <span className="w-6 h-px bg-gradient-to-r from-transparent to-white/20" />
                个性化你的喜好
                <span className="w-6 h-px bg-gradient-to-l from-transparent to-white/20" />
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-white/40 hover:text-white uppercase tracking-[0.2em] text-[11px] transition-colors px-3 py-1.5 rounded-full border border-white/10 hover:border-white/30"
            >
              关闭
            </button>
          </div>

          {/* 选项卡 */}
          <div className="flex gap-2 mb-6 flex-wrap">
            {tabs.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-[11px] uppercase tracking-widest rounded-full border transition-all duration-300 ${activeTab === tab
                  ? 'text-black border-transparent shadow-lg'
                  : 'border-white/10 text-white/40 hover:text-white hover:bg-white/5'
                  }`}
                style={{
                  backgroundColor: activeTab === tab ? accentHex : 'transparent',
                  boxShadow: activeTab === tab ? `0 4px 20px ${accentHex}66` : 'none',
                }}
              >
                {tabLabels[tab]}
              </button>
            ))}
          </div>

          {/* 内容区 */}
          <div className="mt-4">
            {activeTab === 'Preset' ? (
              // 预设迁移内容
              <div className="rounded-xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-sm">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-[13px] uppercase tracking-[0.18em] text-white/70">预设迁移</div>
                    <div className="mt-1.5 text-[12px] leading-relaxed text-white/40">一键导出或导入歌单、特效、地面 EQ、自定义主题和浏览器设置。</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-[10px] uppercase tracking-[0.12em] text-white/50 hover:border-white/30 transition-colors cursor-pointer">
                      <input
                        type="checkbox"
                        checked={includeCookieInExport}
                        onChange={(event) => setIncludeCookieInExport(event.target.checked)}
                        className="h-3.5 w-3.5 accent-current"
                        style={{ accentColor: accentHex }}
                      />
                      包含 Cookie
                    </label>
                    <button
                      type="button"
                      onClick={exportPreset}
                      className="px-4 py-2 rounded-full text-[10px] uppercase tracking-[0.15em] text-black font-medium transition-all hover:scale-105 active:scale-95"
                      style={{ backgroundColor: accentHex }}
                    >
                      导出预设
                    </button>
                    <button
                      type="button"
                      onClick={() => importPresetInputRef.current?.click()}
                      className="px-4 py-2 rounded-full border border-white/10 text-[10px] uppercase tracking-[0.15em] text-white/55 hover:text-white hover:border-white/30 transition-colors"
                    >
                      导入预设
                    </button>
                    <input
                      ref={importPresetInputRef}
                      type="file"
                      accept="application/json,.json"
                      className="hidden"
                      onChange={(event) => importPresetFile(event.target.files?.[0])}
                    />
                  </div>
                </div>
                {presetTransferStatus && (
                  <div className="mt-3 text-[12px] text-white/45 bg-white/5 rounded-lg px-3 py-2 border border-white/5">
                    {presetTransferStatus}
                  </div>
                )}
              </div>
            ) : activeTab === 'API' ? (
              <ApiConfigPanel
                accentHex={accentHex}
                apiBaseUrl={apiBaseUrl}
                setApiBaseUrl={setApiBaseUrl}
              />
            ) : activeTab === 'GroundEq' ? (
              <GroundEqPanel
                accentHex={accentHex}
                groundEqSettings={groundEqSettings}
                onGroundEqSettingsChange={onGroundEqSettingsChange}
              />
            ) : activeTab === 'Color' ? (
              <CustomColorPanel
                accentHex={accentHex}
                theme={theme}
                customThemes={customThemes}
                activeCustomThemeId={activeCustomThemeId}
                themeRotation={themeRotation}
                onThemeChange={onThemeChange}
                onCustomThemesChange={onCustomThemesChange}
                onThemeRotationChange={onThemeRotationChange}
                onEnterEditor={onEnterThemeEditor}
              />
            ) : activeTab === 'Cookie' ? (
              <NeteaseCookiePanel
                accentHex={accentHex}
                neteaseCookie={neteaseCookie}
                setNeteaseCookie={setNeteaseCookie}
                onSaveCookie={onSaveCookie}
                onClearCookie={onClearCookie}
                cookieStatus={cookieStatus}
                isNeteaseCookieValid={isNeteaseCookieValid}
                isSyncingNeteaseCookie={isSyncingNeteaseCookie}
              />
            ) : (
              <FreqTriggerPanel key={activeTab} action={activeTab as 'Pulse' | 'Meteor'} accentHex={accentHex} />
            )}
          </div>

          {/* 底部装饰光晕 */}
          <div
            className="absolute -bottom-6 left-1/2 -translate-x-1/2 w-2/3 h-12 rounded-full blur-3xl pointer-events-none"
            style={{ background: `radial-gradient(ellipse, ${accentHex}33, transparent 70%)` }}
          />
        </div>
      </div>
    </div>
  );
}

function ApiConfigPanel({
  accentHex,
  apiBaseUrl,
  setApiBaseUrl,
}: {
  accentHex: string;
  apiBaseUrl: string;
  setApiBaseUrl: (url: string) => void;
}) {
  const [inputValue, setInputValue] = useState(apiBaseUrl);
  const [status, setStatus] = useState('');
  const [isTesting, setIsTesting] = useState(false);

  useEffect(() => {
    setInputValue(apiBaseUrl);
  }, [apiBaseUrl]);

  const handleSave = () => {
    let trimmed = inputValue.trim();
    if (!trimmed) {
      setApiBaseUrl('');
      setStatus('已重置为本地代理');
      return;
    }
    // 自动补全协议
    if (!/^https?:\/\//i.test(trimmed)) {
      trimmed = `http://${trimmed}`;
    }
    // 去除末尾斜杠
    trimmed = trimmed.replace(/\/+$/, '');
    setApiBaseUrl(trimmed);
    setStatus(`✅ 已保存: ${trimmed}`);
  };

  const handleTest = async () => {
    let target = inputValue.trim();
    let testUrl = '';
    setIsTesting(true);
    setStatus('⏳ 测试连接中...');

    try {
      // 格式化地址（与保存逻辑一致）
      if (target && !/^https?:\/\//i.test(target)) {
        target = `http://${target}`;
      }
      target = target.replace(/\/+$/, '');
      testUrl = target ? `${target}/api/playlists` : '/api/playlists';
      setStatus(`⏳ 请求: ${testUrl}`);

      // 使用 no-cors 模式，只检测连通性，忽略 CORS
      const res = await fetch(testUrl, {
        mode: 'no-cors',
        signal: AbortSignal.timeout(5000),
      });

      // no-cors 模式下，只要请求没抛出异常，就表示网络层已到达
      setStatus(`✅ 连接成功`);
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        setStatus(`❌ 请求超时，请检查地址或端口`);
      } else {
        setStatus(`❌ 无法访问 ${testUrl || '目标地址'}，请检查地址或网络`);
      }
    } finally {
      setIsTesting(false);
    }
  };

  const handleReset = () => {
    setInputValue('');
    setApiBaseUrl('');
    setStatus('已重置为本地地址');
  };

  return (
    <div className="grid gap-5">
      <div className="border border-white/10 bg-white/[0.03] rounded-sm p-4">
        <div className="text-[12px] uppercase tracking-[0.18em] text-white/70 mb-2">后端 API 地址</div>
        <div className="text-[11px] leading-relaxed text-white/45">
          设置自定义后端 API 地址。留空则使用本地代理
          适用于本地、内网代理或切换不同后端环境
        </div>
      </div>

      <div className="grid gap-2">
        <label className="text-[10px] uppercase tracking-[0.18em] text-white/45">API Base URL</label>
        <input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="例如: 127.0.0.1:3000 或 https://api.example.com"
          className="bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[12px] text-white outline-none focus:border-white/30 font-mono"
        />
        <div className="text-[11px] leading-relaxed text-white/45">
          当前代理生效: <span style={{ color: apiBaseUrl ? accentHex : 'inherit', fontWeight: 'bold' }}>
            {apiBaseUrl || '(使用本地代理)'}
          </span>
        </div>
      </div>

      {status && (
        <div className="text-[11px] text-white/50 border border-white/5 bg-black/20 p-2 rounded-sm whitespace-pre-wrap">
          {status}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        <button
          onClick={handleReset}
          className="px-3 py-2 rounded-sm border border-white/10 text-[10px] uppercase tracking-[0.15em] text-white/45 hover:text-white transition-colors"
        >
          重置
        </button>
        <button
          onClick={handleTest}
          disabled={isTesting}
          className="px-3 py-2 rounded-sm border border-white/10 text-[10px] uppercase tracking-[0.15em] text-white/45 hover:text-white transition-colors disabled:opacity-40"
        >
          {isTesting ? '测试中...' : '测试连接'}
        </button>
        <button
          onClick={handleSave}
          className="px-3 py-2 rounded-sm text-[10px] uppercase tracking-[0.15em] text-black disabled:opacity-40"
          style={{ backgroundColor: accentHex }}
          disabled={inputValue.trim() === apiBaseUrl}
        >
          保存地址
        </button>
      </div>
    </div>
  );
}

function GroundEqPanel({
  accentHex,
  groundEqSettings,
  onGroundEqSettingsChange,
}: {
  accentHex: string;
  groundEqSettings: StoredGroundEqSettings;
  onGroundEqSettingsChange: (settings: StoredGroundEqSettings) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDragging = useRef(false);
  const animationFrameRef = useRef<number | null>(null);
  const draftCurve = useRef<number[]>(groundEqSettings.curve);
  const [curve, setCurve] = useState(groundEqSettings.curve);

  useEffect(() => {
    draftCurve.current = groundEqSettings.curve;
    setCurve(groundEqSettings.curve);
  }, [groundEqSettings.curve]);

  const commitCurve = (nextCurve: number[]) => {
    draftCurve.current = nextCurve;
    setCurve(nextCurve);
    onGroundEqSettingsChange({ curve: nextCurve });
  };

  const resetCurve = () => {
    commitCurve([...defaultGroundEqCurve]);
  };

  const updateCurveFromEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const targetIndex = Math.round(x * (GROUND_EQ_POINT_COUNT - 1));
    const nextValue = Math.round((1 - y) * 100);
    const nextCurve = draftCurve.current.map((value, index) => (
      index === targetIndex ? nextValue : value
    ));
    commitCurve(nextCurve);
  };

  const bandNotes = [
    { unit: 0.00, marker: '1', short: '超低', color: '#6ee7ff', label: '超低频 / Sub Bass', target: '拖第 1 段', text: '影响中心最大块的抬升，鼓点、低沉冲击越明显，地面中间越会顶起来。' },
    { unit: 0.12, marker: '2', short: '低频', color: '#5eead4', label: '低频 / Bass', target: '拖第 2 段', text: '影响中心附近的厚重起伏，低音线和底鼓会让地面更有重量。' },
    { unit: 0.28, marker: '3', short: '低中', color: '#a7f3d0', label: '低中频 / Low Mid', target: '拖第 3 段', text: '影响大范围慢波浪，适合控制整片地形是不是跟着音乐慢慢流动。' },
    { unit: 0.42, marker: '4', short: '中频', color: '#fde68a', label: '中频 / Mid', target: '拖第 4 段', text: '影响斜向流动和地面方向感，人声、吉他、旋律主体常在这里。' },
    { unit: 0.58, marker: '5', short: '高中', color: '#fbbf24', label: '高中频 / High Mid', target: '拖第 5 段', text: '影响外围散点尖峰。想让中高频更清楚，就主要调图上的第 5 段。' },
    { unit: 0.72, marker: '6', short: '存在', color: '#fb7185', label: '存在感 / Presence', target: '拖第 6 段', text: '影响局部闪光触发感，镲片、齿音、清脆敲击会更容易冒亮点。' },
    { unit: 0.86, marker: '7', short: '亮度', color: '#c084fc', label: '亮度 / Brilliance', target: '拖第 7 段', text: '影响边缘微闪和细碎高亮，拉高会让画面边缘更亮、更碎。' },
    { unit: 1.00, marker: '8', short: '空气', color: '#93c5fd', label: '空气感 / Air', target: '拖第 8 段', text: '影响最细的高频闪烁和轻微发光颗粒，主要是最右侧的尾端。' },
  ];

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;

    const bandBounds = bandNotes.map((note, index) => {
      const previousUnit = index === 0 ? 0 : (bandNotes[index - 1].unit + note.unit) / 2;
      const nextUnit = index === bandNotes.length - 1 ? 1 : (note.unit + bandNotes[index + 1].unit) / 2;
      return { ...note, start: previousUnit, end: nextUnit };
    });

    const draw = () => {
      animationFrameRef.current = requestAnimationFrame(draw);

      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const targetWidth = Math.max(1, Math.floor(rect.width * ratio));
      const targetHeight = Math.max(1, Math.floor(rect.height * ratio));
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

      const width = rect.width;
      const height = rect.height;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(0, 0, width, height);

      bandBounds.forEach((band) => {
        const startX = band.start * width;
        const bandWidth = Math.max(1, (band.end - band.start) * width);
        ctx.fillStyle = `${band.color}14`;
        ctx.fillRect(startX, 0, bandWidth, height);
        ctx.strokeStyle = `${band.color}44`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(startX, 0);
        ctx.lineTo(startX, height);
        ctx.stroke();

        const centerX = band.unit * width;
        ctx.fillStyle = `${band.color}dd`;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(`${band.marker} ${band.short}`, centerX, 8);
      });

      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = (height / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      const spectrum = engine.getRawFrequencyData();
      const binCount = spectrum.length || 1;
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let x = 0; x <= width; x += 2) {
        const unit = width <= 0 ? 0 : x / width;
        const bin = Math.min(binCount - 1, Math.floor(unit * unit * (binCount - 1)));
        const value = spectrum[bin] / 255;
        const y = height - Math.pow(value, 0.72) * height * 0.84;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fillStyle = `${accentHex}24`;
      ctx.fill();

      ctx.beginPath();
      for (let x = 0; x <= width; x += 2) {
        const unit = width <= 0 ? 0 : x / width;
        const bin = Math.min(binCount - 1, Math.floor(unit * unit * (binCount - 1)));
        const value = spectrum[bin] / 255;
        const y = height - Math.pow(value, 0.72) * height * 0.84;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `${accentHex}70`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      const midY = height * 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.26)';
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(width, midY);
      ctx.stroke();
      ctx.setLineDash([]);

      const points = draftCurve.current.map((value, index) => ({
        x: (index / (GROUND_EQ_POINT_COUNT - 1)) * width,
        y: height - (value / 100) * height,
      }));

      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 5;
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();

      ctx.strokeStyle = accentHex;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();

      points.forEach((point, index) => {
        const unit = index / (GROUND_EQ_POINT_COUNT - 1);
        const band = bandBounds.find((item) => unit >= item.start && unit <= item.end) || bandBounds[bandBounds.length - 1];
        ctx.beginPath();
        ctx.fillStyle = band.color;
        ctx.strokeStyle = 'rgba(0,0,0,0.65)';
        ctx.lineWidth = 2;
        ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
    };

    draw();
    return () => {
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [accentHex]);

  return (
    <div className="grid gap-5">
      <div className="flex items-start justify-between gap-4 border border-white/10 bg-white/[0.03] rounded-sm p-4">
        <div>
          <div className="text-[12px] uppercase tracking-[0.18em] text-white/70 mb-2">地面 EQ 曲线</div>
          <div className="text-[11px] leading-relaxed text-white/45">中线默认，上拖更敏感，下拖更钝。它只控制地面动效，不改变音乐声音。</div>
        </div>
        <button
          onClick={resetCurve}
          className="shrink-0 px-3 py-2 rounded-sm border border-white/10 text-[10px] uppercase tracking-[0.15em] text-white/55 hover:text-white transition-colors"
        >
          恢复中线
        </button>
      </div>

      <div className="grid gap-2">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.15em] text-white/35">
          <span>更敏感</span>
          <span>实时频谱在底层，EQ 曲线在上层</span>
        </div>
        <canvas
          ref={canvasRef}
          className="h-[220px] w-full rounded-sm border border-white/10 bg-black/30 cursor-crosshair touch-none"
          onPointerDown={(event) => {
            isDragging.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            updateCurveFromEvent(event);
          }}
          onPointerMove={(event) => {
            if (!isDragging.current) return;
            updateCurveFromEvent(event);
          }}
          onPointerUp={(event) => {
            isDragging.current = false;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            isDragging.current = false;
          }}
        />
        <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.15em] text-white/35">
          <span>更钝</span>
          <span>左低频 → 右高频 · 当前均值 {Math.round(curve.reduce((sum, value) => sum + value, 0) / curve.length)}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {bandNotes.map((note) => (
          <div key={note.label} className="rounded-sm border border-white/10 bg-black/20 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-sm text-[10px] font-medium text-black" style={{ backgroundColor: note.color }}>
                  {note.marker}
                </span>
                <div className="truncate text-[12px] text-white/75">{note.label}</div>
              </div>
              <div className="text-[11px]" style={{ color: accentHex }}>{Math.round(readGroundEqCurveValue(curve, note.unit))}</div>
            </div>
            <div className="mt-2 text-[10px] leading-relaxed text-white/45">
              <span style={{ color: note.color }}>{note.target}</span>
              <span className="text-white/25"> · 曲线位置 {Math.round(note.unit * 100)}%</span>
            </div>
            <div className="mt-1 text-[10px] leading-relaxed text-white/35">{note.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CustomColorPanel({
  accentHex,
  theme,
  customThemes,
  activeCustomThemeId,
  themeRotation,
  onThemeChange,
  onCustomThemesChange,
  onThemeRotationChange,
  onEnterEditor,
}: {
  accentHex: string;
  theme: string;
  customThemes: CustomThemeSettings[];
  activeCustomThemeId: string;
  themeRotation: ThemeRotationSettings;
  onThemeChange: (theme: string) => void;
  onCustomThemesChange: (settings: CustomThemeSettings[], activeId?: string) => void;
  onThemeRotationChange: (settings: ThemeRotationSettings) => void;
  onEnterEditor?: (preset?: CustomThemeSettings) => void;
}) {
  const activePreset = customThemes.find((preset) => preset.id === activeCustomThemeId) || customThemes[0] || createCustomThemePreset();

  // ----- 构建统一的主题列表 -----
  const builtInItems = BUILT_IN_THEME_IDS.map((id) => ({
    id,
    name: themes[id]?.name || id,
    colors: [
      `#${themes[id].uBaseColor1.getHexString()}`,
      `#${themes[id].uCoolCore.getHexString()}`,
      `#${themes[id].uWarmCore.getHexString()}`,
      `#${themes[id].uRippleColor.getHexString()}`,
    ],
    isBuiltIn: true,
  }));

  const customItems = customThemes.map((preset) => ({
    id: preset.id,
    name: preset.name,
    colors: [preset.background, preset.cool, preset.warm, preset.accent],
    isBuiltIn: false,
    preset,
  }));

  const allItems = [...builtInItems, ...customItems];

  // ----- 操作函数 -----
  const switchTheme = (item: (typeof allItems)[0]) => {
    if (item.isBuiltIn) {
      onThemeChange(item.id);
    } else {
      onCustomThemesChange(customThemes, item.id);
      onThemeChange(CUSTOM_THEME_ID);
    }
  };

  const savePresets = useCallback((nextPresets: CustomThemeSettings[], nextActiveId = activePreset.id) => {
    onCustomThemesChange(nextPresets, nextActiveId);
  }, [onCustomThemesChange, activePreset.id]);

  const updateRotation = useCallback((patch: Partial<ThemeRotationSettings>) => {
    onThemeRotationChange({ ...themeRotation, ...patch });
  }, [onThemeRotationChange, themeRotation]);

  const toggleRotationTheme = (themeId: string) => {
    const isSelected = themeRotation.themeIds.includes(themeId);
    const nextIds = isSelected
      ? themeRotation.themeIds.filter((id) => id !== themeId)
      : [...themeRotation.themeIds, themeId];
    updateRotation({ themeIds: nextIds });
  };

  const addCustomTheme = () => {
    onEnterEditor?.(undefined);
  };

  const editTheme = (preset: CustomThemeSettings) => {
    onEnterEditor?.(preset);
  };

  const deleteCustomTheme = (presetId: string) => {
    if (customThemes.length <= 1) return;
    const nextPresets = customThemes.filter((preset) => preset.id !== presetId);
    const nextActiveId = activePreset.id === presetId ? nextPresets[0].id : activePreset.id;
    savePresets(nextPresets, nextActiveId);
    if (theme === CUSTOM_THEME_ID && activeCustomThemeId === presetId) {
      onThemeChange(CUSTOM_THEME_ID);
    }
  };

  const colorControls: Array<{ key: keyof Pick<CustomThemeSettings, 'background' | 'cool' | 'warm' | 'accent'>; label: string; hint: string }> = [
    { key: 'background', label: '背景色', hint: '控制页面背景、雾色和地形暗部' },
    { key: 'cool', label: '冷色', hint: '控制亮部、冷调和高频地形发光' },
    { key: 'warm', label: '暖色', hint: '控制暖调地形发光，也会影响流星颜色' },
    { key: 'accent', label: '强调色', hint: '控制按钮、歌词、进度条、脉冲波纹和设置滑块' },
  ];

  const rotationItems = allItems.map((item) => ({
    id: item.id,
    name: item.name,
    colors: item.colors,
  }));

  const isItemActive = (item: (typeof allItems)[0]) => {
    if (item.isBuiltIn) return theme === item.id;
    return theme === CUSTOM_THEME_ID && activeCustomThemeId === item.id;
  };

  return (
    <div className="grid gap-5">
      {/* ===== 主题列表 ===== */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <span className="text-[10px] uppercase tracking-[0.18em] text-white/40">选择主题</span>
          <span className="text-[10px] text-white/25">
            {allItems.length} 个 · {customThemes.length} 自定义
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {allItems.map((item) => {
            const active = isItemActive(item);
            return (
              <div
                key={item.id}
                className={`relative flex items-center gap-3 px-3 py-2 rounded-xl border transition-all cursor-pointer ${active
                  ? 'border-white/30 bg-white/10'
                  : 'border-white/10 bg-black/20 hover:bg-white/5'
                  }`}
                onClick={() => switchTheme(item)}
              >
                <div className="flex gap-0.5">
                  {item.colors.map((color, idx) => (
                    <span key={`${item.id}-color-${idx}`} className="h-5 w-3 rounded-[1px]" style={{ backgroundColor: color }} />
                  ))}
                </div>
                <span className="text-[11px] text-white/80 truncate max-w-[100px]">{item.name}</span>
                {active && (
                  <span
                    className="text-[8px] uppercase tracking-[0.14em] shrink-0"
                    style={{ color: accentHex }}
                  >
                    ●
                  </span>
                )}
                {!item.isBuiltIn && (
                  <>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        editTheme((item as typeof customItems[0]).preset);
                      }}
                      className="text-[9px] text-white/30 hover:text-white/60 transition-colors"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteCustomTheme(item.id);
                      }}
                      disabled={customThemes.length <= 1}
                      className="text-[9px] text-white/20 hover:text-[#ef4444] transition-colors disabled:opacity-30 disabled:hover:text-white/20"
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            );
          })}

          {/* 新建按钮 */}
          <button
            onClick={addCustomTheme}
            className="flex items-center gap-2 px-3 py-2 rounded-xl border border-dashed border-white/15 hover:border-white/30 transition-colors text-white/40 hover:text-white/70"
          >
            <span className="text-[16px] leading-none">+</span>
            <span className="text-[11px] uppercase tracking-[0.12em]">新建</span>
          </button>
        </div>
      </div>

      {/* ===== 自动轮换主题 ===== */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <span className="text-[12px] text-white/75">自动轮换主题</span>
            <span className="block text-[10px] text-white/30">选择参与轮换的主题，设置切换间隔</span>
          </div>
          <button
            onClick={() => updateRotation({ enabled: !themeRotation.enabled })}
            className={`px-4 py-1.5 rounded-full border text-[10px] uppercase tracking-[0.15em] transition-all ${themeRotation.enabled
              ? 'text-black border-transparent shadow-lg'
              : 'border-white/10 text-white/45 hover:text-white'
              }`}
            style={{
              backgroundColor: themeRotation.enabled ? accentHex : 'transparent',
              boxShadow: themeRotation.enabled ? `0 4px 16px ${accentHex}66` : 'none',
            }}
          >
            {themeRotation.enabled ? '已开启' : '开启轮换'}
          </button>
        </div>

        {themeRotation.enabled && (
          <div className="mt-4 space-y-3">
            <div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] text-white/50">切换间隔</span>
                <span className="text-[11px]" style={{ color: accentHex }}>{themeRotation.intervalSeconds} 秒</span>
              </div>
              <input
                type="range"
                min="3"
                max="120"
                step="1"
                value={themeRotation.intervalSeconds}
                onChange={(event) => updateRotation({ intervalSeconds: Number(event.target.value) })}
                className="mt-1 w-full accent-current h-1"
                style={{ accentColor: accentHex }}
              />
            </div>

            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[9px] uppercase tracking-[0.12em] text-white/30">参与轮换</span>
                <button
                  onClick={() => updateRotation({ themeIds: rotationItems.map((item) => item.id) })}
                  className="px-2 py-0.5 rounded-full border border-white/10 text-[7px] uppercase tracking-[0.12em] text-white/30 hover:text-white transition-colors"
                >
                  全选
                </button>
                <button
                  onClick={() => updateRotation({ themeIds: [] })}
                  className="px-2 py-0.5 rounded-full border border-white/10 text-[7px] uppercase tracking-[0.12em] text-white/30 hover:text-white transition-colors"
                >
                  清空
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {rotationItems.map((item) => {
                  const isSelected = themeRotation.themeIds.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      onClick={() => toggleRotationTheme(item.id)}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[9px] transition-all ${isSelected
                        ? 'border-white/25 bg-white/10'
                        : 'border-white/5 bg-black/20 text-white/40 hover:text-white/70'
                        }`}
                    >
                      <span className="flex gap-0.5">
                        {item.colors.slice(0, 3).map((color, idx) => (
                          <span key={`${item.id}-rotate-${idx}`} className="h-1.5 w-2.5 rounded-[1px]" style={{ backgroundColor: color }} />
                        ))}
                      </span>
                      <span className={isSelected ? 'text-white/80' : ''}>{item.name}</span>
                      <span
                        className="h-1.5 w-1.5 rounded-full border transition-colors"
                        style={{
                          borderColor: isSelected ? accentHex : 'rgba(255,255,255,0.15)',
                          backgroundColor: isSelected ? accentHex : 'transparent',
                        }}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function NeteaseCookiePanel({
  accentHex,
  neteaseCookie,
  setNeteaseCookie,
  onSaveCookie,
  onClearCookie,
  cookieStatus,
  isNeteaseCookieValid,
  isSyncingNeteaseCookie,
}: {
  accentHex: string;
  neteaseCookie: string;
  setNeteaseCookie: (cookie: string) => void;
  onSaveCookie: () => void;
  onClearCookie: () => void;
  cookieStatus: string;
  isNeteaseCookieValid: boolean;
  isSyncingNeteaseCookie: boolean;
}) {
  return (
    <div className="grid gap-5">
      <div className="border border-white/10 bg-white/[0.03] rounded-sm p-4">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <div className="text-[12px] uppercase tracking-[0.18em] text-white/70 mb-2">手动 Cookie 登录</div>
            <div className="text-[11px] leading-relaxed text-white/45">
              先在网易云官网正常登录，再从浏览器复制 Cookie。本项目不会自动读取官网 Cookie。
            </div>
          </div>
          <button
            onClick={() => window.open('https://music.163.com/', '_blank', 'noopener,noreferrer')}
            className="shrink-0 px-3 py-2 rounded-sm text-[10px] uppercase tracking-[0.15em] text-black"
            style={{ backgroundColor: accentHex }}
          >
            打开官网
          </button>
        </div>
        <ol className="grid gap-2 text-[12px] leading-relaxed text-white/55 list-decimal list-inside">
          <li>用电脑 Chrome 或 Edge 打开 music.163.com，先登录网易云账号。</li>
          <li>右键空白处，点击检查按钮</li>
          <li>点顶部的 Network/网络，刷新网易云页面或播放、搜索一首歌。</li>
          <li>在过滤输入框里搜 weapi；搜不到就改搜 music.163.com。</li>
          <li>点任意请求，在 Headers/标头里搜索 cookie。</li>
          <li>复制 Cookie: 后面的整段内容，粘贴到下面输入框，点保存 Cookie。</li>
        </ol>
        <div className="mt-3 text-[11px] leading-relaxed text-white/35">
          手机浏览器通常没有 F12/Network，复制 Cookie 建议用电脑。Cookie 只保存在当前浏览器，不能绕过版权、会员或地区限制。
        </div>
      </div>
      <div className="grid gap-2">
        <label className="text-[10px] uppercase tracking-[0.18em] text-white/45">网易云 Cookie</label>
        <textarea
          value={neteaseCookie}
          onChange={(e) => setNeteaseCookie(e.target.value)}
          spellCheck={false}
          placeholder="MUSIC_U=...; __csrf=...; NMTID=..."
          className="min-h-[180px] resize-y bg-black/40 border border-white/10 rounded-sm px-3 py-3 text-[12px] leading-relaxed text-white outline-none focus:border-white/30 font-mono"
        />
      </div>
      <div className="text-[11px] leading-relaxed text-white/45">
        可以直接粘贴多行 Cookie，保存时会自动整理成网易云接口能用的格式。
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] text-white/45">
          {isSyncingNeteaseCookie ? '正在校验 Cookie...' : (cookieStatus || (neteaseCookie.trim() ? (isNeteaseCookieValid ? 'Cookie 可用，网易云入口已开启' : '已从浏览器读取 Cookie，请点击保存进行校验') : '当前没有保存 Cookie'))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onClearCookie}
            className="px-3 py-2 rounded-sm border border-white/10 text-[10px] uppercase tracking-[0.15em] text-white/45 hover:text-white"
          >
            清除
          </button>
          <button
            onClick={onSaveCookie}
            className="px-3 py-2 rounded-sm text-[10px] uppercase tracking-[0.15em] text-black"
            style={{ backgroundColor: accentHex }}
          >
            保存 Cookie
          </button>
        </div>
      </div>
    </div>
  );
}

function FreqTriggerPanel({ action, accentHex }: { action: 'Pulse' | 'Meteor', accentHex: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const getConfig = () => action === 'Pulse' ? engine.pulseTrigger : engine.meteorTrigger;

  const [triggerPoint, setTriggerPoint] = useState({
    x: getConfig().freqIndex >= 0 ? getConfig().freqIndex / 512 : 0.5,
    y: getConfig().threshold
  });
  const [isEnabled, setIsEnabled] = useState(getConfig().enabled);
  const [mode, setMode] = useState<TriggerPreset>(getConfig().mode);
  const [sensitivity, setSensitivity] = useState(getConfig().sensitivity);
  const [cooldown, setCooldown] = useState(getConfig().cooldown);
  const [pulseStrength, setPulseStrength] = useState(getConfig().pulseStrength);
  const [bandStart, setBandStart] = useState(getConfig().bandStart);
  const [bandEnd, setBandEnd] = useState(getConfig().bandEnd);
  const isDragging = useRef(false);

  useEffect(() => {
    const c = getConfig();
    c.enabled = isEnabled;
    c.mode = mode;
    c.sensitivity = sensitivity;
    c.cooldown = cooldown;
    c.pulseStrength = pulseStrength;
    c.bandStart = bandStart;
    c.bandEnd = bandEnd;

    if (mode === 'Advanced') {
      c.freqIndex = Math.floor(triggerPoint.x * 512);
      c.threshold = triggerPoint.y;
    } else {
      c.freqIndex = -1;
    }

    writeTriggerSettingsStorage({
      Pulse: snapshotTriggerConfig(engine.pulseTrigger),
      Meteor: snapshotTriggerConfig(engine.meteorTrigger),
    });
  }, [isEnabled, mode, sensitivity, cooldown, pulseStrength, bandStart, bandEnd, triggerPoint]);

  const presets: TriggerPreset[] = ['Auto Beat', 'Advanced'];
  const modeLabels: Record<TriggerPreset, string> = {
    'Auto Beat': '自动节拍',
    Advanced: '高级模式',
  };
  const actionLabel = action === 'Pulse' ? '脉冲特效' : '流星特效';

  useEffect(() => {
    let animationId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      animationId = requestAnimationFrame(draw);
      const width = canvas.width;
      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);

      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      for (let i = 1; i < 10; i++) {
        ctx.moveTo(0, height * i / 10);
        ctx.lineTo(width, height * i / 10);
        ctx.moveTo(width * i / 10, 0);
        ctx.lineTo(width * i / 10, height);
      }
      ctx.stroke();

      const data = engine.getRawFrequencyData();
      const binCount = data.length || 512;

      const [startBin, endBin] = getConfig().getTriggerRange();
      const startX = (startBin / binCount) * width;
      const endX = (endBin / binCount) * width;

      ctx.fillStyle = mode === 'Advanced' ? 'rgba(255,255,255,0.02)' : `${accentHex}20`;
      ctx.fillRect(startX, 0, Math.max(1, endX - startX), height);

      if (mode !== 'Advanced') {
        ctx.strokeStyle = accentHex + '80';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(endX, 0);
        ctx.lineTo(endX, height);
        ctx.stroke();
      }

      ctx.fillStyle = accentHex + '40';
      ctx.beginPath();
      ctx.moveTo(0, height);

      for (let i = 0; i < binCount; i++) {
        const x = (i / binCount) * width;
        const val = data[i] / 255.0;
        const y = height - (val * height);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();

      if (mode === 'Advanced') {
        const tx = triggerPoint.x * width;
        const ty = height - (triggerPoint.y * height);

        ctx.beginPath();
        ctx.moveTo(tx, 0);
        ctx.lineTo(tx, height);
        ctx.moveTo(0, ty);
        ctx.lineTo(width, ty);
        ctx.strokeStyle = accentHex;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(tx, ty, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
      } else {
        const evE = getConfig().lastEvalEnergy;
        const evThresh = getConfig().lastEvalThresh;

        const eY = height - (evE * height);
        const tY = height - (evThresh * height);

        ctx.beginPath();
        ctx.setLineDash([5, 5]);
        ctx.moveTo(0, tY);
        ctx.lineTo(width, tY);
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.stroke();
        ctx.setLineDash([]);

        const cx = (startX + endX) / 2;
        ctx.beginPath();
        ctx.arc(cx, eY, 6, 0, Math.PI * 2);
        ctx.fillStyle = evE > evThresh ? accentHex : 'rgba(255,255,255,0.5)';
        ctx.fill();
      }
    };
    draw();
    return () => cancelAnimationFrame(animationId);
  }, [accentHex, triggerPoint, mode]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (mode !== 'Advanced') return;
    isDragging.current = true;
    updateTriggerFromEvent(e);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current || mode !== 'Advanced') return;
    updateTriggerFromEvent(e);
  };

  const handlePointerUp = () => {
    isDragging.current = false;
  };

  const updateTriggerFromEvent = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));

    setTriggerPoint({ x, y });
    const config = action === 'Meteor' ? engine.meteorTrigger : engine.pulseTrigger;
    config.freqIndex = Math.floor(x * 512);
    config.threshold = y;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="text-[12px] uppercase tracking-[0.2em] text-white/70">{actionLabel}</div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={isEnabled}
            onChange={(e) => setIsEnabled(e.target.checked)}
            className="w-4 h-4 rounded-sm border-white/20 bg-black/50"
            style={{ accentColor: accentHex }}
          />
          <span className="text-[10px] uppercase tracking-widest text-white/50">启用</span>
        </label>
      </div>

      <div className="flex gap-2 mb-4">
        {presets.map(p => (
          <button
            key={p}
            onClick={() => setMode(p)}
            className={`px-3 py-1.5 text-[10px] uppercase tracking-widest rounded-sm border transition-colors ${mode === p ? 'bg-white/10 text-white border-white/20' : 'border-transparent text-white/40 hover:text-white hover:bg-white/5'
              }`}
          >
            {modeLabels[p]}
          </button>
        ))}
      </div>

      <p className="text-[11px] text-white/40 mb-6 font-mono h-10 leading-relaxed">
        {mode === 'Advanced'
          ? '拖动十字线设置目标频率和触发阈值。频谱超过阈值时，会触发当前视觉特效。'
          : '自动节拍会比较当前频段能量和滚动平均值，能量明显抬升时触发视觉特效。'}
      </p>
      <div className={`relative w-full aspect-[2/1] bg-black/50 border border-white/5 rounded overflow-hidden ${mode === 'Advanced' ? 'cursor-crosshair' : ''}`}>
        <canvas
          ref={canvasRef}
          width={800}
          height={400}
          className="w-full h-full block"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        />
      </div>

      {mode === 'Auto Beat' && (
        <div className="mt-8 grid grid-cols-2 gap-6">
          <div className="flex flex-col gap-2">
            <div className="flex justify-between uppercase tracking-widest text-[10px] text-white/50">
              <span>灵敏度</span>
              <span style={{ color: accentHex }}>{sensitivity.toFixed(2)}</span>
            </div>
            <input type="range" min="0" max="1" step="0.05" value={sensitivity} onChange={e => setSensitivity(parseFloat(e.target.value))} className="w-full accent-current h-1" style={{ accentColor: accentHex }} />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex justify-between uppercase tracking-widest text-[10px] text-white/50">
              <span>冷却帧数</span>
              <span style={{ color: accentHex }}>{cooldown}</span>
            </div>
            <input type="range" min="0" max="300" step="1" value={cooldown} onChange={e => setCooldown(parseInt(e.target.value))} className="w-full accent-current h-1" style={{ accentColor: accentHex }} />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex justify-between uppercase tracking-widest text-[10px] text-white/50">
              <span>触发频段 ({bandStart} - {bandEnd})</span>
            </div>
            <div className="flex gap-2">
              <input type="range" min="0" max="250" step="1" value={bandStart} onChange={e => setBandStart(Math.min(parseInt(e.target.value), bandEnd - 1))} className="w-1/2 accent-current h-1" style={{ accentColor: accentHex }} />
              <input type="range" min="2" max="256" step="1" value={bandEnd} onChange={e => setBandEnd(Math.max(parseInt(e.target.value), bandStart + 1))} className="w-1/2 accent-current h-1" style={{ accentColor: accentHex }} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex justify-between uppercase tracking-widest text-[10px] text-white/50">
              <span>特效强度</span>
              <span style={{ color: accentHex }}>{pulseStrength.toFixed(2)}</span>
            </div>
            <input type="range" min="0" max="5" step="0.1" value={pulseStrength} onChange={e => setPulseStrength(parseFloat(e.target.value))} className="w-full accent-current h-1" style={{ accentColor: accentHex }} />
          </div>
        </div>
      )}
    </div>
  );
}

function StatsPanel({ accentHex }: { accentHex: string }) {
  const [data, setData] = useState({ bass: 0, mid: 0, treble: 0, energy: 0 });

  useEffect(() => {
    let animationFrameId: number;
    const poll = () => {
      setData(engine.getAudioData());
      animationFrameId = requestAnimationFrame(poll);
    };
    poll();
    return () => cancelAnimationFrame(animationFrameId);
  }, []);

  return (
    <div className="flex gap-10">
      <StatBox label="Bass" value={data.bass} accentHex={accentHex} />
      <StatBox label="Mid" value={data.mid} accentHex={accentHex} />
      <StatBox label="Treble" value={data.treble} accentHex={accentHex} />
      <StatBox label="Energy" value={data.energy} accentHex={accentHex} />
    </div>
  );
}

function StatBox({ label, value, accentHex }: { label: string, value: number, accentHex: string }) {
  const displayValue = (value * 100).toFixed(1);
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[9px] uppercase tracking-[0.15em] opacity-40">{label}</div>
      <div className="font-mono text-[14px]" style={{ color: accentHex }}>{displayValue}</div>
      <div className="w-[100px] h-[2px] relative bg-white/10">
        <div
          className="absolute h-full transition-all duration-75"
          style={{ backgroundColor: accentHex, width: `${Math.min(100, value * 100)}%`, boxShadow: `0 0 8px ${accentHex}88` }}
        />
      </div>
    </div>
  );
}