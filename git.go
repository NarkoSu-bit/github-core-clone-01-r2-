// Smart HTTP git: info/refs (upload-pack v2, receive-pack v0),
// git-upload-pack (ls-refs + fetch v2), git-receive-pack (push v0 + report-status).
package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

const maxPktPayload = 65516

// --- pkt-line ---

type pktKind int

const (
	pktData pktKind = iota
	pktFlush
	pktDelim
	pktResponseEnd
)

type pkt struct {
	kind    pktKind
	payload []byte
}

func encodePktLine(payload []byte) []byte {
	out := make([]byte, 4+len(payload))
	copy(out, []byte(fmt.Sprintf("%04x", len(payload)+4)))
	copy(out[4:], payload)
	return out
}

func encodePktLines(items [][]byte, controls ...string) []byte {
	var buf bytes.Buffer
	for _, it := range items {
		buf.Write(encodePktLine(it))
	}
	for _, c := range controls {
		switch c {
		case "flush":
			buf.WriteString("0000")
		case "delim":
			buf.WriteString("0001")
		case "response-end":
			buf.WriteString("0002")
		}
	}
	return buf.Bytes()
}

// parsePktLines mengurai stream pkt-line lengkap.
func parsePktLines(body []byte) ([]pkt, error) {
	var out []pkt
	i := 0
	for i < len(body) {
		if len(body)-i < 4 {
			return nil, fmt.Errorf("pkt-line terpotong")
		}
		head := string(body[i : i+4])
		n, err := strconv.ParseInt(head, 16, 32)
		if err != nil {
			return nil, fmt.Errorf("header pkt-line tidak valid %q", head)
		}
		if n == 0 {
			out = append(out, pkt{kind: pktFlush})
			i += 4
			continue
		}
		if n == 1 {
			out = append(out, pkt{kind: pktDelim})
			i += 4
			continue
		}
		if n == 2 {
			out = append(out, pkt{kind: pktResponseEnd})
			i += 4
			continue
		}
		if n < 4 || n > 65520 {
			return nil, fmt.Errorf("panjang pkt-line %d", n)
		}
		if len(body)-i < int(n) {
			return nil, fmt.Errorf("pkt-line terpotong")
		}
		out = append(out, pkt{kind: pktData, payload: body[i+4 : i+int(n)]})
		i += int(n)
	}
	return out, nil
}

// sidebandPackets membungkus data menjadi paket sideband band 1.
func sidebandPackets(data []byte) [][]byte {
	var out [][]byte
	const maxChunk = maxPktPayload - 1
	for len(data) > 0 {
		n := len(data)
		if n > maxChunk {
			n = maxChunk
		}
		chunk := make([]byte, 1+n)
		chunk[0] = 1
		copy(chunk[1:], data[:n])
		out = append(out, chunk)
		data = data[n:]
	}
	if len(out) == 0 {
		out = append(out, []byte{1})
	}
	return out
}

// --- helpers repo ---

// handleGit adalah dispatcher untuk semua path /{owner}/{repo}.git/*
// (ServeMux Go tidak mengizinkan wildcard sebagian segmen seperti {repo}.git,
// jadi satu subtree "/{owner}/" menangkapnya dan dispatch dilakukan manual).
// Path yang bukan git -> 404 JSON (menjaga protocol.unknown-route-json-404).
func (s *Server) handleGit(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 3 || len(parts) > 4 || !strings.HasSuffix(parts[1], ".git") {
		s.writeErr(w, 404, "Not Found")
		return
	}
	owner := parts[0]
	repoName := strings.TrimSuffix(parts[1], ".git")
	service := strings.Join(parts[2:], "/")
	repo, ok := s.store.GetRepo(owner, repoName)
	if !ok {
		// Repo tidak ada: 404 JSON (klien hanya memeriksa statusnya).
		s.writeErr(w, 404, "Not Found")
		return
	}
	switch service {
	case "info/refs":
		if r.Method != "GET" {
			s.writeErr(w, 404, "Not Found")
			return
		}
		s.handleInfoRefs(w, r, repo)
	case "git-upload-pack":
		if r.Method != "POST" {
			s.writeErr(w, 404, "Not Found")
			return
		}
		s.handleUploadPack(w, r, repo)
	case "git-receive-pack":
		if r.Method != "POST" {
			s.writeErr(w, 404, "Not Found")
			return
		}
		s.handleReceivePack(w, r, repo)
	default:
		s.writeErr(w, 404, "Not Found")
	}
}

// sortedRefs mengembalikan ref terurut (kecuali HEAD).
func sortedRefs(refs map[string]string) []string {
	names := make([]string, 0, len(refs))
	for n := range refs {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// peelTag mengupas tag annotated ke commit target (rekursif).
func peelTag(r *Repo, oid string) string {
	for {
		o, ok := r.Objects[oid]
		if !ok || o.Type != "tag" {
			return oid
		}
		oid = ParseTag(o.Data).Object
	}
}

// --- info/refs ---

func (s *Server) handleInfoRefs(w http.ResponseWriter, r *http.Request, repo *Repo) {
	service := r.URL.Query().Get("service")
	switch service {
	case "git-upload-pack":
		// Selalu v2: paket pertama "version 2".
		w.Header().Set("Content-Type", "application/x-git-upload-pack-advertisement")
		var buf bytes.Buffer
		lines := [][]byte{
			[]byte("version 2\n"),
			[]byte("fetch=shallow\n"),
			[]byte("ls-refs=unborn\n"),
			[]byte("object-format=sha1\n"),
			[]byte("agent=forge-r5/1.0\n"),
		}
		buf.Write(encodePktLines(lines, "flush"))
		w.Header().Set("Content-Length", strconv.Itoa(buf.Len()))
		w.WriteHeader(200)
		_, _ = w.Write(buf.Bytes())
	case "git-receive-pack":
		w.Header().Set("Content-Type", "application/x-git-receive-pack-advertisement")
		var buf bytes.Buffer
		caps := "report-status side-band-64k delete-refs ofs-delta agent"
		refs := s.store.ListRefs(repo)
		// Preamble smart-HTTP SEBAGAI paket pkt-line data pertama (bukan teks
		// mentah — decoder klien kit mem-parse seluruh body sebagai pkt-line):
		// "# service=git-receive-pack\n".
		var lines [][]byte
		lines = append(lines, []byte("# service=git-receive-pack\n"))
		if main, ok := refs["refs/heads/main"]; ok {
			caps += " symref=HEAD:refs/heads/main"
			lines = append(lines, []byte(main+" HEAD\x00"+caps+"\n"))
		} else {
			lines = append(lines, []byte(zeroOID+" capabilities^{}\x00"+caps+"\n"))
		}
		for _, name := range sortedRefs(refs) {
			oid := refs[name]
			lines = append(lines, []byte(oid+" "+name+"\n"))
			// Peeled: tag annotated -> <oid> <name>^{}
			if strings.HasPrefix(name, "refs/tags/") {
				if o, ok := s.store.GetObject(repo, oid); ok && o.Type == "tag" {
					peeled := s.store.PeelTag(repo, oid)
					if peeled != oid {
						lines = append(lines, []byte(peeled+" "+name+"^{}\n"))
					}
				}
			}
		}
		buf.Write(encodePktLines(lines, "flush"))
		w.Header().Set("Content-Length", strconv.Itoa(buf.Len()))
		w.WriteHeader(200)
		_, _ = w.Write(buf.Bytes())
	default:
		http.Error(w, "unknown service", 400)
	}
}

// --- git-upload-pack (v2) ---

type fetchArgs struct {
	wants    []string
	haves    []string
	shallow  []string
	depth    int
	hasDepth bool
}

func (s *Server) handleUploadPack(w http.ResponseWriter, r *http.Request, repo *Repo) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 512<<20))
	if err != nil {
		http.Error(w, "cannot read body", 400)
		return
	}
	packets, err := parsePktLines(body)
	if err != nil {
		http.Error(w, "malformed pkt-line", 400)
		return
	}
	// Perintah ada di paket data pertama.
	var command string
	idx := 0
	for idx < len(packets) && packets[idx].kind != pktData {
		idx++
	}
	if idx >= len(packets) {
		http.Error(w, "no command", 400)
		return
	}
	command = strings.TrimSuffix(string(packets[idx].payload), "\n")
	idx++
	switch command {
	case "command=ls-refs":
		s.serveLsRefs(w, repo, packets[idx:])
	case "command=fetch":
		s.serveFetch(w, repo, packets[idx:])
	default:
		http.Error(w, "unknown command", 400)
	}
}

// ls-refs: kumpulkan argumen sampai flush.
func (s *Server) serveLsRefs(w http.ResponseWriter, repo *Repo, packets []pkt) {
	peel, symrefs, unborn := false, false, false
	var prefixes []string
	for _, p := range packets {
		if p.kind == pktFlush {
			break
		}
		if p.kind != pktData {
			continue // delim dilewati
		}
		line := strings.TrimSuffix(string(p.payload), "\n")
		switch {
		case line == "peel":
			peel = true
		case line == "symrefs":
			symrefs = true
		case line == "unborn":
			unborn = true
		case strings.HasPrefix(line, "ref-prefix "):
			prefixes = append(prefixes, strings.TrimPrefix(line, "ref-prefix "))
		}
	}
	refs := s.store.ListRefs(repo)
	keep := func(name string) bool {
		if len(prefixes) == 0 {
			return true
		}
		for _, pre := range prefixes {
			if strings.HasPrefix(name, pre) {
				return true
			}
		}
		return false
	}
	var lines [][]byte
	mainOID, hasMain := refs["refs/heads/main"]
	if len(prefixes) == 0 {
		// HEAD selalu pertama (tanpa prefix).
		if hasMain {
			l := mainOID + " HEAD"
			if symrefs {
				l += " symref-target:refs/heads/main"
			}
			lines = append(lines, []byte(l+"\n"))
		} else if unborn {
			l := "unborn HEAD"
			if symrefs {
				l += " symref-target:refs/heads/main"
			}
			lines = append(lines, []byte(l+"\n"))
		}
	}
	for _, name := range sortedRefs(refs) {
		if !keep(name) {
			continue
		}
		oid := refs[name]
		l := oid + " " + name
		if peel && strings.HasPrefix(name, "refs/tags/") {
			if o, ok := s.store.GetObject(repo, oid); ok && o.Type == "tag" {
				peeled := s.store.PeelTag(repo, oid)
				if peeled != oid {
					l += " peeled:" + peeled
				}
			}
		}
		lines = append(lines, []byte(l+"\n"))
	}
	w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
	w.WriteHeader(200)
	_, _ = w.Write(encodePktLines(lines, "flush"))
}

func (s *Server) serveFetch(w http.ResponseWriter, repo *Repo, packets []pkt) {
	var args fetchArgs
	for _, p := range packets {
		if p.kind == pktFlush {
			break
		}
		if p.kind != pktData {
			continue
		}
		line := strings.TrimSuffix(string(p.payload), "\n")
		switch {
		case strings.HasPrefix(line, "want "):
			args.wants = append(args.wants, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "have "):
			args.haves = append(args.haves, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "shallow "):
			args.shallow = append(args.shallow, strings.TrimSpace(line[8:]))
		case strings.HasPrefix(line, "deepen "):
			if n, err := strconv.Atoi(strings.TrimSpace(line[7:])); err == nil {
				args.depth, args.hasDepth = n, true
			}
		}
	}
	depth := 0
	if args.hasDepth {
		depth = args.depth
	}
	// Periksa wants ada.
	for _, want := range args.wants {
		if _, ok := s.store.GetObject(repo, want); !ok {
			// Kirim band 3 error di seksi packfile.
			w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
			w.WriteHeader(200)
			var buf bytes.Buffer
			buf.Write(encodePktLine([]byte("packfile\n")))
			errPkt := append([]byte{3}, []byte("object not found\n")...)
			buf.Write(encodePktLine(errPkt))
			buf.WriteString("0000")
			_, _ = w.Write(buf.Bytes())
			return
		}
	}
	gen := s.store.RepoGen(repo)
	plan := s.store.PlanFetch(repo, args.wants, args.haves, args.shallow, depth)
	pack := s.fetchPack(repo, gen, args.wants, args.haves, args.shallow, depth, plan.objects)

	w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
	w.WriteHeader(200)
	var buf bytes.Buffer
	if len(args.haves) > 0 {
		buf.Write(encodePktLine([]byte("acknowledgments\n")))
		buf.Write(encodePktLine([]byte("NAK\n")))
		buf.Write(encodePktLine([]byte("ready\n")))
		buf.WriteString("0001") // delim
	}
	if len(plan.shallow) > 0 || len(plan.unshallow) > 0 {
		buf.Write(encodePktLine([]byte("shallow-info\n")))
		for _, oid := range plan.shallow {
			buf.Write(encodePktLine([]byte("shallow " + oid + "\n")))
		}
		for _, oid := range plan.unshallow {
			buf.Write(encodePktLine([]byte("unshallow " + oid + "\n")))
		}
		buf.WriteString("0001") // delim
	}
	buf.Write(encodePktLine([]byte("packfile\n")))
	for _, chunk := range sidebandPackets(pack) {
		buf.Write(encodePktLine(chunk))
	}
	buf.WriteString("0000") // flush
	_, _ = w.Write(buf.Bytes())
}

// --- git-receive-pack (v0) ---

type pushCommand struct {
	oldOID string
	newOID string
	ref    string
}

func (s *Server) handleReceivePack(w http.ResponseWriter, r *http.Request, repo *Repo) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 512<<20))
	if err != nil {
		http.Error(w, "cannot read body", 400)
		return
	}
	// Pisahkan command list (pkt-lines sampai flush pertama) dari pack.
	flushAt := -1
	i := 0
	for i+4 <= len(body) {
		head := string(body[i : i+4])
		n, perr := strconv.ParseInt(head, 16, 32)
		if perr != nil {
			break
		}
		if n == 0 {
			flushAt = i + 4
			break
		}
		if n < 4 || i+int(n) > len(body) {
			break
		}
		i += int(n)
	}
	if flushAt < 0 {
		http.Error(w, "malformed pkt-line", 400)
		return
	}
	cmdPackets, err := parsePktLines(body[:flushAt])
	if err != nil {
		http.Error(w, "malformed pkt-line", 400)
		return
	}
	packBytes := body[flushAt:]

	var commands []pushCommand
	sideband := false
	for _, p := range cmdPackets {
		if p.kind != pktData {
			continue
		}
		line := strings.TrimSuffix(string(p.payload), "\n")
		if nul := strings.IndexByte(line, 0); nul >= 0 {
			// Baris pertama membawa capabilities.
			caps := line[nul+1:]
			line = line[:nul]
			if strings.Contains(caps, "side-band-64k") {
				sideband = true
			}
		}
		parts := strings.Fields(line)
		if len(parts) != 3 {
			continue
		}
		commands = append(commands, pushCommand{oldOID: parts[0], newOID: parts[1], ref: parts[2]})
	}
	if len(commands) == 0 {
		http.Error(w, "no commands", 400)
		return
	}

	// Unpack dulu (objek disimpan walau ada ref yang ditolak).
	unpackOK := true
	unpackDetail := "ok"
	if len(packBytes) > 0 {
		objs, perr := ReadPack(packBytes, func(oid string) *GitObject {
			o, _ := s.store.GetObject(repo, oid)
			return o
		})
		if perr != nil {
			unpackOK = false
			unpackDetail = perr.Error()
		} else {
			s.store.PutObjects(repo, objs)
		}
	}

	// Terapkan perintah per ref.
	type refReport struct {
		ref    string
		ok     bool
		reason string
	}
	reports := make([]refReport, 0, len(commands))
	if unpackOK {
		for _, cmd := range commands {
			current, exists := s.store.GetRef(repo, cmd.ref)
			switch {
			case cmd.newOID == zeroOID:
				// Delete.
				if !exists {
					reports = append(reports, refReport{cmd.ref, false, "remote ref does not exist"})
				} else if cmd.oldOID != zeroOID && cmd.oldOID != current {
					reports = append(reports, refReport{cmd.ref, false, "non-fast-forward"})
				} else {
					s.store.SetRef(repo, cmd.ref, "")
					reports = append(reports, refReport{cmd.ref, true, ""})
				}
			case cmd.oldOID == zeroOID:
				// Create.
				if exists {
					reports = append(reports, refReport{cmd.ref, false, "already exists"})
				} else if _, ok := s.store.GetObject(repo, cmd.newOID); !ok {
					reports = append(reports, refReport{cmd.ref, false, "object not found"})
				} else {
					s.store.SetRef(repo, cmd.ref, cmd.newOID)
					reports = append(reports, refReport{cmd.ref, true, ""})
				}
			default:
				// Update: old harus cocok + new turunan current.
				if !exists || current != cmd.oldOID {
					reports = append(reports, refReport{cmd.ref, false, "non-fast-forward"})
				} else if _, ok := s.store.GetObject(repo, cmd.newOID); !ok {
					reports = append(reports, refReport{cmd.ref, false, "object not found"})
				} else if !s.store.IsAncestor(repo, current, cmd.newOID) {
					reports = append(reports, refReport{cmd.ref, false, "non-fast-forward"})
				} else {
					s.store.SetRef(repo, cmd.ref, cmd.newOID)
					reports = append(reports, refReport{cmd.ref, true, ""})
				}
			}
		}
	} else {
		for _, cmd := range commands {
			reports = append(reports, refReport{cmd.ref, false, unpackDetail})
		}
	}

	// Bangun report-status sebagai pkt-lines.
	var inner bytes.Buffer
	inner.Write(encodePktLine([]byte("unpack " + unpackDetail + "\n")))
	for _, rep := range reports {
		if rep.ok {
			inner.Write(encodePktLine([]byte("ok " + rep.ref + "\n")))
		} else {
			inner.Write(encodePktLine([]byte("ng " + rep.ref + " " + rep.reason + "\n")))
		}
	}
	inner.WriteString("0000") // inner flush

	w.Header().Set("Content-Type", "application/x-git-receive-pack-result")
	w.WriteHeader(200)
	if sideband {
		// Seluruh report dalam satu paket band 1 (+ flush luar).
		outer := encodePktLine(append([]byte{1}, inner.Bytes()...))
		_, _ = w.Write(append(outer, []byte("0000")...))
	} else {
		_, _ = w.Write(append(inner.Bytes(), []byte("0000")...))
	}
}
