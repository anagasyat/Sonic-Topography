package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

// ---------- 常量 ----------
const (
	playableURLCacheTTL = 10 * time.Minute
	searchCacheTTL      = 5 * time.Minute
	batchSize           = 8
	maxRetries          = 2
)

// ---------- 数据结构 ----------
type Song struct {
	ID       uint64 `json:"id"`
	Name     string `json:"name"`
	Artist   string `json:"artist"`
	Album    string `json:"album"`
	Duration int64  `json:"duration"`
	Fee      int    `json:"fee"`
}

type PlaylistInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	TrackCount int    `json:"trackCount"`
}

// ---------- 全局缓存 ----------
var (
	playableURLCache = struct {
		sync.RWMutex
		data map[string]struct {
			URL       string
			ExpiresAt time.Time
		}
	}{data: make(map[string]struct {
		URL       string
		ExpiresAt time.Time
	})}

	searchCache = struct {
		sync.RWMutex
		data map[string]struct {
			Songs     []Song
			ExpiresAt time.Time
		}
	}{data: make(map[string]struct {
		Songs     []Song
		ExpiresAt time.Time
	})}

	browserNeteaseCookie string
	cookieMutex          sync.RWMutex
)

// ---------- 工具函数 ----------
func normalizeNeteaseCookie(value string) string {
	parts := strings.Split(value, "\n")
	var cleaned []string
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		part = strings.TrimSuffix(part, ";")
		cleaned = append(cleaned, part)
	}
	return strings.Join(cleaned, "; ")
}

func readNeteaseCookie(r *http.Request) string {
	raw := r.Header.Get("x-netease-cookie")
	if raw != "" {
		return normalizeNeteaseCookie(raw)
	}
	cookieMutex.RLock()
	defer cookieMutex.RUnlock()
	return browserNeteaseCookie
}

func createNeteaseHeaders(cookie string, extra map[string]string) http.Header {
	headers := http.Header{}
	headers.Set("Referer", "https://music.163.com/")
	headers.Set("User-Agent", "Mozilla/5.0")
	headers.Set("Accept", "application/json, text/plain, */*")
	headers.Set("Connection", "close")
	if cookie != "" {
		headers.Set("Cookie", normalizeNeteaseCookie(cookie))
	}
	for k, v := range extra {
		headers.Set(k, v)
	}
	return headers
}

func wait(ms int) {
	time.Sleep(time.Duration(ms) * time.Millisecond)
}

func fetchJSONWithRetry(urlStr, method string, body io.Reader, headers http.Header, retries int) (map[string]any, error) {
	var lastErr error
	var lastData map[string]any
	for attempt := 0; attempt <= retries; attempt++ {
		req, err := http.NewRequest(method, urlStr, body)
		if err != nil {
			return nil, err
		}
		req.Header = headers
		client := &http.Client{Timeout: 15 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			if attempt < retries {
				wait(180 * (attempt + 1))
			}
			continue
		}
		defer resp.Body.Close()
		var data map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
			lastErr = err
			if attempt < retries {
				wait(180 * (attempt + 1))
			}
			continue
		}
		if resp.StatusCode == http.StatusOK {
			if code, ok := data["code"].(float64); ok && code == 400 {
				if attempt < retries {
					wait(180 * (attempt + 1))
					continue
				}
			}
			return data, nil
		}
		lastData = data
		if attempt < retries {
			wait(180 * (attempt + 1))
		}
	}
	if lastData != nil {
		return lastData, nil
	}
	return nil, fmt.Errorf("fetch failed after retries: %w", lastErr)
}

// ---------- 网易云 API 封装 ----------
func getNeteaseAccount(cookie string) (userId int64, nickname string, valid bool) {
	cookie = normalizeNeteaseCookie(cookie)
	if cookie == "" {
		return 0, "", false
	}
	headers := createNeteaseHeaders(cookie, nil)
	data, err := fetchJSONWithRetry("https://music.163.com/api/nuser/account/get", "GET", nil, headers, maxRetries)
	if err != nil {
		return 0, "", false
	}
	if profile, ok := data["profile"].(map[string]any); ok {
		if id, ok := profile["userId"].(float64); ok {
			userId = int64(id)
		}
		if name, ok := profile["nickname"].(string); ok {
			nickname = name
		}
	}
	if userId == 0 {
		if account, ok := data["account"].(map[string]any); ok {
			if id, ok := account["id"].(float64); ok {
				userId = int64(id)
			}
		}
	}
	valid = userId != 0
	return
}

func validateNeteaseCookie(cookie string) bool {
	_, _, valid := getNeteaseAccount(cookie)
	return valid
}

func getNeteasePlayableURL(id string, cookie string) (string, error) {
	cookie = normalizeNeteaseCookie(cookie)
	cacheKey := id + "::" + cookie
	playableURLCache.RLock()
	if entry, ok := playableURLCache.data[cacheKey]; ok && time.Now().Before(entry.ExpiresAt) {
		playableURLCache.RUnlock()
		return entry.URL, nil
	}
	playableURLCache.RUnlock()

	apiURL := fmt.Sprintf("https://music.163.com/api/song/enhance/player/url?id=%s&ids=[%s]&br=320000", id, id)
	headers := createNeteaseHeaders(cookie, nil)
	data, err := fetchJSONWithRetry(apiURL, "GET", nil, headers, maxRetries)
	if err != nil {
		return "", err
	}
	var playableURL string
	if dataArr, ok := data["data"].([]any); ok && len(dataArr) > 0 {
		if first, ok := dataArr[0].(map[string]any); ok {
			if urlStr, ok := first["url"].(string); ok {
				playableURL = urlStr
			}
		}
	}
	playableURLCache.Lock()
	playableURLCache.data[cacheKey] = struct {
		URL       string
		ExpiresAt time.Time
	}{URL: playableURL, ExpiresAt: time.Now().Add(playableURLCacheTTL)}
	playableURLCache.Unlock()
	return playableURL, nil
}

func mapNeteaseSong(raw map[string]any) Song {
	song := Song{}
	if id, ok := raw["id"].(float64); ok {
		song.ID = uint64(id)
	}
	if name, ok := raw["name"].(string); ok {
		song.Name = name
	}
	var artists []string
	if arts, ok := raw["artists"].([]any); ok {
		for _, a := range arts {
			if amap, ok := a.(map[string]any); ok {
				if name, ok := amap["name"].(string); ok {
					artists = append(artists, name)
				}
			}
		}
	} else if ar, ok := raw["ar"].([]any); ok {
		for _, a := range ar {
			if amap, ok := a.(map[string]any); ok {
				if name, ok := amap["name"].(string); ok {
					artists = append(artists, name)
				}
			}
		}
	}
	song.Artist = strings.Join(artists, " / ")

	if album, ok := raw["album"].(map[string]any); ok {
		if name, ok := album["name"].(string); ok {
			song.Album = name
		}
	} else if al, ok := raw["al"].(map[string]any); ok {
		if name, ok := al["name"].(string); ok {
			song.Album = name
		}
	}
	if dur, ok := raw["duration"].(float64); ok {
		song.Duration = int64(dur)
	} else if dt, ok := raw["dt"].(float64); ok {
		song.Duration = int64(dt)
	}
	if fee, ok := raw["fee"].(float64); ok {
		song.Fee = int(fee)
	}
	return song
}

func filterPlayableSongs(rawSongs []Song, limit int, cookie string) ([]Song, error) {
	playable := []Song{}
	for i := 0; i < len(rawSongs) && len(playable) < limit; i += batchSize {
		end := i + batchSize
		if end > len(rawSongs) {
			end = len(rawSongs)
		}
		batch := rawSongs[i:end]
		var wg sync.WaitGroup
		results := make([]string, len(batch))
		for idx, song := range batch {
			wg.Add(1)
			go func(idx int, song Song) {
				defer wg.Done()
				url, err := getNeteasePlayableURL(strconv.FormatUint(song.ID, 10), cookie)
				if err == nil && url != "" {
					results[idx] = url
				}
			}(idx, song)
		}
		wg.Wait()
		for idx, url := range results {
			if url != "" {
				playable = append(playable, batch[idx])
				if len(playable) >= limit {
					break
				}
			}
		}
	}
	return playable, nil
}

// ---------- 搜索（双源合并） ----------
func fetchNeteaseSearchSongs(keywords string, limit int, cookie string) ([]Song, error) {
	upstreamLimit := limit * 5
	if upstreamLimit > 80 {
		upstreamLimit = 80
	}

	// 主接口
	form := url.Values{}
	form.Set("s", keywords)
	form.Set("type", "1")
	form.Set("offset", "0")
	form.Set("total", "true")
	form.Set("limit", strconv.Itoa(upstreamLimit))
	body := strings.NewReader(form.Encode())
	headers := createNeteaseHeaders(cookie, map[string]string{
		"Content-Type": "application/x-www-form-urlencoded",
	})
	data, err := fetchJSONWithRetry("https://music.163.com/api/search/get/web", "POST", body, headers, maxRetries)
	if err != nil {
		return nil, err
	}
	var primarySongs []map[string]any
	if result, ok := data["result"].(map[string]any); ok {
		if songs, ok := result["songs"].([]any); ok {
			for _, s := range songs {
				if smap, ok := s.(map[string]any); ok {
					primarySongs = append(primarySongs, smap)
				}
			}
		}
	}

	// 备用接口（总是请求，与 Vite 一致）
	fallbackURL := "https://music.163.com/api/cloudsearch/pc"
	params := url.Values{}
	params.Set("s", keywords)
	params.Set("type", "1")
	params.Set("offset", "0")
	params.Set("total", "true")
	params.Set("limit", strconv.Itoa(upstreamLimit))
	fallbackURL += "?" + params.Encode()
	fallbackData, err2 := fetchJSONWithRetry(fallbackURL, "GET", nil, createNeteaseHeaders(cookie, nil), maxRetries)
	if err2 != nil {
		return nil, err2
	}
	var fallbackSongs []map[string]any
	if result, ok := fallbackData["result"].(map[string]any); ok {
		if songs, ok := result["songs"].([]any); ok {
			for _, s := range songs {
				if smap, ok := s.(map[string]any); ok {
					fallbackSongs = append(fallbackSongs, smap)
				}
			}
		}
	}

	// 合并去重（主优先）
	seen := make(map[uint64]bool)
	var unique []Song
	for _, raw := range primarySongs {
		song := mapNeteaseSong(raw)
		if song.ID == 0 {
			continue
		}
		if !seen[song.ID] {
			seen[song.ID] = true
			unique = append(unique, song)
		}
	}
	for _, raw := range fallbackSongs {
		song := mapNeteaseSong(raw)
		if song.ID == 0 {
			continue
		}
		if !seen[song.ID] {
			seen[song.ID] = true
			unique = append(unique, song)
		}
	}
	return unique, nil
}

func fetchAnonymousNeteaseSearchSongs(keywords string, limit int) ([]Song, error) {
	upstreamLimit := limit * 3
	if upstreamLimit > 60 {
		upstreamLimit = 60
	}
	form := url.Values{}
	form.Set("s", keywords)
	form.Set("type", "1")
	form.Set("offset", "0")
	form.Set("total", "true")
	form.Set("limit", strconv.Itoa(upstreamLimit))
	body := strings.NewReader(form.Encode())
	headers := http.Header{}
	headers.Set("Referer", "https://music.163.com/")
	headers.Set("User-Agent", "Mozilla/5.0")
	headers.Set("Content-Type", "application/x-www-form-urlencoded")
	data, err := fetchJSONWithRetry("https://music.163.com/api/search/get/web", "POST", body, headers, maxRetries)
	if err != nil {
		return nil, err
	}
	var rawSongs []map[string]any
	if result, ok := data["result"].(map[string]any); ok {
		if songs, ok := result["songs"].([]any); ok {
			for _, s := range songs {
				if smap, ok := s.(map[string]any); ok {
					rawSongs = append(rawSongs, smap)
				}
			}
		}
	}
	var songs []Song
	for _, raw := range rawSongs {
		songs = append(songs, mapNeteaseSong(raw))
	}
	return songs, nil
}

// ---------- 歌单相关（网易云） ----------
func getUserPlaylists(cookie string) ([]PlaylistInfo, error) {
	cookie = normalizeNeteaseCookie(cookie)
	if cookie == "" {
		return nil, fmt.Errorf("cookie empty")
	}
	userId, _, valid := getNeteaseAccount(cookie)
	if !valid || userId == 0 {
		return nil, fmt.Errorf("invalid cookie")
	}
	apiURL := fmt.Sprintf("https://music.163.com/api/user/playlist?uid=%d&limit=100&offset=0", userId)
	headers := createNeteaseHeaders(cookie, nil)
	data, err := fetchJSONWithRetry(apiURL, "GET", nil, headers, maxRetries)
	if err != nil {
		return nil, err
	}
	var playlists []PlaylistInfo
	if playlistArr, ok := data["playlist"].([]any); ok {
		for _, p := range playlistArr {
			if pmap, ok := p.(map[string]any); ok {
				info := PlaylistInfo{}
				if id, ok := pmap["id"].(float64); ok {
					info.ID = strconv.FormatFloat(id, 'f', 0, 64)
				}
				if name, ok := pmap["name"].(string); ok {
					info.Name = name
				}
				if count, ok := pmap["trackCount"].(float64); ok {
					info.TrackCount = int(count)
				}
				playlists = append(playlists, info)
			}
		}
	}
	return playlists, nil
}

func getPlaylistSongs(playlistID string, cookie string, limit int) ([]Song, error) {
	cookie = normalizeNeteaseCookie(cookie)
	apiURL := fmt.Sprintf("https://music.163.com/api/v6/playlist/detail?id=%s&n=%d", playlistID, limit*2)
	headers := createNeteaseHeaders(cookie, nil)
	data, err := fetchJSONWithRetry(apiURL, "GET", nil, headers, maxRetries)
	if err != nil {
		return nil, err
	}
	var rawSongs []map[string]any
	if playlist, ok := data["playlist"].(map[string]any); ok {
		if tracks, ok := playlist["tracks"].([]any); ok {
			for _, t := range tracks {
				if tmap, ok := t.(map[string]any); ok {
					rawSongs = append(rawSongs, tmap)
				}
			}
		}
	}
	var songs []Song
	for _, raw := range rawSongs {
		songs = append(songs, mapNeteaseSong(raw))
	}
	return filterPlayableSongs(songs, limit, cookie)
}

func getDailyRecommendSongs(cookie string, limit int) ([]Song, error) {
	cookie = normalizeNeteaseCookie(cookie)
	if cookie == "" {
		return nil, fmt.Errorf("cookie required")
	}
	if !validateNeteaseCookie(cookie) {
		return nil, fmt.Errorf("invalid cookie")
	}
	headers := createNeteaseHeaders(cookie, nil)
	data, err := fetchJSONWithRetry("https://music.163.com/api/v3/discovery/recommend/songs", "GET", nil, headers, maxRetries)
	if err != nil {
		return nil, err
	}
	var rawSongs []map[string]any
	if dataMap, ok := data["data"].(map[string]any); ok {
		if daily, ok := dataMap["dailySongs"].([]any); ok {
			for _, s := range daily {
				if smap, ok := s.(map[string]any); ok {
					rawSongs = append(rawSongs, smap)
				}
			}
		}
	}
	if len(rawSongs) == 0 {
		if recommend, ok := data["recommend"].([]any); ok {
			for _, s := range recommend {
				if smap, ok := s.(map[string]any); ok {
					rawSongs = append(rawSongs, smap)
				}
			}
		}
	}
	var songs []Song
	for _, raw := range rawSongs {
		songs = append(songs, mapNeteaseSong(raw))
	}
	return filterPlayableSongs(songs, limit, cookie)
}

// ---------- HTTP 处理函数 ----------
func handleNeteaseCookie(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cookieMutex.RLock()
		cookie := browserNeteaseCookie
		cookieMutex.RUnlock()
		userId, nickname, valid := getNeteaseAccount(cookie)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"hasCookie": cookie != "",
			"valid":     valid,
			"userId":    userId,
			"nickname":  nickname,
		})
	case http.MethodPut:
		var req struct {
			Cookie string `json:"cookie"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid JSON", http.StatusBadRequest)
			return
		}
		cookieMutex.Lock()
		browserNeteaseCookie = normalizeNeteaseCookie(req.Cookie)
		cookieMutex.Unlock()
		// 清空缓存
		playableURLCache.Lock()
		playableURLCache.data = make(map[string]struct {
			URL       string
			ExpiresAt time.Time
		})
		playableURLCache.Unlock()
		searchCache.Lock()
		searchCache.data = make(map[string]struct {
			Songs     []Song
			ExpiresAt time.Time
		})
		searchCache.Unlock()
		userId, nickname, valid := getNeteaseAccount(browserNeteaseCookie)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"hasCookie": browserNeteaseCookie != "",
			"valid":     valid,
			"userId":    userId,
			"nickname":  nickname,
		})
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func handleNeteaseSearch(w http.ResponseWriter, r *http.Request) {
	keywords := strings.TrimSpace(r.URL.Query().Get("keywords"))
	if keywords == "" {
		http.Error(w, "Missing keywords", http.StatusBadRequest)
		return
	}
	limitStr := r.URL.Query().Get("limit")
	limit := 30
	if l, err := strconv.Atoi(limitStr); err == nil && l > 0 {
		limit = l
	}
	cookie := readNeteaseCookie(r)
	hasCookie := cookie != ""
	if hasCookie && limit > 40 {
		limit = 40
	} else if !hasCookie && limit > 20 {
		limit = 20
	}
	debug := r.URL.Query().Get("debug") == "1"

	// 缓存键
	cacheKey := strings.ToLower(keywords) + "::" + strconv.Itoa(limit) + "::" + cookie
	searchCache.RLock()
	if entry, ok := searchCache.data[cacheKey]; ok && time.Now().Before(entry.ExpiresAt) {
		searchCache.RUnlock()
		payload := map[string]interface{}{
			"songs":         entry.Songs,
			"cached":        true,
			"rawCount":      len(entry.Songs),
			"filteredCount": len(entry.Songs),
		}
		if debug {
			payload["debug"] = map[string]interface{}{"mode": "cache"}
		}
		json.NewEncoder(w).Encode(payload)
		return
	}
	searchCache.RUnlock()

	var rawSongs []Song
	var searchErr error
	var debugInfo map[string]interface{}
	if hasCookie {
		rawSongs, searchErr = fetchNeteaseSearchSongs(keywords, limit, cookie)
		if searchErr == nil {
			debugInfo = map[string]interface{}{"mode": "cookie"}
		}
	} else {
		rawSongs, searchErr = fetchAnonymousNeteaseSearchSongs(keywords, limit)
		if searchErr == nil {
			debugInfo = map[string]interface{}{"mode": "anonymous"}
		}
	}
	if searchErr != nil {
		http.Error(w, "Search failed: "+searchErr.Error(), http.StatusInternalServerError)
		return
	}
	playableSongs, err := filterPlayableSongs(rawSongs, limit, cookie)
	if err != nil {
		http.Error(w, "Filter failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if len(playableSongs) > 0 {
		searchCache.Lock()
		searchCache.data[cacheKey] = struct {
			Songs     []Song
			ExpiresAt time.Time
		}{Songs: playableSongs, ExpiresAt: time.Now().Add(searchCacheTTL)}
		searchCache.Unlock()
	}
	payload := map[string]interface{}{
		"songs":         playableSongs,
		"rawCount":      len(rawSongs),
		"filteredCount": len(playableSongs),
	}
	if debug {
		payload["debug"] = debugInfo
	}
	json.NewEncoder(w).Encode(payload)
}

func handleNeteaseLiked(w http.ResponseWriter, r *http.Request) {
	cookie := readNeteaseCookie(r)
	if cookie == "" {
		http.Error(w, "Cookie required", http.StatusUnauthorized)
		return
	}
	playlists, err := getUserPlaylists(cookie)
	if err != nil || len(playlists) == 0 {
		http.Error(w, "Failed to get playlists", http.StatusInternalServerError)
		return
	}
	likedID := playlists[0].ID
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
			if limit > 80 {
				limit = 80
			}
		}
	}
	songs, err := getPlaylistSongs(likedID, cookie, limit)
	if err != nil {
		http.Error(w, "Failed to get liked songs", http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"songs":    songs,
		"playlist": playlists[0],
	})
}

func handleNeteasePlaylists(w http.ResponseWriter, r *http.Request) {
	cookie := readNeteaseCookie(r)
	if cookie == "" {
		http.Error(w, "Cookie required", http.StatusUnauthorized)
		return
	}
	playlists, err := getUserPlaylists(cookie)
	if err != nil {
		http.Error(w, "Failed to get playlists", http.StatusInternalServerError)
		return
	}
	if len(playlists) > 1 {
		playlists = playlists[1:]
	} else {
		playlists = []PlaylistInfo{}
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"playlists": playlists})
}

func handleNeteasePlaylist(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "Missing id", http.StatusBadRequest)
		return
	}
	cookie := readNeteaseCookie(r)
	if cookie == "" {
		http.Error(w, "Cookie required", http.StatusUnauthorized)
		return
	}
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
			if limit > 80 {
				limit = 80
			}
		}
	}
	songs, err := getPlaylistSongs(id, cookie, limit)
	if err != nil {
		http.Error(w, "Failed to get playlist songs", http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"songs": songs})
}

func handleNeteaseDailyRecommend(w http.ResponseWriter, r *http.Request) {
	cookie := readNeteaseCookie(r)
	if cookie == "" {
		http.Error(w, "Cookie required", http.StatusUnauthorized)
		return
	}
	limit := 30
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
			if limit > 50 {
				limit = 50
			}
		}
	}
	songs, err := getDailyRecommendSongs(cookie, limit)
	if err != nil {
		http.Error(w, "Failed to get daily recommend", http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"songs": songs})
}

func handleNeteaseLyric(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "Missing id", http.StatusBadRequest)
		return
	}
	cookie := readNeteaseCookie(r)
	apiURL := fmt.Sprintf("https://music.163.com/api/song/lyric?id=%s&lv=-1&kv=-1&tv=-1", id)
	headers := createNeteaseHeaders(cookie, nil)
	data, err := fetchJSONWithRetry(apiURL, "GET", nil, headers, maxRetries)
	if err != nil {
		http.Error(w, "Lyric fetch failed", http.StatusInternalServerError)
		return
	}
	lyric := ""
	if lrc, ok := data["lrc"].(map[string]any); ok {
		if l, ok := lrc["lyric"].(string); ok {
			lyric = l
		}
	}
	translated := ""
	if tlyric, ok := data["tlyric"].(map[string]any); ok {
		if tl, ok := tlyric["lyric"].(string); ok {
			translated = tl
		}
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"lyric":           lyric,
		"translatedLyric": translated,
	})
}

func handleNeteaseURL(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "Missing id", http.StatusBadRequest)
		return
	}
	cookie := readNeteaseCookie(r)
	playableURL, err := getNeteasePlayableURL(id, cookie)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"url": playableURL})
}

func handleNeteaseAudio(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "Missing id", http.StatusBadRequest)
		return
	}
	cookie := readNeteaseCookie(r)
	playableURL, err := getNeteasePlayableURL(id, cookie)
	if err != nil || playableURL == "" {
		http.Error(w, "No playable URL", http.StatusNotFound)
		return
	}
	proxyReq, err := http.NewRequest("GET", playableURL, nil)
	if err != nil {
		http.Error(w, "Failed to create proxy request", http.StatusInternalServerError)
		return
	}
	headers := createNeteaseHeaders(cookie, nil)
	proxyReq.Header = headers
	if rangeHeader := r.Header.Get("Range"); rangeHeader != "" {
		proxyReq.Header.Set("Range", rangeHeader)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(proxyReq)
	if err != nil {
		http.Error(w, "Proxy request failed", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()
	for k, v := range resp.Header {
		if k == "Content-Type" || k == "Content-Length" || k == "Content-Range" || k == "Accept-Ranges" {
			w.Header().Set(k, v[0])
		}
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "audio/mpeg")
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// ---------- CORS 中间件 ----------
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Range, x-netease-cookie")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------- HTTP 服务器 ----------
func startAPIServer(port string) {
	ln, err := net.Listen("tcp", ":"+port)
	if err != nil {
		log.Fatalf("端口 %s 已被占用", port)
	}
	ln.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/netease/cookie", handleNeteaseCookie)
	mux.HandleFunc("/api/netease/search", handleNeteaseSearch)
	mux.HandleFunc("/api/netease/liked", handleNeteaseLiked)
	mux.HandleFunc("/api/netease/playlists", handleNeteasePlaylists)
	mux.HandleFunc("/api/netease/playlist", handleNeteasePlaylist)
	mux.HandleFunc("/api/netease/daily-recommend", handleNeteaseDailyRecommend)
	mux.HandleFunc("/api/netease/lyric", handleNeteaseLyric)
	mux.HandleFunc("/api/netease/url", handleNeteaseURL)
	mux.HandleFunc("/api/netease/audio", handleNeteaseAudio)

	handler := corsMiddleware(mux)
	log.Printf("HTTP API 服务器启动在 :%s", port)
	if err := http.ListenAndServe(":"+port, handler); err != nil {
		log.Fatal("HTTP 服务器错误:", err)
	}
}

// ---------- App (Wails) ----------
type App struct {
	ctx          context.Context
	isFullscreen bool
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// ToggleFullscreen 切换窗口全屏状态（暴露给 JavaScript 调用）
func (a *App) ToggleFullscreen() {
	a.isFullscreen = !a.isFullscreen
	if a.isFullscreen {
		runtime.WindowFullscreen(a.ctx)
	} else {
		runtime.WindowUnfullscreen(a.ctx)
	}
}

// ---------- main ----------
func main() {
	if os.Getenv("WAILS_BINDING_GENERATOR") == "true" {
		return
	}

	exePath, err := os.Executable()
	if err != nil {
		log.Fatal("无法获取可执行文件路径:", err)
	}
	baseDir := filepath.Dir(exePath)
	logFile, err := os.OpenFile(filepath.Join(baseDir, "sonic-proxy.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err == nil {
		defer logFile.Close()
		log.SetOutput(io.MultiWriter(os.Stderr, logFile))
	}
	log.Println("=== Sonic Topography (Wails 版) 启动 ===")
	log.Println("工作目录:", baseDir)

	port := "7200"
	go startAPIServer(port)
	time.Sleep(1 * time.Second)

	app := NewApp()
	err = wails.Run(&options.App{
		Title:  "Sonic Topography",
		Width:  1280,
		Height: 720,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		OnStartup:        app.startup,
		Bind: []interface{}{
			app, // 绑定 App 实例，使 ToggleFullscreen 方法可供前端调用
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}