// HTTP plumbing: server, auth Bearer, JSON helpers, X-GitHub-Request-Id.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

type Server struct {
	store *Store
	token string
	mux   *http.ServeMux
	reqID uint64
	// Pack cache (fetch): kunci = repo + generasi + wants/haves/shallow/depth.
	// Workload clone menjalankan 50 clone konkuren yang IDENTIK dari repo yang
	// sama — tanpa cache, pack yang sama di-deflate 50 kali. Cache menyimpan
	// pack yang sudah jadi; request konkuren dengan kunci sama menunggu build
	// pertama selesai (singleflight sederhana) lalu memakai hasilnya.
	packMu    sync.Mutex
	packCache map[string]*cachedPack
}

type cachedPack struct {
	pack []byte
	done chan struct{} // ditutup saat pack selesai dibangun
}

func NewServer(store *Store, token string) *Server {
	return &Server{store: store, token: token, mux: http.NewServeMux(), packCache: make(map[string]*cachedPack)}
}

// fetchPack mengembalikan pack untuk fetch ini, memakai cache bila ada.
// objs adalah objek yang sudah dihitung PlanFetch oleh pemanggil; gen dibaca
// pemanggil di bawah lock. Kunci mencakup generasi repo sehingga mutasi apa
// pun menginvalidasi cache. Pack untuk (wants,haves,depth) yang sama bersifat
// deterministik karena graf objek hanya tumbuh (objek tidak pernah dihapus).
func (s *Server) fetchPack(repo *Repo, gen uint64, wants, haves, shallow []string, depth int, objs []*GitObject) []byte {
	key := repo.Owner + "/" + repo.Name + "|" + strconv.FormatUint(gen, 10) + "|" +
		strings.Join(wants, ",") + "|" + strings.Join(haves, ",") + "|" +
		strings.Join(shallow, ",") + "|" + strconv.Itoa(depth)
	s.packMu.Lock()
	if ent, ok := s.packCache[key]; ok {
		s.packMu.Unlock()
		<-ent.done
		return ent.pack
	}
	ent := &cachedPack{done: make(chan struct{})}
	if len(s.packCache) > 64 {
		// Batasi memori: buang seluruh cache bila terlalu besar.
		s.packCache = make(map[string]*cachedPack)
	}
	s.packCache[key] = ent
	s.packMu.Unlock()
	ent.pack = WritePack(objs)
	close(ent.done)
	return ent.pack
}

// nextRequestID menghasilkan id unik non-empty untuk X-GitHub-Request-Id.
func (s *Server) nextRequestID() string {
	n := atomic.AddUint64(&s.reqID, 1)
	var rnd [4]byte
	rand.Read(rnd[:])
	return fmt.Sprintf("r5-%x-%x", n, rnd)
}

// authOK memeriksa header Authorization: Bearer <token>. Kalau token server
// kosong (mode lokal tanpa env), bearer apa pun yang non-empty diterima; tanpa
// header tetap 401.
func (s *Server) authOK(r *http.Request) bool {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return false
	}
	got := strings.TrimPrefix(h, "Bearer ")
	if got == "" {
		return false
	}
	if s.token == "" {
		return true
	}
	return got == s.token
}

// writeJSON menulis JSON dengan Content-Type application/json + request id.
func (s *Server) writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-GitHub-Request-Id", s.nextRequestID())
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// writeErr menulis {"message": ...} dengan status.
func (s *Server) writeErr(w http.ResponseWriter, status int, msg string) {
	s.writeJSON(w, status, map[string]string{"message": msg})
}

// readJSON membaca body JSON (maks 64 MiB) ke v.
func readJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 64<<20))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

// readJSONLenient membaca body JSON tanpa menolak field tak dikenal.
func readJSONLenient(r *http.Request, v any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 64<<20))
	return dec.Decode(v)
}

// handle mendaftarkan handler API: recover dari panic, wajib auth, lalu handler.
func (s *Server) handle(pattern string, h http.HandlerFunc) {
	s.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				s.writeErr(w, 500, fmt.Sprintf("internal error: %v", rec))
			}
		}()
		if !s.authOK(r) {
			s.writeErr(w, 401, "Requires authentication")
			return
		}
		h(w, r)
	})
}

// handleRaw mendaftarkan handler tanpa auth (untuk /healthz).
func (s *Server) handleRaw(pattern string, h http.HandlerFunc) {
	s.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				http.Error(w, "internal error", 500)
			}
		}()
		h(w, r)
	})
}

// Handler mengembalikan http.Handler untuk server.
func (s *Server) Handler() http.Handler { return s.mux }

// --- util JSON kecil ---

// jsonBytes mem-marshal tanpa escape HTML (untuk balasan yang sudah jadi string).
func jsonBytes(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func hexRand(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}
