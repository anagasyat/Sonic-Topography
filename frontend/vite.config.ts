import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs/promises';
import path from 'path';
import {defineConfig} from 'vite';
import { NETEASE_COOKIE_HEADER, normalizeNeteaseCookie } from './src/lib/neteaseCookie';

const neteaseHeaders = {
  Referer: 'https://music.163.com/',
  'User-Agent': 'Mozilla/5.0',
  Accept: 'application/json, text/plain, */*',
  Connection: 'close',
};

const playableUrlCache = new Map<string, { url: string | null; expiresAt: number }>();
const searchCache = new Map<string, { payload: { songs: any[]; rawCount: number; filteredCount: number }; expiresAt: number }>();
const playableUrlCacheTtl = 1000 * 60 * 10;
const searchCacheTtl = 1000 * 60 * 5;
const dataDir = path.resolve(__dirname, 'data');
const playlistsPath = path.join(dataDir, 'playlists.json');
let browserNeteaseCookie = '';

function writeJson(res: any, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

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

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url: string | URL, options: RequestInit = {}, retries = 2) {
  let lastData: any = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, options);
    const data = await response.json() as any;
    lastData = data;
    if (response.ok && data?.code !== 400) return data;
    if (attempt < retries) await wait(180 * (attempt + 1));
  }
  return lastData || {};
}

async function getNeteasePlayableUrlWithCookie(id: string, cookie: string) {
  const normalizedCookie = normalizeNeteaseCookie(cookie);
  const cacheKey = `${id}::${normalizedCookie}`;
  const cached = playableUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const url = `https://music.163.com/api/song/enhance/player/url?id=${encodeURIComponent(id)}&ids=%5B${encodeURIComponent(id)}%5D&br=320000`;
  const data = await fetchJsonWithRetry(url, { headers: createNeteaseHeaders(normalizedCookie) });
  const playableUrl = data?.data?.[0]?.url || null;
  playableUrlCache.set(cacheKey, { url: playableUrl, expiresAt: Date.now() + playableUrlCacheTtl });
  return playableUrl;
}

function mapNeteaseSong(song: any) {
  const artists = song.artists || song.ar || [];
  const album = song.album || song.al || {};
  return {
    id: song.id,
    name: song.name,
    artist: artists.map((artist: any) => artist.name).filter(Boolean).join(' / '),
    album: album?.name || '',
    duration: song.duration || song.dt || 0,
    fee: song.fee,
  };
}

async function fetchNeteaseSearchSongs(keywords: string, resultLimit: number, cookie: string) {
  const upstreamLimit = Math.min(resultLimit * 5, 80);
  const body = new URLSearchParams({
    s: keywords,
    type: '1',
    offset: '0',
    total: 'true',
    limit: String(upstreamLimit),
    _: String(Date.now()),
  });

  const data = await fetchJsonWithRetry('https://music.163.com/api/search/get/web', {
    method: 'POST',
    headers: createNeteaseHeaders(cookie, {
      'Content-Type': 'application/x-www-form-urlencoded',
    }),
    body,
  });
  const primarySongs = data?.result?.songs || [];

  const fallbackUrl = new URL('https://music.163.com/api/cloudsearch/pc');
  fallbackUrl.searchParams.set('s', keywords);
  fallbackUrl.searchParams.set('type', '1');
  fallbackUrl.searchParams.set('offset', '0');
  fallbackUrl.searchParams.set('total', 'true');
  fallbackUrl.searchParams.set('limit', String(upstreamLimit));
  fallbackUrl.searchParams.set('_', String(Date.now()));
  const fallbackData = await fetchJsonWithRetry(fallbackUrl, {
    headers: createNeteaseHeaders(cookie),
  });
  const fallbackSongs = fallbackData?.result?.songs || [];
  const songsById = new Map();
  for (const song of [...primarySongs, ...fallbackSongs]) {
    if (song?.id && !songsById.has(song.id)) songsById.set(song.id, song);
  }
  return {
    songs: [...songsById.values()],
    debug: {
      primaryCode: data?.code,
      primaryCount: primarySongs.length,
      fallbackCode: fallbackData?.code,
      fallbackCount: fallbackSongs.length,
    },
  };
}

async function fetchAnonymousNeteaseSearchSongs(keywords: string, resultLimit: number) {
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
  return data?.result?.songs || [];
}

function readNeteaseCookie(req: any) {
  const raw = req.headers?.[NETEASE_COOKIE_HEADER.toLowerCase()];
  const headerCookie = Array.isArray(raw) ? raw[0] : String(raw || '');
  return normalizeNeteaseCookie(headerCookie || browserNeteaseCookie);
}

function createNeteaseHeaders(cookie: string, extraHeaders: Record<string, string> = {}) {
  const normalizedCookie = normalizeNeteaseCookie(cookie);
  return {
    ...neteaseHeaders,
    ...(normalizedCookie ? { Cookie: normalizedCookie } : {}),
    ...extraHeaders,
  };
}


async function validateNeteaseCookie(cookie: string) {
  const account = await getNeteaseAccount(cookie);
  return account.valid;
}

async function getNeteaseAccount(cookie: string) {
  const normalizedCookie = normalizeNeteaseCookie(cookie);
  if (!normalizedCookie) return { valid: false, userId: null, nickname: '' };

  const response = await fetch('https://music.163.com/api/nuser/account/get', {
    headers: createNeteaseHeaders(normalizedCookie),
  });
  const data = await response.json() as any;
  const userId = data?.profile?.userId || data?.account?.id || null;
  return {
    valid: Boolean(userId),
    userId,
    nickname: data?.profile?.nickname || '',
  };
}


async function filterPlayableSongs(rawSongs: any[], resultLimit: number, cookie: string) {
  const playableSongs: any[] = [];
  const batchSize = 8;

  for (let i = 0; i < rawSongs.length && playableSongs.length < resultLimit; i += batchSize) {
    const batch = rawSongs.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (song) => ({
      song,
      playableUrl: await getNeteasePlayableUrlWithCookie(String(song.id), cookie),
    })));

    for (const result of results) {
      if (result.playableUrl) playableSongs.push(result.song);
      if (playableSongs.length >= resultLimit) break;
    }
  }

  return playableSongs;
}

async function getDailyRecommendSongs(cookie: string, resultLimit: number) {
  const normalizedCookie = normalizeNeteaseCookie(cookie);
  if (!normalizedCookie) return { valid: false, songs: [] };
  const validCookie = await validateNeteaseCookie(normalizedCookie);
  if (!validCookie) return { valid: false, songs: [] };

  const response = await fetch('https://music.163.com/api/v3/discovery/recommend/songs', {
    headers: createNeteaseHeaders(normalizedCookie),
  });
  const data = await response.json() as any;
  const rawSongs = (data?.data?.dailySongs || data?.recommend || []).map(mapNeteaseSong);
  const songs = await filterPlayableSongs(rawSongs, resultLimit, normalizedCookie);
  return { valid: Boolean(data?.data?.dailySongs || data?.recommend), songs };
}

async function getUserPlaylists(cookie: string) {
  const account = await getNeteaseAccount(cookie);
  if (!account.valid || !account.userId) return { valid: false, playlists: [] };

  const response = await fetch(`https://music.163.com/api/user/playlist?uid=${encodeURIComponent(account.userId)}&limit=100&offset=0`, {
    headers: createNeteaseHeaders(cookie),
  });
  const data = await response.json() as any;
  const playlists = (data?.playlist || []).map((playlist: any) => ({
    id: playlist.id,
    name: playlist.name,
    trackCount: playlist.trackCount || 0,
  }));

  return { valid: true, playlists };
}

async function getPlaylistPlayableSongs(playlistId: string, cookie: string, resultLimit: number) {
  const response = await fetch(`https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(playlistId)}&n=${resultLimit * 2}`, {
    headers: createNeteaseHeaders(cookie),
  });
  const data = await response.json() as any;
  const tracks = data?.playlist?.tracks || [];
  const songs = await filterPlayableSongs(tracks.map(mapNeteaseSong), resultLimit, cookie);
  return songs;
}

function neteaseApiPlugin() {
  return {
    name: 'netease-api-proxy',
    configureServer(server: any) {
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
          const requestedLimit = Number(requestUrl.searchParams.get('limit') || '30');
          const cookie = readNeteaseCookie(req);
          const hasCookie = Boolean(normalizeNeteaseCookie(cookie));
          const resultLimit = hasCookie
            ? (Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 40)) : 30)
            : (Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 20)) : 12);
          const includeDebug = requestUrl.searchParams.get('debug') === '1';

          if (!keywords) {
            writeJson(res, 400, { error: 'Missing keywords' });
            return;
          }

          const searchMode = hasCookie ? `cookie::${normalizeNeteaseCookie(cookie)}` : 'anonymous-baseline';
          const cacheKey = `${keywords.toLowerCase()}::${resultLimit}::${searchMode}`;
          const cached = searchCache.get(cacheKey);
          if (cached && cached.expiresAt > Date.now()) {
            writeJson(res, 200, { ...cached.payload, cached: true });
            return;
          }

          const searchResult = hasCookie
            ? await fetchNeteaseSearchSongs(keywords, resultLimit, cookie)
            : { songs: await fetchAnonymousNeteaseSearchSongs(keywords, resultLimit), debug: { mode: 'anonymous-github' } };
          const rawSongs = searchResult.songs.map(mapNeteaseSong);
          const songs = await filterPlayableSongs(rawSongs, resultLimit, cookie);
          const payload = { songs, rawCount: rawSongs.length, filteredCount: songs.length };
          if (rawSongs.length > 0 || songs.length > 0) {
            searchCache.set(cacheKey, { payload, expiresAt: Date.now() + searchCacheTtl });
          }

          writeJson(res, 200, includeDebug ? { ...payload, debug: searchResult.debug } : payload);
        } catch (error) {
          writeJson(res, 500, { error: 'Netease search failed' });
        }
      });

      server.middlewares.use('/api/netease/cookie', async (req: any, res: any, next: any) => {
        try {
          if (req.method === 'GET') {
            const account = await getNeteaseAccount(browserNeteaseCookie);
            writeJson(res, 200, {
              hasCookie: Boolean(browserNeteaseCookie),
              valid: account.valid,
              userId: account.userId,
              nickname: account.nickname,
            });
            return;
          }

          if (req.method === 'PUT') {
            const body = await readRequestBody(req);
            const parsed = body ? JSON.parse(body) : {};
            browserNeteaseCookie = normalizeNeteaseCookie(parsed.cookie);
            playableUrlCache.clear();
            searchCache.clear();
            const account = await getNeteaseAccount(browserNeteaseCookie);
            writeJson(res, 200, { hasCookie: Boolean(browserNeteaseCookie), valid: account.valid, userId: account.userId, nickname: account.nickname });
            return;
          }
        } catch (error) {
          writeJson(res, 500, { error: 'Unable to check or save Netease cookie' });
          return;
        }

        next();
      });

      server.middlewares.use('/api/netease/liked', async (req: any, res: any) => {
        try {
          const requestUrl = new URL(req.url || '', 'http://localhost');
          const requestedLimit = Number(requestUrl.searchParams.get('limit') || '50');
          const resultLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 80)) : 50;
          const cookie = readNeteaseCookie(req);
          const userPlaylists = await getUserPlaylists(cookie);

          if (!userPlaylists.valid || userPlaylists.playlists.length === 0) {
            writeJson(res, 401, { error: 'Netease cookie is invalid or expired', songs: [] });
            return;
          }

          const likedPlaylist = userPlaylists.playlists[0];
          const songs = await getPlaylistPlayableSongs(String(likedPlaylist.id), cookie, resultLimit);
          writeJson(res, 200, { songs, playlist: likedPlaylist });
        } catch (error) {
          writeJson(res, 500, { error: 'Netease liked songs failed' });
        }
      });

      server.middlewares.use('/api/netease/playlists', async (req: any, res: any) => {
        try {
          const cookie = readNeteaseCookie(req);
          const userPlaylists = await getUserPlaylists(cookie);

          if (!userPlaylists.valid) {
            writeJson(res, 401, { error: 'Netease cookie is invalid or expired', playlists: [] });
            return;
          }

          writeJson(res, 200, { playlists: userPlaylists.playlists.slice(1) });
        } catch (error) {
          writeJson(res, 500, { error: 'Netease playlists failed' });
        }
      });

      server.middlewares.use('/api/netease/playlist', async (req: any, res: any) => {
        try {
          const requestUrl = new URL(req.url || '', 'http://localhost');
          const id = requestUrl.searchParams.get('id');
          const requestedLimit = Number(requestUrl.searchParams.get('limit') || '50');
          const resultLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 80)) : 50;
          const cookie = readNeteaseCookie(req);

          if (!id) {
            writeJson(res, 400, { error: 'Missing id' });
            return;
          }

          const account = await getNeteaseAccount(cookie);
          if (!account.valid) {
            writeJson(res, 401, { error: 'Netease cookie is invalid or expired', songs: [] });
            return;
          }

          const songs = await getPlaylistPlayableSongs(id, cookie, resultLimit);
          writeJson(res, 200, { songs });
        } catch (error) {
          writeJson(res, 500, { error: 'Netease playlist failed' });
        }
      });

      server.middlewares.use('/api/netease/daily-recommend', async (req: any, res: any) => {
        try {
          const requestUrl = new URL(req.url || '', 'http://localhost');
          const requestedLimit = Number(requestUrl.searchParams.get('limit') || '30');
          const resultLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 50)) : 30;
          const cookie = readNeteaseCookie(req);
          const result = await getDailyRecommendSongs(cookie, resultLimit);

          if (!result.valid) {
            writeJson(res, 401, { error: 'Netease cookie is invalid or expired', songs: [] });
            return;
          }

          writeJson(res, 200, { songs: result.songs });
        } catch (error) {
          writeJson(res, 500, { error: 'Netease daily recommend failed' });
        }
      });

      server.middlewares.use('/api/netease/lyric', async (req: any, res: any) => {
        try {
          const requestUrl = new URL(req.url || '', 'http://localhost');
          const id = requestUrl.searchParams.get('id');
          const cookie = readNeteaseCookie(req);

          if (!id) {
            writeJson(res, 400, { error: 'Missing id' });
            return;
          }

          const response = await fetch(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=-1&kv=-1&tv=-1`, {
            headers: createNeteaseHeaders(cookie),
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
          const cookie = readNeteaseCookie(req);

          if (!id) {
            writeJson(res, 400, { error: 'Missing id' });
            return;
          }

          writeJson(res, 200, { url: await getNeteasePlayableUrlWithCookie(id, cookie) });
        } catch (error) {
          writeJson(res, 500, { error: 'Netease url failed' });
        }
      });

      server.middlewares.use('/api/netease/audio', async (req: any, res: any) => {
        try {
          const requestUrl = new URL(req.url || '', 'http://localhost');
          const id = requestUrl.searchParams.get('id');
          const cookie = readNeteaseCookie(req);

          if (!id) {
            writeJson(res, 400, { error: 'Missing id' });
            return;
          }

          const playableUrl = await getNeteasePlayableUrlWithCookie(id, cookie);
          if (!playableUrl) {
            writeJson(res, 404, { error: 'No playable url for this song' });
            return;
          }

          const headers: Record<string, string> = createNeteaseHeaders(cookie);
          if (req.headers.range) headers.Range = req.headers.range;

          const audioResponse = await fetch(playableUrl, { headers });
          res.statusCode = audioResponse.status;
          ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((header) => {
            const value = audioResponse.headers.get(header);
            if (value) res.setHeader(header, value);
          });

          if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'audio/mpeg');
          if (audioResponse.body) {
            const reader = audioResponse.body.getReader();
            const pump = async () => {
              const { done, value } = await reader.read();
              if (done) {
                res.end();
                return;
              }
              res.write(Buffer.from(value), pump);
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

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), neteaseApiPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify芒聙聰file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});


