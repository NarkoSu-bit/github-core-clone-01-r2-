// Lifecycle entry <-> env (wire.ts): bind port, POST /register, poll GET /done.
// Mode grader: MAKEFUN_ENV_URL ada. Mode lokal: PORT ada (tanpa register).
// Token bearer dari MAKEFUN_SHOP_TOKEN.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const requestTimeout = 30 * time.Second

func sleepRetry(attempt int) time.Duration {
	d := 250 * time.Millisecond * time.Duration(1<<min(attempt, 8))
	if d > 2*time.Second {
		d = 2 * time.Second
	}
	return d
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func register(envURL string, port int) error {
	client := &http.Client{Timeout: requestTimeout}
	body, _ := json.Marshal(map[string]int{"port": port})
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequest("POST", envURL+"/register", bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := client.Do(req)
		if err == nil {
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
			if res.StatusCode == 200 || res.StatusCode == 409 {
				return nil
			}
			if res.StatusCode == 400 || res.StatusCode == 405 {
				return fmt.Errorf("register answered HTTP %d", res.StatusCode)
			}
		}
		time.Sleep(sleepRetry(attempt))
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println("forge r5 (github-core-clone-01)")
		return
	}
	store := NewStore()
	srv := NewServer(store, os.Getenv("MAKEFUN_SHOP_TOKEN"))
	registerRoutes(srv)

	envURL := strings.TrimRight(os.Getenv("MAKEFUN_ENV_URL"), "/")
	portEnv := os.Getenv("PORT")

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, "[entry] listen:", err)
		os.Exit(1)
	}
	if portEnv != "" {
		ln.Close()
		ln, err = net.Listen("tcp", "127.0.0.1:"+portEnv)
		if err != nil {
			fmt.Fprintln(os.Stderr, "[entry] listen:", err)
			os.Exit(1)
		}
	}
	port := ln.Addr().(*net.TCPAddr).Port
	fmt.Printf("[entry] listening on port %d\n", port)

	httpSrv := &http.Server{Handler: srv.Handler()}
	go func() {
		_ = httpSrv.Serve(ln)
	}()

	// SIGTERM/SIGINT -> shutdown bersih, exit 0.
	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		_ = httpSrv.Close()
		os.Exit(0)
	}()

	if envURL == "" {
		if portEnv == "" {
			fmt.Fprintln(os.Stderr, "[entry] MAKEFUN_ENV_URL is not set: there is no env to register with")
			os.Exit(1)
		}
		fmt.Println("[entry] local mode (PORT), no env to register with")
		select {}
	}

	if err := register(envURL, port); err != nil {
		fmt.Fprintln(os.Stderr, "[entry]", err)
		os.Exit(1)
	}
	fmt.Println("[entry] registered; waiting for the env to say done")
	// Poll /done sampai true.
	client := &http.Client{Timeout: requestTimeout}
	for attempt := 0; ; attempt++ {
		done := false
		func() {
			res, err := client.Get(envURL + "/done")
			if err != nil {
				return
			}
			defer res.Body.Close()
			if res.StatusCode != 200 {
				return
			}
			var body struct {
				Done bool `json:"done"`
			}
			if json.NewDecoder(res.Body).Decode(&body) == nil && body.Done {
				done = true
			}
		}()
		if done {
			break
		}
		time.Sleep(sleepRetry(attempt))
	}
	_ = httpSrv.Close()
	fmt.Println("[entry] done")
}
