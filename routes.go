// Registrasi semua route.
package main

import "net/http"

func registerRoutes(s *Server) {
	s.handleRaw("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte("{\"status\":\"ok\"}\n"))
	})
	// Git smart HTTP (satu subtree; dispatch manual di handleGit karena
	// ServeMux tidak mengizinkan wildcard sebagian segmen seperti {repo}.git).
	s.handle("/{owner}/", s.handleGit)
	// REST / GraphQL / MCP (diisi file masing-masing).
	registerRestRoutes(s)
	registerGraphQLRoutes(s)
	registerMCPRoutes(s)
	// Catch-all: route tak dikenal -> 404 JSON (bukan teks default Go).
	// Pola "/" kalah spesifik dari semua route di atas, jadi hanya kena bila
	// tidak ada yang cocok.
	s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		s.writeErr(w, 404, "Not Found")
	})
}
