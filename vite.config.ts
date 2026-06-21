import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs/promises';
import path from 'path';
import { defineConfig } from 'vite';

const neteaseHeaders = {
  Referer: 'https://music.163.com/',
  'User-Agent': 'Mozilla/5.0',
};

const playableUrlCache = new Map<string, { url: string | null; expiresAt: number }>();
const searchCache = new Map<string, { songs: any[]; expiresAt: number }>();
const playableUrlCacheTtl = 1000 * 60 * 10;
const searchCacheTtl = 1000 * 60 * 5;
const dataDir = path.resolve(__dirname, 'data');
const playlistsPath = path.join(dataDir, 'playlists.json');

// ---------- 统一响应工具（已内置 CORS 头） ----------
function writeJson(res: any, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // ====== 添加 CORS 头 ======
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.end(JSON.stringify(data));
}

// ---------- 辅助函数 ----------
function createDefaultPlaylists() {
  return [
    { id: 'favorites', name: 'Favorites', songs: [] },
    { id: 'visual-set', name: 'Visual Set', songs: [] },
  ];
}

function normalizePlaylists(value: any) {
  if (!Array.isArray(value) || value.length === 0) return createDefaultPlaylists();
  return value.map((playlist: any) => ({
    id: String(playlist.id || `playlist-${Date.now()}`),
    name: String(playlist.name || 'Playlist'),
    songs: Array.isArray(playlist.songs) ? playlist.songs : [],
  }));
}

async function readPlaylistsFile() {
  try {
    const raw = await fs.readFile(playlistsPath, 'utf8');
    return normalizePlaylists(JSON.parse(raw));
  } catch (error) {
    return createDefaultPlaylists();
  }
}

async function writePlaylistsFile(playlists: any) {
  await fs.mkdir(dataDir, { recursive: true });
  const normalized = normalizePlaylists(playlists);
  await fs.writeFile(playlistsPath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

async function readRequestBody(req: any): Promise<string> {
  return await new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function getNeteasePlayableUrl(id: string) {
  const cached = playableUrlCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const url = `https://music.163.com/api/song/enhance/player/url?id=${encodeURIComponent(id)}&ids=%5B${encodeURIComponent(id)}%5D&br=320000`;
  const response = await fetch(url, { headers: neteaseHeaders });
  const data = await response.json() as any;
  const playableUrl = data?.data?.[0]?.url || null;
  playableUrlCache.set(id, { url: playableUrl, expiresAt: Date.now() + playableUrlCacheTtl });
  return playableUrl;
}

async function filterPlayableSongs(rawSongs: any[], resultLimit: number) {
  const playableSongs: any[] = [];
  const batchSize = 8;

  for (let i = 0; i < rawSongs.length && playableSongs.length < resultLimit; i += batchSize) {
    const batch = rawSongs.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (song) => ({
      song,
      playableUrl: await getNeteasePlayableUrl(String(song.id)),
    })));

    for (const result of results) {
      if (result.playableUrl) playableSongs.push(result.song);
      if (playableSongs.length >= resultLimit) break;
    }
  }

  return playableSongs;
}

// ---------- Vite 插件（含 CORS 中间件） ----------
function neteaseApiPlugin() {
  return {
    name: 'netease-api-proxy',
    configureServer(server: any) {
      // ====== 全局 CORS 中间件（作用于所有 /api 请求） ======
      server.middlewares.use('/api', (req: any, res: any, next: any) => {
        // 设置 CORS 头（对所有 /api 下的请求生效）
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

        // 处理预检 OPTIONS 请求
        if (req.method === 'OPTIONS') {
          res.statusCode = 200;
          res.end();
          return;
        }

        next();
      });

      // ---------- 路由定义 ----------
      server.middlewares.use('/api/playlists', async (req: any, res: any, next: any) => {
        try {
          if (req.method === 'GET') {
            writeJson(res, 200, { playlists: await readPlaylistsFile() });
            return;
          }

          if (req.method === 'PUT') {
            const body = await readRequestBody(req);
            const parsed = body ? JSON.parse(body) : {};
            const playlists = await writePlaylistsFile(parsed.playlists);
            writeJson(res, 200, { playlists });
            return;
          }
        } catch (error) {
          writeJson(res, 500, { error: 'Unable to save playlists' });
          return;
        }

        next();
      });

      server.middlewares.use('/api/netease/search', async (req: any, res: any) => {
        try {
          const requestUrl = new URL(req.url || '', 'http://localhost');
          const keywords = requestUrl.searchParams.get('keywords')?.trim();
          const requestedLimit = Number(requestUrl.searchParams.get('limit') || '12');
          const resultLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 20)) : 12;

          if (!keywords) {
            writeJson(res, 400, { error: 'Missing keywords' });
            return;
          }

          const cacheKey = `${keywords.toLowerCase()}::${resultLimit}`;
          const cached = searchCache.get(cacheKey);
          if (cached && cached.expiresAt > Date.now()) {
            writeJson(res, 200, { songs: cached.songs, cached: true });
            return;
          }

          const body = new URLSearchParams({
            s: keywords,
            type: '1',
            offset: '0',
            total: 'true',
            limit: String(Math.min(resultLimit * 3, 60)),
          });

          const response = await fetch('https://music.163.com/api/search/get/web', {
            method: 'POST',
            headers: {
              ...neteaseHeaders,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
          });
          const data = await response.json() as any;
          const rawSongs = (data?.result?.songs || []).map((song: any) => ({
            id: song.id,
            name: song.name,
            artist: (song.artists || []).map((artist: any) => artist.name).filter(Boolean).join(' / '),
            album: song.album?.name || '',
            duration: song.duration || 0,
            fee: song.fee,
          }));
          const songs = await filterPlayableSongs(rawSongs, resultLimit);
          searchCache.set(cacheKey, { songs, expiresAt: Date.now() + searchCacheTtl });

          writeJson(res, 200, { songs });
        } catch (error) {
          writeJson(res, 500, { error: 'Netease search failed' });
        }
      });

      server.middlewares.use('/api/netease/lyric', async (req: any, res: any) => {
        try {
          const requestUrl = new URL(req.url || '', 'http://localhost');
          const id = requestUrl.searchParams.get('id');

          if (!id) {
            writeJson(res, 400, { error: 'Missing id' });
            return;
          }

          const response = await fetch(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=-1&kv=-1&tv=-1`, {
            headers: neteaseHeaders,
          });
          const data = await response.json() as any;
          writeJson(res, 200, {
            lyric: data?.lrc?.lyric || '',
            translatedLyric: data?.tlyric?.lyric || '',
          });
        } catch (error) {
          writeJson(res, 500, { error: 'Netease lyric failed' });
        }
      });

      server.middlewares.use('/api/netease/url', async (req: any, res: any) => {
        try {
          const requestUrl = new URL(req.url || '', 'http://localhost');
          const id = requestUrl.searchParams.get('id');

          if (!id) {
            writeJson(res, 400, { error: 'Missing id' });
            return;
          }

          writeJson(res, 200, { url: await getNeteasePlayableUrl(id) });
        } catch (error) {
          writeJson(res, 500, { error: 'Netease url failed' });
        }
      });

      server.middlewares.use('/api/netease/audio', async (req: any, res: any) => {
        try {
          const requestUrl = new URL(req.url || '', 'http://localhost');
          const id = requestUrl.searchParams.get('id');

          if (!id) {
            writeJson(res, 400, { error: 'Missing id' });
            return;
          }

          const playableUrl = await getNeteasePlayableUrl(id);
          if (!playableUrl) {
            writeJson(res, 404, { error: 'No playable url for this song' });
            return;
          }

          const headers: Record<string, string> = { ...neteaseHeaders };
          if (req.headers.range) headers.Range = req.headers.range;

          const audioResponse = await fetch(playableUrl, { headers });
          res.statusCode = audioResponse.status;
          ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((header) => {
            const value = audioResponse.headers.get(header);
            if (value) res.setHeader(header, value);
          });

          // 音频响应也要加上 CORS 头（确保跨域加载）
          res.setHeader('Access-Control-Allow-Origin', '*');

          if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'audio/mpeg');
          if (audioResponse.body) {
            const reader = audioResponse.body.getReader();
            const pump = async () => {
              const { done, value } = await reader.read();
              if (done) {
                res.end();
                return;
              }
              res.write(Buffer.from(value));
              pump();
            };
            pump();
          } else {
            res.end();
          }
        } catch (error) {
          writeJson(res, 500, { error: 'Netease audio proxy failed' });
        }
      });
    },
  };
}

// ---------- Vite 配置 ----------
export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), neteaseApiPlugin()],
    base: './',
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});