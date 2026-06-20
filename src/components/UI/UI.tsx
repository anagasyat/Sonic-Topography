import React, { useRef, useState, useEffect } from 'react';
import {
  Play, Pause, Volume2, SkipBack, SkipForward, Palette,
  Plus, ListMusic, Shuffle, Repeat, Trash2
} from 'lucide-react';
import { engine } from '../../lib/AudioEngine';
import { themes } from '../../lib/themes';
import { LyricsDisplay } from './LyricsDisplay';
import { extractLyricsFromAudio } from '../../lib/metadata';
import { TriggerPreset } from '../../lib/AudioEngine';

// ==================== API 基础地址 ====================
const DEFAULT_ONLINE_URL = 'https://your-domain-api.workers.dev';
const STORAGE_KEY_PROXY_MODE = 'sonic-proxy-mode';
const STORAGE_KEY_ONLINE_URL = 'sonic-online-url';
const STORAGE_KEY_LOCAL_PORT = 'sonic-local-port';
const DEFAULT_LOCAL_PORT = '7200';

// ==================== 类型定义 ====================
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

type PlayMode = 'sequence' | 'shuffle';

interface PendingDelete {
  type: 'song' | 'playlist';
  playlistId: string;
  songId?: number;
  label: string;
}

// ==================== 播放列表 Hook（localStorage） ====================
const PLAYLIST_STORAGE_KEY = 'sonic-topography-playlists-v1';

function createDefaultPlaylists(): SavedPlaylist[] {
  return [
    { id: 'favorites', name: 'Favorites', songs: [] },
    { id: 'visual-set', name: 'Visual Set', songs: [] },
  ];
}

function readSavedPlaylists(): SavedPlaylist[] {
  try {
    const raw = localStorage.getItem(PLAYLIST_STORAGE_KEY);
    if (!raw) return createDefaultPlaylists();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return createDefaultPlaylists();
    return parsed.map((p: any) => ({
      id: p.id,
      name: p.name,
      songs: Array.isArray(p.songs) ? p.songs : [],
    }));
  } catch {
    return createDefaultPlaylists();
  }
}

function usePlaylists() {
  const [playlists, setPlaylists] = useState<SavedPlaylist[]>(readSavedPlaylists);
  const [activePlaylistId, setActivePlaylistId] = useState('favorites');

  useEffect(() => {
    localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(playlists));
  }, [playlists]);

  const activePlaylist = playlists.find(p => p.id === activePlaylistId) || playlists[0];
  return { playlists, setPlaylists, activePlaylistId, setActivePlaylistId, activePlaylist };
}

// ==================== UI 主组件 ====================
interface UIProps {
  theme: string;
  onThemeChange: (theme: string) => void;
}

export function UI({ theme, onThemeChange }: UIProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { playlists, setPlaylists, activePlaylistId, setActivePlaylistId, activePlaylist } = usePlaylists();

  // ---------- 状态 ----------
  const [isPlaying, setIsPlaying] = useState(false);
  const [trackName, setTrackName] = useState('No track selected');
  const [lyricsText, setLyricsText] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [showFreqPanel, setShowFreqPanel] = useState(false);
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [showPlaylistPanel, setShowPlaylistPanel] = useState(false);

  const [proxyMode, setProxyMode] = useState<'online' | 'local'>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_PROXY_MODE);
    return saved === 'local' ? 'local' : 'online';
  });
  const [onlineProxyUrl, setOnlineProxyUrl] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY_ONLINE_URL);
    return saved || DEFAULT_ONLINE_URL;
  });
  const [localPort, setLocalPort] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY_LOCAL_PORT);
    return saved || DEFAULT_LOCAL_PORT;
  });
  const [showEditModal, setShowEditModal] = useState(false);
  const [editUrlInput, setEditUrlInput] = useState(onlineProxyUrl);
  const [showPortModal, setShowPortModal] = useState(false);
  const [portInput, setPortInput] = useState(localPort);

  // 计算当前 apiBase
  const apiBase = proxyMode === 'online' ? onlineProxyUrl : `http://localhost:${localPort}`;

  // 搜索
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<NeteaseSong[]>([]);
  const [searchStatus, setSearchStatus] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  // 播放队列
  const [playQueue, setPlayQueue] = useState<NeteaseSong[]>([]);
  const [currentSongId, setCurrentSongId] = useState<number | null>(null);
  const [playMode, setPlayMode] = useState<PlayMode>('sequence');
  const [songToAdd, setSongToAdd] = useState<NeteaseSong | null>(null);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  // ---------- 代理模式切换 ----------
  const toggleProxyMode = () => {
    const newMode = proxyMode === 'online' ? 'local' : 'online';
    setProxyMode(newMode);
    localStorage.setItem(STORAGE_KEY_PROXY_MODE, newMode);
    // 清空搜索和播放状态，避免数据混乱
    setSearchResults([]);
    setPlayQueue([]);
    setCurrentSongId(null);
    setLyricsText('');
  };

  const handleSaveOnlineUrl = (url: string) => {
    setOnlineProxyUrl(url);
    localStorage.setItem(STORAGE_KEY_ONLINE_URL, url);
    setEditUrlInput(url);
    setShowEditModal(false);
  };

  // ---------- 音频轮询 ----------
  useEffect(() => {
    engine.init();
    let frameId: number;
    const poll = () => {
      setIsPlaying(engine.isPlaying);
      setCurrentTime(engine.audioElement.currentTime);
      setDuration(engine.audioElement.duration || 0);
      setVolume(engine.audioElement.volume);
      setIsCapturing(engine.isCapturing);
      frameId = requestAnimationFrame(poll);
    };
    poll();
    return () => cancelAnimationFrame(frameId);
  }, []);

  // ---------- 键盘 ----------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        engine.init();
        engine.togglePlay();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ---------- 拖放 ----------
  useEffect(() => {
    const over = (e: DragEvent) => { e.preventDefault(); setIsDragging(true); };
    const leave = (e: DragEvent) => { e.preventDefault(); if (e.clientX === 0 || e.clientY === 0) setIsDragging(false); };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      processFiles(e.dataTransfer?.files || null);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  // ---------- 处理文件上传 ----------
  const processFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    let audioFile: File | null = null;
    let lrcFile: File | null = null;

    for (const file of files) {
      if (file.type.startsWith('audio/') || /\.(mp3|wav|flac)$/i.test(file.name)) {
        audioFile = file;
      } else if (file.name.endsWith('.lrc')) {
        lrcFile = file;
      }
    }

    if (lrcFile) {
      const reader = new FileReader();
      reader.onload = (e) => setLyricsText(e.target?.result as string);
      reader.readAsText(lrcFile);
    } else if (audioFile) {
      setLyricsText('');
      try {
        const extracted = await extractLyricsFromAudio(audioFile);
        if (extracted) setLyricsText(extracted);
      } catch {}
    }

    if (audioFile) {
      setTrackName(audioFile.name);
      engine.init();
      await engine.resumeContext();
      engine.loadFile(audioFile);
      engine.audioElement.onerror = (e) => {
        console.error('Audio error:', e);
        setTrackName('❌ 播放失败');
      };
      engine.audioElement.oncanplaythrough = () => engine.play();
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

  const toggleCapture = async () => {
    if (engine.isCapturing) {
      engine.stopCapture();
      setTrackName('No track selected');
    } else {
      await engine.startCapture();
      if (engine.isCapturing) setTrackName('System Audio Capture');
    }
  };

  // ---------- 搜索 ----------
  const searchNetease = async () => {
    const keywords = searchQuery.trim();
    if (!keywords) return;
    setIsSearching(true);
    setSearchStatus('Searching...');
    setSearchResults([]);

    try {
      const res = await fetch(`${apiBase}/api/netease/search?keywords=${encodeURIComponent(keywords)}`);
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      setSearchResults(data.songs || []);
      setSearchStatus(data.songs?.length ? '' : 'No playable songs found');
    } catch {
      setSearchStatus('Search failed');
    } finally {
      setIsSearching(false);
    }
  };

  // ---------- 加载网易云歌曲 ----------
  const loadNeteaseSong = async (song: NeteaseSong, queue?: NeteaseSong[]) => {
    if (queue) setPlayQueue(queue);
    setCurrentSongId(song.id);
    setTrackName(`${song.artist ? `${song.artist} - ` : ''}${song.name}`);
    setLyricsText('');
    setSearchStatus('Loading song...');

    try {
      const [urlRes, lyricRes] = await Promise.all([
        fetch(`${apiBase}/api/netease/url?id=${song.id}`),
        fetch(`${apiBase}/api/netease/lyric?id=${song.id}`),
      ]);
      const urlData = await urlRes.json();
      const lyricData = await lyricRes.json();
      const lyric = lyricData.lyric || lyricData.translatedLyric || '';
      setLyricsText(lyric);

      if (!urlData.url) {
        setSearchStatus('Song unavailable, skipping...');
        playFromQueue(1, song.id);
        return;
      }

      engine.init();
      engine.loadUrl(urlData.url);
      engine.play();
      setSearchStatus('');
      setShowSearchPanel(false);
    } catch {
      setSearchStatus('Load failed, skipping...');
      playFromQueue(1, song.id);
    }
  };

  const getCurrentQueue = () => (playQueue.length > 0 ? playQueue : activePlaylist?.songs || []);

  const playFromQueue = (direction: 1 | -1, fromSongId = currentSongId) => {
    const queue = getCurrentQueue();
    if (queue.length === 0) return;
    let nextIndex = 0;
    const currentIndex = queue.findIndex(s => s.id === fromSongId);
    if (playMode === 'shuffle' && queue.length > 1) {
      do { nextIndex = Math.floor(Math.random() * queue.length); } while (nextIndex === currentIndex);
    } else {
      nextIndex = ((currentIndex >= 0 ? currentIndex : 0) + direction + queue.length) % queue.length;
    }
    loadNeteaseSong(queue[nextIndex], queue);
  };

  // 自动下一首
  useEffect(() => {
    const ended = () => {
      const queue = getCurrentQueue();
      if (queue.length > 1) playFromQueue(1);
    };
    engine.audioElement.addEventListener('ended', ended);
    return () => engine.audioElement.removeEventListener('ended', ended);
  }, [playQueue, currentSongId, playMode, activePlaylistId, playlists]);

  // ---------- 播放列表操作 ----------
  const addSongToPlaylist = (playlistId: string, song: NeteaseSong) => {
    setPlaylists(current =>
      current.map(pl =>
        pl.id === playlistId && !pl.songs.some(s => s.id === song.id)
          ? { ...pl, songs: [...pl.songs, song] }
          : pl
      )
    );
    const plName = playlists.find(p => p.id === playlistId)?.name || 'playlist';
    setSearchStatus(`Added to ${plName}`);
    setSongToAdd(null);
  };

  const createPlaylistAndAddSong = () => {
    const name = newPlaylistName.trim();
    if (!name || !songToAdd) return;
    const id = `playlist-${Date.now()}`;
    setPlaylists(current => [...current, { id, name, songs: [songToAdd] }]);
    setActivePlaylistId(id);
    setSearchStatus(`Added to ${name}`);
    setSongToAdd(null);
    setNewPlaylistName('');
  };

  const deleteSongFromPlaylist = (playlistId: string, songId: number) => {
    setPlaylists(current =>
      current.map(pl =>
        pl.id === playlistId ? { ...pl, songs: pl.songs.filter(s => s.id !== songId) } : pl
      )
    );
    setPlayQueue(q => q.filter(s => s.id !== songId));
    if (currentSongId === songId) setCurrentSongId(null);
  };

  const deletePlaylist = (playlistId: string) => {
    if (playlists.length <= 1) return;
    const next = playlists.filter(p => p.id !== playlistId);
    setPlaylists(next);
    if (activePlaylistId === playlistId) {
      setActivePlaylistId(next[0]?.id || 'favorites');
    }
    const deleted = playlists.find(p => p.id === playlistId);
    if (deleted?.songs.some(s => s.id === currentSongId)) {
      setPlayQueue([]);
      setCurrentSongId(null);
    }
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    if (pendingDelete.type === 'song') {
      deleteSongFromPlaylist(pendingDelete.playlistId, pendingDelete.songId!);
    } else {
      deletePlaylist(pendingDelete.playlistId);
    }
    setPendingDelete(null);
  };

  const formatTime = (time: number) => {
    if (isNaN(time)) return '0:00';
    const min = Math.floor(time / 60);
    const sec = Math.floor(time % 60);
    return `${min}:${sec.toString().padStart(2, '0')}`;
  };

  const t = themes[theme] || themes['nocturnal'];
  const accentHex = `#${t.uRippleColor.getHexString()}`;

  // ==================== 渲染 ====================
  return (
    <div
      className="absolute inset-0 pointer-events-none z-10 flex w-full h-full"
      style={{ fontFamily: "'Helvetica Neue', Arial, sans-serif", color: '#94a3b8' }}
    >
      {/* 拖放遮罩 */}
      {isDragging && (
        <div
          className="absolute inset-0 z-[60] backdrop-blur-sm border-2 border-dashed m-4 rounded-xl flex items-center justify-center font-mono text-2xl tracking-widest pointer-events-none"
          style={{ backgroundColor: `${accentHex}1a`, borderColor: accentHex, color: accentHex }}
        >
          DROP AUDIO FILE TO PLAY
        </div>
      )}

      {/* 侧边栏 */}
      <Sidebar
        fileInputRef={fileInputRef}
        isCapturing={isCapturing}
        toggleCapture={toggleCapture}
        setShowFreqPanel={setShowFreqPanel}
        setShowSearchPanel={setShowSearchPanel}
        setShowPlaylistPanel={setShowPlaylistPanel}
        accentHex={accentHex}
      >
        <div className="flex flex-col items-center gap-1 mt-2">
          <button
            onClick={toggleProxyMode}
            className={`uppercase tracking-[0.2em] text-[10px] transition-opacity cursor-pointer ${proxyMode === 'online' ? 'opacity-100' : 'opacity-40 hover:opacity-100'
              }`}
            style={{ writingMode: 'vertical-rl', color: proxyMode === 'online' ? accentHex : undefined }}
          >
            Source
          </button>
          <div
            className="text-[6px] text-center leading-tight border border-orange-500/60 px-0.5 py-0.5 rounded-sm"
            style={{
              color: '#f97316',
            }}
          >
            {proxyMode === 'online' ? 'online' : 'local'}
          </div>
          {proxyMode === 'online' && (
            <button
              onClick={() => {
                setEditUrlInput(onlineProxyUrl);
                setShowEditModal(true);
              }}
              className="uppercase tracking-[0.2em] text-[8px] opacity-40 hover:opacity-100 transition-opacity cursor-pointer"
              style={{ writingMode: 'vertical-rl' }}
            >
              Edit
            </button>
          )}
          {proxyMode === 'local' && (
            <button
              onClick={() => {
                setPortInput(localPort);
                setShowPortModal(true);
              }}
              className="uppercase tracking-[0.2em] text-[8px] opacity-40 hover:opacity-100 transition-opacity cursor-pointer"
              style={{ writingMode: 'vertical-rl' }}
            >
              Edit
            </button>
          )}
        </div>
      </Sidebar>

      {/* 品牌标志 */}
      <div className="absolute top-[40px] left-[100px] font-black text-[24px] tracking-[-1px] text-white z-50 select-none">
        Yann. By AJIN.
      </div>

      {/* 搜索面板 */}
      {showSearchPanel && (
        <SearchPanel
          onClose={() => setShowSearchPanel(false)}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          searchResults={searchResults}
          searchStatus={searchStatus}
          isSearching={isSearching}
          onSearch={searchNetease}
          onLoadSong={loadNeteaseSong}
          songToAdd={songToAdd}
          setSongToAdd={setSongToAdd}
          playlists={playlists}
          onAddToPlaylist={addSongToPlaylist}
          newPlaylistName={newPlaylistName}
          setNewPlaylistName={setNewPlaylistName}
          onCreatePlaylistAndAdd={createPlaylistAndAddSong}
          currentSongId={currentSongId}
          accentHex={accentHex}
        />
      )}

      {/* 添加歌曲到播放列表的弹窗 */}
      {songToAdd && (
        <AddToPlaylistModal
          song={songToAdd}
          onClose={() => setSongToAdd(null)}
          playlists={playlists}
          onAddToPlaylist={addSongToPlaylist}
          newPlaylistName={newPlaylistName}
          setNewPlaylistName={setNewPlaylistName}
          onCreatePlaylistAndAdd={createPlaylistAndAddSong}
          accentHex={accentHex}
        />
      )}

      {/* 播放列表面板 */}
      {showPlaylistPanel && (
        <PlaylistPanel
          onClose={() => setShowPlaylistPanel(false)}
          playlists={playlists}
          activePlaylistId={activePlaylistId}
          setActivePlaylistId={setActivePlaylistId}
          onLoadSong={loadNeteaseSong}
          onDeleteSong={deleteSongFromPlaylist}
          onDeletePlaylist={deletePlaylist}
          currentSongId={currentSongId}
          setPendingDelete={setPendingDelete}
          playlistsCount={playlists.length}
          accentHex={accentHex}
        />
      )}

      {/* 确认删除弹窗 */}
      {pendingDelete && (
        <ConfirmDeleteModal
          pending={pendingDelete}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {/* 播放器控制 */}
      {trackName !== 'No track selected' && (
        <PlayerControls
          trackName={trackName}
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          volume={volume}
          setVolume={setVolume}
          togglePlay={togglePlay}
          playFromQueue={playFromQueue}
          getCurrentQueue={getCurrentQueue}
          playMode={playMode}
          setPlayMode={setPlayMode}
          theme={theme}
          onThemeChange={onThemeChange}
          isCapturing={isCapturing}
          formatTime={formatTime}
          accentHex={accentHex}
        />
      )}

      {/* 歌词显示 */}
      {trackName !== 'No track selected' && lyricsText && (
        <LyricsDisplay lrcText={lyricsText} currentTime={currentTime} accentHex={accentHex} isPlaying={isPlaying} />
      )}

      {/* 统计面板 */}
      {trackName !== 'No track selected' && (
        <div className="absolute bottom-[40px] left-[100px] z-50 pointer-events-none flex flex-col gap-6">
          {!lyricsText && (
            <div
              className="text-[10px] text-white/40 uppercase tracking-[0.2em] flex items-center gap-2 pointer-events-auto cursor-pointer hover:text-white/80 transition-colors w-fit"
              onClick={() => fileInputRef.current?.click()}
              title="Upload .lrc file"
            >
              <div className="w-1.5 h-1.5 rounded-full bg-red-500/50"></div>
              No Lyrics • Click to upload .lrc
            </div>
          )}
          <StatsPanel accentHex={accentHex} />
        </div>
      )}

      {/* 底部提示 */}
      <div className="absolute bottom-[40px] right-[40px] text-[10px] uppercase tracking-[0.1em] opacity-30 select-none">
        Drag to orbit • Click to pulse
      </div>

      {/* 频率触发面板 */}
      {showFreqPanel && (
        <FreqTriggerPanelWrapper onClose={() => setShowFreqPanel(false)} accentHex={accentHex} />
      )}

      {/* 隐藏的文件输入 */}
      <input
        type="file"
        ref={fileInputRef}
        accept="audio/*,.lrc"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {/* 编辑代理地址模态框 */}
      {showEditModal && (
        <div className="absolute inset-0 z-[200] pointer-events-auto flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[400px] border border-white/10 rounded-sm p-6" style={{ background: 'rgba(5,10,15,0.96)' }}>
            <div className="text-[12px] uppercase tracking-[0.2em] text-white/70 mb-3">编辑在线代理地址</div>
            <input
              type="text"
              value={editUrlInput}
              onChange={(e) => setEditUrlInput(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-sm px-3 py-2 text-[13px] text-white outline-none focus:border-white/30 mb-4"
              placeholder="输入代理 URL，如 https://your-worker.workers.dev"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowEditModal(false)}
                className="px-3 py-2 rounded-sm border border-white/10 text-[10px] uppercase tracking-[0.15em] text-white/45 hover:text-white"
              >
                取消
              </button>
              <button
                onClick={() => handleSaveOnlineUrl(editUrlInput)}
                className="px-3 py-2 rounded-sm border border-[#00d4ff]/40 text-[10px] uppercase tracking-[0.15em] text-[#00d4ff] hover:bg-[#00d4ff] hover:text-black"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑本地端口模态框 */}
      {showPortModal && (
        <div className="absolute inset-0 z-[200] pointer-events-auto flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[400px] border border-white/10 rounded-sm p-6" style={{ background: 'rgba(5,10,15,0.96)' }}>
            <div className="text-[12px] uppercase tracking-[0.2em] text-white/70 mb-3">编辑本地代理端口</div>
            <input
              type="text"
              value={portInput}
              onChange={(e) => setPortInput(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-sm px-3 py-2 text-[13px] text-white outline-none focus:border-white/30 mb-4"
              placeholder="例如 7200"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowPortModal(false)}
                className="px-3 py-2 rounded-sm border border-white/10 text-[10px] uppercase tracking-[0.15em] text-white/45 hover:text-white"
              >
                取消
              </button>
              <button
                onClick={() => {
                  const port = portInput.trim();
                  if (port && /^\d+$/.test(port)) {
                    setLocalPort(port);
                    localStorage.setItem(STORAGE_KEY_LOCAL_PORT, port);
                    setShowPortModal(false);
                  } else {
                    alert('请输入有效端口号');
                  }
                }}
                className="px-3 py-2 rounded-sm border border-[#00d4ff]/40 text-[10px] uppercase tracking-[0.15em] text-[#00d4ff] hover:bg-[#00d4ff] hover:text-black"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 子组件实现
// ============================================================================

// ---------- Sidebar ----------
interface SidebarProps {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  isCapturing: boolean;
  toggleCapture: () => void;
  setShowFreqPanel: (v: boolean) => void;
  setShowSearchPanel: (v: boolean) => void;
  setShowPlaylistPanel: (v: boolean) => void;
  accentHex: string;
  children?: React.ReactNode;
}

function Sidebar({
  fileInputRef,
  isCapturing,
  toggleCapture,
  setShowFreqPanel,
  setShowSearchPanel,
  setShowPlaylistPanel,
  accentHex,
  children, 
}: SidebarProps) {
  return (
    <div className="absolute left-0 top-0 h-full w-[20px] z-[60] group hover:w-[60px] transition-all pointer-events-auto">
      <aside
        className="absolute left-0 top-0 w-[60px] h-full border-r border-white/5 flex flex-col items-center py-6 pointer-events-auto -translate-x-full group-hover:translate-x-0 transition-transform duration-300"
        style={{ background: 'rgba(2,4,10,0.8)' }}
      >
        <button
          className="uppercase tracking-[0.2em] text-[10px] mb-12 opacity-100 transition-opacity cursor-pointer"
          style={{ writingMode: 'vertical-rl', color: accentHex }}
        >
          Visualizer
        </button>
        <button
          onClick={() => setShowFreqPanel(true)}
          className="uppercase tracking-[0.2em] text-[10px] mb-12 opacity-40 hover:opacity-100 transition-opacity cursor-pointer"
          style={{ writingMode: 'vertical-rl' }}
        >
          Trigger
        </button>
        <button
          onClick={() => setShowSearchPanel(true)}
          className="uppercase tracking-[0.2em] text-[10px] mb-12 opacity-40 hover:opacity-100 transition-opacity cursor-pointer"
          style={{ writingMode: 'vertical-rl' }}
        >
          Search
        </button>
        <button
          onClick={() => setShowPlaylistPanel(true)}
          className="uppercase tracking-[0.2em] text-[10px] mb-12 opacity-40 hover:opacity-100 transition-opacity cursor-pointer"
          style={{ writingMode: 'vertical-rl' }}
        >
          Playlist
        </button>

        <div className="mt-auto flex flex-col items-center gap-10">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="uppercase tracking-[0.2em] text-[10px] opacity-40 hover:opacity-100 transition-opacity cursor-pointer"
            style={{ writingMode: 'vertical-rl' }}
          >
            Upload
          </button>
          <button
            onClick={toggleCapture}
            className={`uppercase tracking-[0.2em] text-[10px] transition-opacity cursor-pointer ${
              isCapturing ? 'opacity-100 text-[#ef4444]' : 'opacity-40 hover:opacity-100'
            }`}
            style={{ writingMode: 'vertical-rl' }}
          >
            {isCapturing ? 'Stop' : 'Capture'}
          </button>
          {children}
        </div>
      </aside>
    </div>
  );
}

// ---------- SearchPanel ----------
interface SearchPanelProps {
  onClose: () => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  searchResults: NeteaseSong[];
  searchStatus: string;
  isSearching: boolean;
  onSearch: () => void;
  onLoadSong: (song: NeteaseSong, queue?: NeteaseSong[]) => void;
  songToAdd: NeteaseSong | null;
  setSongToAdd: (song: NeteaseSong | null) => void;
  playlists: SavedPlaylist[];
  onAddToPlaylist: (playlistId: string, song: NeteaseSong) => void;
  newPlaylistName: string;
  setNewPlaylistName: (name: string) => void;
  onCreatePlaylistAndAdd: () => void;
  currentSongId: number | null;
  accentHex: string;
}

function SearchPanel({
  onClose,
  searchQuery,
  setSearchQuery,
  searchResults,
  searchStatus,
  isSearching,
  onSearch,
  onLoadSong,
  songToAdd,
  setSongToAdd,
  playlists,
  onAddToPlaylist,
  newPlaylistName,
  setNewPlaylistName,
  onCreatePlaylistAndAdd,
  currentSongId,
  accentHex,
}: SearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, []);

  return (
    <div
      className="absolute top-[40px] left-[100px] w-[360px] max-h-[70vh] z-50 pointer-events-auto backdrop-blur-[20px] border border-white/10 rounded-sm overflow-hidden"
      style={{ background: 'rgba(5,10,15,0.88)' }}
    >
      <div className="p-5 border-b border-white/10">
        <div className="flex items-center justify-between mb-4">
          <div className="text-[12px] uppercase tracking-[0.2em] text-white/70">Netease Search</div>
          <button onClick={onClose} className="text-[10px] uppercase tracking-[0.15em] text-white/40 hover:text-white">Close</button>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); onSearch(); }}
        >
          <input
            ref={inputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Song or artist"
            className="min-w-0 flex-1 bg-white/5 border border-white/10 rounded-sm px-3 py-2 text-[12px] text-white outline-none focus:border-white/30"
          />
          <button
            type="submit"
            disabled={isSearching}
            className="px-3 py-2 text-[10px] uppercase tracking-[0.15em] text-black rounded-sm disabled:opacity-50"
            style={{ backgroundColor: accentHex }}
          >
            Go
          </button>
        </form>
        {searchStatus && <div className="mt-3 text-[11px] text-white/45">{searchStatus}</div>}
      </div>

      <div className="max-h-[48vh] overflow-y-auto">
        {searchResults.map((song) => (
          <button
            key={song.id}
            onClick={() => onLoadSong(song, searchResults)}
            className="relative w-full text-left px-5 py-4 pr-16 border-b border-white/5 hover:bg-white/5 transition-colors"
          >
            <div className={`text-[13px] truncate ${currentSongId === song.id ? 'text-white' : 'text-white/80'}`}>
              {song.name}
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
              className="absolute right-5 top-1/2 -translate-y-1/2 h-8 w-8 rounded-sm border border-white/10 text-white/55 hover:text-black hover:border-transparent transition-colors flex items-center justify-center"
              title="Add to playlist"
            >
              <Plus size={15} />
            </span>
            <div className="mt-1 text-[11px] text-white/45 truncate">
              {song.artist ?? 'Unknown artist'} · {song.album ?? 'Unknown album'}
            </div>
          </button>
        ))}
      </div>

      {/* 内嵌添加播放列表弹窗 */}
      {songToAdd && (
        <div
          className="absolute top-[80px] left-[20px] w-[280px] z-[70] pointer-events-auto backdrop-blur-[20px] border border-white/10 rounded-sm overflow-hidden"
          style={{ background: 'rgba(5,10,15,0.94)' }}
        >
          <div className="p-5 border-b border-white/10">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.18em] text-white/45 mb-2">Add To Playlist</div>
                <div className="text-[13px] text-white truncate" title={songToAdd.name}>{songToAdd.name}</div>
              </div>
              <button onClick={() => setSongToAdd(null)} className="text-[10px] uppercase tracking-[0.15em] text-white/40 hover:text-white">Close</button>
            </div>
          </div>
          <div className="p-3 border-b border-white/10">
            {playlists.map((playlist) => (
              <button
                key={playlist.id}
                onClick={() => onAddToPlaylist(playlist.id, songToAdd)}
                className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left hover:bg-white/5 rounded-sm transition-colors"
              >
                <span className="min-w-0 text-[12px] text-white truncate">{playlist.name}</span>
                <span className="text-[10px] text-white/35">{playlist.songs.length}</span>
              </button>
            ))}
          </div>
          <form
            className="p-4 flex gap-2"
            onSubmit={(e) => { e.preventDefault(); onCreatePlaylistAndAdd(); }}
          >
            <input
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              placeholder="New playlist"
              className="min-w-0 flex-1 bg-white/5 border border-white/10 rounded-sm px-3 py-2 text-[12px] text-white outline-none focus:border-white/30"
            />
            <button
              type="submit"
              className="h-9 w-9 flex-shrink-0 rounded-sm text-black flex items-center justify-center disabled:opacity-50"
              style={{ backgroundColor: accentHex }}
              disabled={!newPlaylistName.trim()}
              title="Create playlist"
            >
              <Plus size={15} />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

// ---------- AddToPlaylistModal ----------
interface AddToPlaylistModalProps {
  song: NeteaseSong;
  onClose: () => void;
  playlists: SavedPlaylist[];
  onAddToPlaylist: (playlistId: string, song: NeteaseSong) => void;
  newPlaylistName: string;
  setNewPlaylistName: (name: string) => void;
  onCreatePlaylistAndAdd: () => void;
  accentHex: string;
}

function AddToPlaylistModal({
  song,
  onClose,
  playlists,
  onAddToPlaylist,
  newPlaylistName,
  setNewPlaylistName,
  onCreatePlaylistAndAdd,
  accentHex,
}: AddToPlaylistModalProps) {
  return (
    <div
      className="absolute top-[120px] left-[480px] w-[280px] z-[70] pointer-events-auto backdrop-blur-[20px] border border-white/10 rounded-sm overflow-hidden"
      style={{ background: 'rgba(5,10,15,0.94)' }}
    >
      <div className="p-5 border-b border-white/10">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.18em] text-white/45 mb-2">Add To Playlist</div>
            <div className="text-[13px] text-white truncate" title={song.name}>{song.name}</div>
          </div>
          <button onClick={onClose} className="text-[10px] uppercase tracking-[0.15em] text-white/40 hover:text-white">Close</button>
        </div>
      </div>
      <div className="p-3 border-b border-white/10">
        {playlists.map((playlist) => (
          <button
            key={playlist.id}
            onClick={() => onAddToPlaylist(playlist.id, song)}
            className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left hover:bg-white/5 rounded-sm transition-colors"
          >
            <span className="min-w-0 text-[12px] text-white truncate">{playlist.name}</span>
            <span className="text-[10px] text-white/35">{playlist.songs.length}</span>
          </button>
        ))}
      </div>
      <form
        className="p-4 flex gap-2"
        onSubmit={(e) => { e.preventDefault(); onCreatePlaylistAndAdd(); }}
      >
        <input
          value={newPlaylistName}
          onChange={(e) => setNewPlaylistName(e.target.value)}
          placeholder="New playlist"
          className="min-w-0 flex-1 bg-white/5 border border-white/10 rounded-sm px-3 py-2 text-[12px] text-white outline-none focus:border-white/30"
        />
        <button
          type="submit"
          className="h-9 w-9 flex-shrink-0 rounded-sm text-black flex items-center justify-center disabled:opacity-50"
          style={{ backgroundColor: accentHex }}
          disabled={!newPlaylistName.trim()}
          title="Create playlist"
        >
          <Plus size={15} />
        </button>
      </form>
    </div>
  );
}

// ---------- PlaylistPanel ----------
interface PlaylistPanelProps {
  onClose: () => void;
  playlists: SavedPlaylist[];
  activePlaylistId: string;
  setActivePlaylistId: (id: string) => void;
  onLoadSong: (song: NeteaseSong, queue?: NeteaseSong[]) => void;
  onDeleteSong: (playlistId: string, songId: number) => void;
  onDeletePlaylist: (playlistId: string) => void;
  currentSongId: number | null;
  setPendingDelete: (pending: PendingDelete | null) => void;
  playlistsCount: number;
  accentHex: string;
}

function PlaylistPanel({
  onClose,
  playlists,
  activePlaylistId,
  setActivePlaylistId,
  onLoadSong,
  onDeleteSong,
  onDeletePlaylist,
  currentSongId,
  setPendingDelete,
  playlistsCount,
  accentHex,
}: PlaylistPanelProps) {
  const activePlaylist = playlists.find(p => p.id === activePlaylistId) || playlists[0];

  return (
    <div
      className="absolute top-[40px] left-[100px] w-[420px] max-h-[74vh] z-[65] pointer-events-auto backdrop-blur-[20px] border border-white/10 rounded-sm overflow-hidden"
      style={{ background: 'rgba(5,10,15,0.9)' }}
    >
      <div className="p-5 border-b border-white/10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3 text-[12px] uppercase tracking-[0.2em] text-white/70">
            <ListMusic size={15} />
            Playlists
          </div>
          <button onClick={onClose} className="text-[10px] uppercase tracking-[0.15em] text-white/40 hover:text-white">Close</button>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1">
            {playlists.map((playlist) => (
              <button
                key={playlist.id}
                onClick={() => setActivePlaylistId(playlist.id)}
                className={`flex-shrink-0 px-3 py-2 rounded-sm border text-[10px] uppercase tracking-[0.12em] transition-colors ${
                  activePlaylist?.id === playlist.id
                    ? 'text-black border-transparent'
                    : 'text-white/45 border-white/10 hover:text-white'
                }`}
                style={{
                  backgroundColor: activePlaylist?.id === playlist.id ? accentHex : 'transparent',
                }}
              >
                {playlist.name}
              </button>
            ))}
          </div>
          <button
            onClick={() => {
              if (activePlaylist) {
                setPendingDelete({
                  type: 'playlist',
                  playlistId: activePlaylist.id,
                  label: activePlaylist.name,
                });
              }
            }}
            disabled={!activePlaylist || playlistsCount <= 1}
            className="h-8 w-8 flex-shrink-0 rounded-sm border border-white/10 text-white/45 hover:text-[#ef4444] disabled:opacity-20 disabled:hover:text-white/45 flex items-center justify-center"
            title="Delete playlist"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="max-h-[52vh] overflow-y-auto">
        {activePlaylist && activePlaylist.songs.length > 0 ? (
          activePlaylist.songs.map((song) => (
            <button
              key={song.id}
              onClick={() => onLoadSong(song, activePlaylist.songs)}
              className="relative w-full text-left px-5 py-4 pr-16 border-b border-white/5 hover:bg-white/5 transition-colors"
            >
              <div className="text-[13px] text-white truncate">{song.name}</div>
              <div className="mt-1 text-[11px] text-white/45 truncate">
                {song.artist ?? 'Unknown artist'} - {song.album ?? 'Unknown album'}
              </div>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDelete({
                    type: 'song',
                    playlistId: activePlaylist.id,
                    songId: song.id,
                    label: song.name,
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    setPendingDelete({
                      type: 'song',
                      playlistId: activePlaylist.id,
                      songId: song.id,
                      label: song.name,
                    });
                  }
                }}
                className="absolute right-5 top-1/2 -translate-y-1/2 h-8 w-8 rounded-sm border border-white/10 text-white/45 hover:text-[#ef4444] transition-colors flex items-center justify-center"
                title="Remove from playlist"
              >
                <Trash2 size={14} />
              </span>
            </button>
          ))
        ) : (
          <div className="px-5 py-8 text-[12px] text-white/40">No songs in this playlist yet</div>
        )}
      </div>
    </div>
  );
}

// ---------- ConfirmDeleteModal ----------
interface ConfirmDeleteModalProps {
  pending: PendingDelete | null;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDeleteModal({ pending, onConfirm, onCancel }: ConfirmDeleteModalProps) {
  if (!pending) return null;

  return (
    <div className="absolute inset-0 z-[120] pointer-events-auto flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[320px] border border-white/10 rounded-sm p-5" style={{ background: 'rgba(5,10,15,0.96)' }}>
        <div className="text-[12px] uppercase tracking-[0.2em] text-white/70 mb-3">Confirm Delete</div>
        <div className="text-[13px] text-white/80 leading-relaxed mb-5">
          Delete {pending.type === 'playlist' ? 'playlist' : 'song'}{' '}
          <span className="text-white">{pending.label}</span>?
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-2 rounded-sm border border-white/10 text-[10px] uppercase tracking-[0.15em] text-white/45 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-2 rounded-sm border border-[#ef4444]/40 text-[10px] uppercase tracking-[0.15em] text-[#ef4444] hover:bg-[#ef4444] hover:text-black"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- PlayerControls ----------
interface PlayerControlsProps {
  trackName: string;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  setVolume: (v: number) => void;
  togglePlay: () => void;
  playFromQueue: (direction: 1 | -1) => void;
  getCurrentQueue: () => NeteaseSong[];
  playMode: PlayMode;
  setPlayMode: (mode: PlayMode) => void;
  theme: string;
  onThemeChange: (theme: string) => void;
  isCapturing: boolean;
  formatTime: (time: number) => string;
  accentHex: string;
}

function PlayerControls({
  trackName,
  isPlaying,
  currentTime,
  duration,
  volume,
  setVolume,
  togglePlay,
  playFromQueue,
  getCurrentQueue,
  playMode,
  setPlayMode,
  theme,
  onThemeChange,
  isCapturing,
  formatTime,
  accentHex,
}: PlayerControlsProps) {
  const queue = getCurrentQueue();
  const hasQueue = queue.length > 0;

  return (
    <div
      className="absolute top-[40px] right-[40px] w-[300px] p-6 rounded-sm z-50 pointer-events-auto backdrop-blur-[20px] border border-white/10"
      style={{ background: 'rgba(255,255,255,0.03)' }}
    >
      <div className="flex justify-between items-start mb-1">
        <div className="text-[18px] font-light tracking-[0.05em] text-white truncate" title={trackName}>
          {trackName}
        </div>
        <button
          onClick={() => {
            const keys = Object.keys(themes);
            const next = (keys.indexOf(theme) + 1) % keys.length;
            onThemeChange(keys[next]);
          }}
          className="text-white/40 hover:text-white transition-colors"
          title="Change Theme"
        >
          <Palette size={16} />
        </button>
      </div>
      <div className="text-[12px] opacity-50 uppercase mb-6 tracking-wider">
        {isCapturing ? 'System Audio Capture' : 'Local Audio'}
        <span className="ml-2 text-[#3b82f6] text-[10px]">&bull; {themes[theme]?.name}</span>
      </div>

      {/* 进度条 */}
      <div className={`h-[20px] mb-5 relative flex items-end group ${isCapturing ? 'opacity-30 pointer-events-none' : ''}`}>
        <div className="w-full relative h-[2px] bg-white/10 group-hover:h-[4px] transition-all">
          <div
            className="absolute top-0 left-0 h-full"
            style={{
              backgroundColor: accentHex,
              width: `${duration ? (currentTime / duration) * 100 : 0}%`,
              boxShadow: `0 0 10px ${accentHex}88`,
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
            const val = parseFloat(e.target.value);
            if (engine.audioElement) engine.audioElement.currentTime = val;
          }}
          className="absolute bottom-0 left-0 w-full opacity-0 cursor-pointer h-full"
        />
      </div>

      <div className={`flex justify-between items-center text-[10px] uppercase tracking-[0.1em] opacity-80 ${isCapturing ? 'opacity-30 pointer-events-none' : ''}`}>
        <span className="w-8">{formatTime(currentTime)}</span>

        <div className="flex items-center gap-4">
          <button
            onClick={() => playFromQueue(-1)}
            disabled={!hasQueue}
            className="hover:text-white transition-colors disabled:opacity-25 disabled:hover:text-inherit"
            title="Previous"
          >
            <SkipBack size={14} />
          </button>
          <button onClick={togglePlay} className="hover:text-white transition-colors">
            {isPlaying ? <Pause size={14} className="fill-current" /> : <Play size={14} className="fill-current" />}
          </button>
          <button
            onClick={() => playFromQueue(1)}
            disabled={!hasQueue}
            className="hover:text-white transition-colors disabled:opacity-25 disabled:hover:text-inherit"
            title="Next"
          >
            <SkipForward size={14} />
          </button>
          <button
            onClick={() => setPlayMode(playMode === 'sequence' ? 'shuffle' : 'sequence')}
            className="hover:text-white transition-colors"
            title={playMode === 'sequence' ? 'Sequence play' : 'Shuffle play'}
            style={{ color: playMode === 'shuffle' ? accentHex : undefined }}
          >
            {playMode === 'sequence' ? <Repeat size={14} /> : <Shuffle size={14} />}
          </button>
        </div>

        <div className="flex items-center gap-2 group w-20 justify-end">
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
            className="w-12 h-1 accent-current opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer appearance-none rounded-full bg-white/20"
            style={{ accentColor: accentHex }}
          />
          <Volume2
            size={12}
            className="opacity-50 hover:opacity-100 transition-opacity cursor-pointer flex-shrink-0"
            onClick={() => {
              const val = volume > 0 ? 0 : 1;
              engine.audioElement.volume = val;
              setVolume(val);
            }}
          />
        </div>

        <span className="w-8 text-right">{formatTime(duration)}</span>
      </div>
    </div>
  );
}

// ---------- StatsPanel ----------
interface StatsPanelProps {
  accentHex: string;
}

function StatsPanel({ accentHex }: StatsPanelProps) {
  const [data, setData] = useState({ bass: 0, mid: 0, treble: 0, energy: 0 });

  useEffect(() => {
    let frameId: number;
    const poll = () => {
      const d = engine.getAudioData();
      setData({ bass: d.bass, mid: d.mid, treble: d.treble, energy: d.energy });
      frameId = requestAnimationFrame(poll);
    };
    poll();
    return () => cancelAnimationFrame(frameId);
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

function StatBox({ label, value, accentHex }: { label: string; value: number; accentHex: string }) {
  const display = (value * 100).toFixed(1);
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[9px] uppercase tracking-[0.15em] opacity-40">{label}</div>
      <div className="font-mono text-[14px]" style={{ color: accentHex }}>{display}</div>
      <div className="w-[100px] h-[2px] relative bg-white/10">
        <div
          className="absolute h-full transition-all duration-75"
          style={{
            backgroundColor: accentHex,
            width: `${Math.min(100, value * 100)}%`,
            boxShadow: `0 0 8px ${accentHex}88`,
          }}
        />
      </div>
    </div>
  );
}

// ---------- FreqTriggerPanelWrapper ----------
interface FreqTriggerPanelWrapperProps {
  onClose: () => void;
  accentHex: string;
}

function FreqTriggerPanelWrapper({ onClose, accentHex }: FreqTriggerPanelWrapperProps) {
  const [action, setAction] = useState<'Pulse' | 'Meteor'>('Meteor');
  return (
    <FreqTriggerPanel
      key={action}
      action={action}
      setAction={setAction}
      onClose={onClose}
      accentHex={accentHex}
    />
  );
}

// ---------- FreqTriggerPanel ----------
interface FreqTriggerPanelProps {
  action: 'Pulse' | 'Meteor';
  setAction: (a: 'Pulse' | 'Meteor') => void;
  onClose: () => void;
  accentHex: string;
}

function FreqTriggerPanel({ action, setAction, onClose, accentHex }: FreqTriggerPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const getConfig = () => action === 'Pulse' ? engine.pulseTrigger : engine.meteorTrigger;

  const [triggerPoint, setTriggerPoint] = useState({
    x: getConfig().freqIndex >= 0 ? getConfig().freqIndex / 512 : 0.5,
    y: getConfig().threshold,
  });
  const [isEnabled, setIsEnabled] = useState(getConfig().enabled);
  const [mode, setMode] = useState<TriggerPreset>(getConfig().mode);
  const [sensitivity, setSensitivity] = useState(getConfig().sensitivity);
  const [cooldown, setCooldown] = useState(getConfig().cooldown);
  const [pulseStrength, setPulseStrength] = useState(getConfig().pulseStrength);
  const [bandStart, setBandStart] = useState(getConfig().bandStart);
  const [bandEnd, setBandEnd] = useState(getConfig().bandEnd);
  const isDragging = useRef(false);

  // 同步到引擎
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
  }, [isEnabled, mode, sensitivity, cooldown, pulseStrength, bandStart, bandEnd, triggerPoint]);

  const presets: TriggerPreset[] = ['Auto Beat', 'Advanced'];

  // 绘制频谱
  useEffect(() => {
    let frameId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      frameId = requestAnimationFrame(draw);
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      // 网格
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      for (let i = 1; i < 10; i++) {
        ctx.moveTo(0, (height * i) / 10);
        ctx.lineTo(width, (height * i) / 10);
        ctx.moveTo((width * i) / 10, 0);
        ctx.lineTo((width * i) / 10, height);
      }
      ctx.stroke();

      const data = engine.getRawFrequencyData();
      const binCount = data.length || 512;
      const [startBin, endBin] = getConfig().getTriggerRange();
      const startX = (startBin / binCount) * width;
      const endX = (endBin / binCount) * width;

      // 高亮波段
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

      // 频谱
      ctx.fillStyle = accentHex + '40';
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let i = 0; i < binCount; i++) {
        const x = (i / binCount) * width;
        const val = data[i] / 255.0;
        const y = height - val * height;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();

      if (mode === 'Advanced') {
        const tx = triggerPoint.x * width;
        const ty = height - triggerPoint.y * height;
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
        const eY = height - evE * height;
        const tY = height - evThresh * height;
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
    return () => cancelAnimationFrame(frameId);
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
    const config = getConfig();
    config.freqIndex = Math.floor(x * 512);
    config.threshold = y;
  };

  return (
    <div className="absolute inset-0 z-[100] backdrop-blur-md bg-black/50 flex flex-col items-center justify-center pointer-events-auto">
      <div
        className="w-[80vw] max-w-[800px] border border-white/10 rounded-xl p-8 transform transition-all shadow-2xl"
        style={{ background: 'rgba(5, 10, 15, 0.95)' }}
      >
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-6">
            <h2 className="text-xl font-light tracking-widest text-white">FREQUENCY TRIGGER</h2>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isEnabled}
                  onChange={(e) => setIsEnabled(e.target.checked)}
                  className="w-4 h-4 rounded-sm border-white/20 bg-black/50"
                  style={{ accentColor: accentHex }}
                />
                <span className="text-[10px] uppercase tracking-widest text-white/50">Enable</span>
              </label>

              {isEnabled && (
                <div className="flex items-center rounded overflow-hidden border border-white/10 text-[10px] uppercase tracking-widest">
                  <button
                    onClick={() => setAction('Pulse')}
                    className={`px-3 py-1 transition-colors ${
                      action === 'Pulse' ? 'text-black' : 'text-white/50 hover:bg-white/5'
                    }`}
                    style={{ backgroundColor: action === 'Pulse' ? accentHex : 'transparent' }}
                  >
                    Pulse
                  </button>
                  <button
                    onClick={() => setAction('Meteor')}
                    className={`px-3 py-1 transition-colors ${
                      action === 'Meteor' ? 'text-black' : 'text-white/50 hover:bg-white/5'
                    }`}
                    style={{ backgroundColor: action === 'Meteor' ? accentHex : 'transparent' }}
                  >
                    Meteor
                  </button>
                </div>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-white/50 hover:text-white uppercase tracking-widest text-[10px]">Close</button>
        </div>

        <div className="flex gap-2 mb-4">
          {presets.map((p) => (
            <button
              key={p}
              onClick={() => setMode(p)}
              className={`px-3 py-1.5 text-[10px] uppercase tracking-widest rounded-sm border transition-colors ${
                mode === p
                  ? 'bg-white/10 text-white border-white/20'
                  : 'border-transparent text-white/40 hover:text-white hover:bg-white/5'
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        <p className="text-[11px] text-white/40 mb-6 font-mono h-10 leading-relaxed">
          {mode === 'Advanced'
            ? 'Drag the crosshair to set the target frequency (X) and threshold (Y).\nWhen the spectrum exceeds this threshold, a visual pulse is triggered.'
            : `Dynamic ${mode} detection enabled. Pulses trigger when instantaneous energy significantly exceeds the rolling average of this specific frequency band.`}
        </p>

        <div
          className={`relative w-full aspect-[2/1] bg-black/50 border border-white/5 rounded overflow-hidden ${
            mode === 'Advanced' ? 'cursor-crosshair' : ''
          }`}
        >
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
                <span>Sensitivity</span>
                <span style={{ color: accentHex }}>{sensitivity.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={sensitivity}
                onChange={(e) => setSensitivity(parseFloat(e.target.value))}
                className="w-full accent-current h-1"
                style={{ accentColor: accentHex }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex justify-between uppercase tracking-widest text-[10px] text-white/50">
                <span>Cooldown (frames)</span>
                <span style={{ color: accentHex }}>{cooldown}</span>
              </div>
              <input
                type="range"
                min="0"
                max="300"
                step="1"
                value={cooldown}
                onChange={(e) => setCooldown(parseInt(e.target.value))}
                className="w-full accent-current h-1"
                style={{ accentColor: accentHex }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex justify-between uppercase tracking-widest text-[10px] text-white/50">
                <span>Freq Band ({bandStart} - {bandEnd})</span>
              </div>
              <div className="flex gap-2">
                <input
                  type="range"
                  min="0"
                  max="250"
                  step="1"
                  value={bandStart}
                  onChange={(e) => setBandStart(Math.min(parseInt(e.target.value), bandEnd - 1))}
                  className="w-1/2 accent-current h-1"
                  style={{ accentColor: accentHex }}
                />
                <input
                  type="range"
                  min="2"
                  max="256"
                  step="1"
                  value={bandEnd}
                  onChange={(e) => setBandEnd(Math.max(parseInt(e.target.value), bandStart + 1))}
                  className="w-1/2 accent-current h-1"
                  style={{ accentColor: accentHex }}
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex justify-between uppercase tracking-widest text-[10px] text-white/50">
                <span>Pulse Strength</span>
                <span style={{ color: accentHex }}>{pulseStrength.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min="0"
                max="5"
                step="0.1"
                value={pulseStrength}
                onChange={(e) => setPulseStrength(parseFloat(e.target.value))}
                className="w-full accent-current h-1"
                style={{ accentColor: accentHex }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}