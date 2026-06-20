package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const cacheTTL = 10 * time.Minute

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
			Songs     []any
			ExpiresAt time.Time
		}
	}{data: make(map[string]struct {
		Songs     []any
		ExpiresAt time.Time
	})}
)

func main() {
	// 获取可执行文件所在目录
	exePath, err := os.Executable()
	if err != nil {
		log.Fatal("无法获取可执行文件路径:", err)
	}
	baseDir := filepath.Dir(exePath)

	// 日志文件
	logFile, err := os.OpenFile(filepath.Join(baseDir, "sonic-proxy.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err == nil {
		defer logFile.Close()
		log.SetOutput(io.MultiWriter(os.Stderr, logFile))
	}
	log.Println("=== Sonic Proxy 代理服务器启动（纯API） ===")
	log.Println("工作目录:", baseDir)

	// 路由注册（仅保留网易云代理）
	mux := http.NewServeMux()
	mux.HandleFunc("/api/netease/search", handleSearch)
	mux.HandleFunc("/api/netease/lyric", handleLyric)
	mux.HandleFunc("/api/netease/url", handleURL)
	mux.HandleFunc("/api/netease/audio", handleAudio)

	// 未匹配路由返回 404
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})

	handler := corsMiddleware(mux)
	log.Println("代理服务器启动在 :7200")
	if err := http.ListenAndServe(":7200", handler); err != nil {
		log.Fatal("HTTP 服务器错误:", err)
	}
}

// ---------- 跨域中间件 ----------
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Range")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------- 网易云代理 ----------
func getNeteasePlayableURL(id string) (string, error) {
	playableURLCache.RLock()
	if entry, ok := playableURLCache.data[id]; ok && time.Now().Before(entry.ExpiresAt) {
		playableURLCache.RUnlock()
		return entry.URL, nil
	}
	playableURLCache.RUnlock()

	apiURL := fmt.Sprintf("https://music.163.com/api/song/enhance/player/url?id=%s&ids=[%s]&br=320000", id, id)
	req, _ := http.NewRequest("GET", apiURL, nil)
	req.Header.Set("Referer", "https://music.163.com/")
	req.Header.Set("User-Agent", "Mozilla/5.0")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var result struct {
		Data []struct {
			URL string `json:"url"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	var playableURL string
	if len(result.Data) > 0 {
		playableURL = result.Data[0].URL
	}
	playableURLCache.Lock()
	playableURLCache.data[id] = struct {
		URL       string
		ExpiresAt time.Time
	}{URL: playableURL, ExpiresAt: time.Now().Add(cacheTTL)}
	playableURLCache.Unlock()
	return playableURL, nil
}

func filterPlayableSongs(rawSongs []any, limit int) ([]any, error) {
	playable := []any{}
	for _, song := range rawSongs {
		if len(playable) >= limit {
			break
		}
		songMap, ok := song.(map[string]any)
		if !ok {
			continue
		}
		id, ok := songMap["id"]
		if !ok {
			continue
		}
		idStr := fmt.Sprintf("%v", id)
		url, err := getNeteasePlayableURL(idStr)
		if err != nil {
			continue
		}
		if url != "" {
			playable = append(playable, song)
		}
	}
	return playable, nil
}

func handleSearch(w http.ResponseWriter, r *http.Request) {
	keywords := r.URL.Query().Get("keywords")
	if keywords == "" {
		http.Error(w, "Missing keywords", http.StatusBadRequest)
		return
	}
	limitStr := r.URL.Query().Get("limit")
	limit := 12
	if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 20 {
		limit = l
	}

	cacheKey := strings.ToLower(keywords) + "::" + strconv.Itoa(limit)
	searchCache.RLock()
	if entry, ok := searchCache.data[cacheKey]; ok && time.Now().Before(entry.ExpiresAt) {
		searchCache.RUnlock()
		json.NewEncoder(w).Encode(map[string]any{"songs": entry.Songs, "cached": true})
		return
	}
	searchCache.RUnlock()

	form := url.Values{}
	form.Set("s", keywords)
	form.Set("type", "1")
	form.Set("offset", "0")
	form.Set("total", "true")
	form.Set("limit", strconv.Itoa(limit*3))
	req, _ := http.NewRequest("POST", "https://music.163.com/api/search/get/web", strings.NewReader(form.Encode()))
	req.Header.Set("Referer", "https://music.163.com/")
	req.Header.Set("User-Agent", "Mozilla/5.0")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "Netease search failed", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()
	var data map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		http.Error(w, "Invalid response", http.StatusInternalServerError)
		return
	}
	result, ok := data["result"].(map[string]any)
	if !ok {
		http.Error(w, "No result", http.StatusInternalServerError)
		return
	}
	songs, ok := result["songs"].([]any)
	if !ok {
		songs = []any{}
	}
	normalized := make([]any, 0, len(songs))
	for _, s := range songs {
		song, ok := s.(map[string]any)
		if !ok {
			continue
		}
		artists := []string{}
		if arts, ok := song["artists"].([]any); ok {
			for _, a := range arts {
				if amap, ok := a.(map[string]any); ok {
					if name, ok := amap["name"].(string); ok {
						artists = append(artists, name)
					}
				}
			}
		}
		album := ""
		if albumMap, ok := song["album"].(map[string]any); ok {
			if name, ok := albumMap["name"].(string); ok {
				album = name
			}
		}
		id := uint64(0)
		if idVal, ok := song["id"].(float64); ok {
			id = uint64(idVal)
		}
		normalized = append(normalized, map[string]any{
			"id":       id,
			"name":     song["name"],
			"artist":   strings.Join(artists, " / "),
			"album":    album,
			"duration": song["duration"],
			"fee":      song["fee"],
		})
	}
	playableSongs, err := filterPlayableSongs(normalized, limit)
	if err != nil {
		http.Error(w, "Filter failed", http.StatusInternalServerError)
		return
	}
	searchCache.Lock()
	searchCache.data[cacheKey] = struct {
		Songs     []any
		ExpiresAt time.Time
	}{Songs: playableSongs, ExpiresAt: time.Now().Add(cacheTTL)}
	searchCache.Unlock()

	json.NewEncoder(w).Encode(map[string]any{"songs": playableSongs})
}

func handleLyric(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "Missing id", http.StatusBadRequest)
		return
	}
	apiURL := fmt.Sprintf("https://music.163.com/api/song/lyric?id=%s&lv=-1&kv=-1&tv=-1", id)
	req, _ := http.NewRequest("GET", apiURL, nil)
	req.Header.Set("Referer", "https://music.163.com/")
	req.Header.Set("User-Agent", "Mozilla/5.0")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "Lyric fetch failed", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()
	var data map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		http.Error(w, "Invalid response", http.StatusInternalServerError)
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
	json.NewEncoder(w).Encode(map[string]any{
		"lyric":           lyric,
		"translatedLyric": translated,
	})
}

func handleURL(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "Missing id", http.StatusBadRequest)
		return
	}
	playableURL, err := getNeteasePlayableURL(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"url": playableURL})
}

func handleAudio(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "Missing id", http.StatusBadRequest)
		return
	}
	playableURL, err := getNeteasePlayableURL(id)
	if err != nil || playableURL == "" {
		http.Error(w, "No playable URL", http.StatusNotFound)
		return
	}
	req, _ := http.NewRequest("GET", playableURL, nil)
	req.Header.Set("Referer", "https://music.163.com/")
	req.Header.Set("User-Agent", "Mozilla/5.0")
	if rangeHeader := r.Header.Get("Range"); rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "Audio proxy failed", http.StatusInternalServerError)
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