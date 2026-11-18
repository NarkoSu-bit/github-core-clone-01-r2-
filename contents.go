// Contents API + commits + git refs (dipakai permukaan REST).
// File disimpan sebagai objek git (blob/tree/commit) di branch yang diminta.
package main

import (
	"encoding/base64"
	"errors"
	"sort"
	"strings"
	"time"
)

var (
	ErrNotFound   = errors.New("not found")
	ErrRefExists  = errors.New("ref already exists")
	ErrUnknownSHA = errors.New("unknown sha")
)

type ContentFile struct {
	Type     string
	Encoding string
	Content  string // base64
	SHA      string
	Size     int
	Name     string
	Path     string
}

type ContentEntry struct {
	Type string
	Name string
	Path string
	SHA  string
	Size int
}

type CommitInfo struct {
	SHA     string
	Message string
}

// resolveRefLocked mengubah nama branch / SHA menjadi commit tip.
// ref "" = default branch. Mengembalikan "" bila tidak ada.
func resolveRefLocked(r *Repo, ref string) string {
	if ref == "" {
		ref = r.DefaultBranch
	}
	if isOID(ref) {
		if o, ok := r.Objects[ref]; ok && o.Type == "commit" {
			return ref
		}
		return ""
	}
	if tip, ok := r.Refs["refs/heads/"+ref]; ok {
		return tip
	}
	return ""
}

// PutContents membuat/mengubah file di branch ("" = default). Mengembalikan
// blob SHA, commit SHA, dan created (true bila file baru).
func (s *Store) PutContents(r *Repo, path string, content []byte, message, sha, branch string) (blobSHA, commitSHA string, created bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if branch == "" {
		branch = r.DefaultBranch
	}
	refName := "refs/heads/" + branch
	tip, hasTip := r.Refs[refName]
	if !hasTip && branch != r.DefaultBranch {
		return "", "", false, ErrBadBranch
	}
	// Tree saat ini.
	files := map[string]string{}
	if hasTip {
		if o, ok := r.Objects[tip]; ok && o.Type == "commit" {
			files = flattenTreeLocked(r, ParseCommit(o.Data).Tree)
		}
	}
	oldBlob, exists := files[path]
	if exists && sha != "" && !strings.EqualFold(sha, oldBlob) {
		return "", "", false, ErrStaleSHA
	}
	// Blob baru.
	blob := &GitObject{Type: "blob", Data: content}
	blobSHA = blob.OID()
	r.Objects[blobSHA] = blob
	files[path] = blobSHA
	created = !exists
	// Tree + commit baru.
	treeOID := buildTreeFromMapLocked(r, files)
	now := s.nextTimeLocked()
	viewer := Viewer()
	ident := viewer.Name + " <" + viewer.Email + ">"
	var parents []string
	if hasTip {
		parents = []string{tip}
	}
	commit := &GitObject{Type: "commit", Data: BuildCommit(treeOID, parents, ident, ident, now.Unix(), message)}
	commitSHA = commit.OID()
	r.Objects[commitSHA] = commit
	r.Refs[refName] = commitSHA
	r.UpdatedAt = now
	return blobSHA, commitSHA, created, nil
}

// GetContents membaca file/direktori pada ref ("" = default branch).
// Mengembalikan isDir, file (bila bukan dir), daftar entri (bila dir).
func (s *Store) GetContents(r *Repo, path, ref string) (bool, *ContentFile, []ContentEntry, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	tip := resolveRefLocked(r, ref)
	if tip == "" {
		return false, nil, nil, ErrNotFound
	}
	o, ok := r.Objects[tip]
	if !ok || o.Type != "commit" {
		return false, nil, nil, ErrNotFound
	}
	treeOID := ParseCommit(o.Data).Tree
	path = strings.Trim(path, "/")
	if path == "" {
		// Root.
		entries := dirEntriesLocked(r, treeOID, "")
		return true, nil, entries, nil
	}
	// Telusuri path.
	cur := treeOID
	parts := strings.Split(path, "/")
	for i, seg := range parts {
		obj, ok := r.Objects[cur]
		if !ok || obj.Type != "tree" {
			return false, nil, nil, ErrNotFound
		}
		var found *TreeEntry
		for _, e := range ParseTree(obj.Data) {
			if e.Name == seg {
				found = &e
				break
			}
		}
		if found == nil {
			return false, nil, nil, ErrNotFound
		}
		last := i == len(parts)-1
		if found.Mode == "40000" {
			if last {
				entries := dirEntriesLocked(r, found.OID, path)
				return true, nil, entries, nil
			}
			cur = found.OID
			continue
		}
		if !last {
			return false, nil, nil, ErrNotFound
		}
		blob, ok := r.Objects[found.OID]
		if !ok || blob.Type != "blob" {
			return false, nil, nil, ErrNotFound
		}
		return false, &ContentFile{
			Type:     "file",
			Encoding: "base64",
			Content:  base64.StdEncoding.EncodeToString(blob.Data),
			SHA:      found.OID,
			Size:     len(blob.Data),
			Name:     seg,
			Path:     path,
		}, nil, nil
	}
	return false, nil, nil, ErrNotFound
}

// dirEntriesLocked mengembalikan entri direktori pada tree.
func dirEntriesLocked(r *Repo, treeOID, prefix string) []ContentEntry {
	o, ok := r.Objects[treeOID]
	if !ok || o.Type != "tree" {
		return nil
	}
	var out []ContentEntry
	for _, e := range ParseTree(o.Data) {
		p := e.Name
		if prefix != "" {
			p = prefix + "/" + e.Name
		}
		ent := ContentEntry{Name: e.Name, Path: p, SHA: e.OID}
		if e.Mode == "40000" {
			ent.Type = "dir"
			ent.Size = 0
		} else {
			ent.Type = "file"
			if b, ok := r.Objects[e.OID]; ok {
				ent.Size = len(b.Data)
			}
		}
		out = append(out, ent)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// DeleteContents menghapus file (default branch). Mengembalikan commit SHA baru.
func (s *Store) DeleteContents(r *Repo, path, message, sha string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	refName := "refs/heads/" + r.DefaultBranch
	tip, ok := r.Refs[refName]
	if !ok {
		return "", ErrNotFound
	}
	o, ok := r.Objects[tip]
	if !ok || o.Type != "commit" {
		return "", ErrNotFound
	}
	files := flattenTreeLocked(r, ParseCommit(o.Data).Tree)
	oldBlob, exists := files[path]
	if !exists {
		return "", ErrNotFound
	}
	if sha != "" && !strings.EqualFold(sha, oldBlob) {
		return "", ErrStaleSHA
	}
	delete(files, path)
	treeOID := buildTreeFromMapLocked(r, files)
	now := s.nextTimeLocked()
	viewer := Viewer()
	ident := viewer.Name + " <" + viewer.Email + ">"
	commit := &GitObject{Type: "commit", Data: BuildCommit(treeOID, []string{tip}, ident, ident, now.Unix(), message)}
	commitSHA := commit.OID()
	r.Objects[commitSHA] = commit
	r.Refs[refName] = commitSHA
	r.UpdatedAt = now
	return commitSHA, nil
}

// ListCommits mengembalikan riwayat commit branch (terbaru dulu).
func (s *Store) ListCommits(r *Repo, branch string) ([]CommitInfo, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	tip := resolveRefLocked(r, branch)
	if tip == "" {
		return nil, ErrNotFound
	}
	var out []CommitInfo
	seen := map[string]bool{}
	queue := []string{tip}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		o, ok := r.Objects[cur]
		if !ok || o.Type != "commit" {
			continue
		}
		c := ParseCommit(o.Data)
		out = append(out, CommitInfo{SHA: cur, Message: c.Message})
		queue = append(queue, c.Parents...)
	}
	return out, nil
}

// CreateRef membuat ref baru (mis. refs/heads/feature) di sha.
func (s *Store) CreateRef(r *Repo, ref, sha string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := r.Refs[ref]; exists {
		return ErrRefExists
	}
	if _, ok := r.Objects[sha]; !ok {
		return ErrUnknownSHA
	}
	r.Refs[ref] = sha
	return nil
}

// CreateLabel membuat label (idempotent: label yang sudah ada dikembalikan).
func (s *Store) CreateLabel(r *Repo, name, color string) *Label {
	s.mu.Lock()
	defer s.mu.Unlock()
	if l, ok := r.Labels[name]; ok {
		return l
	}
	l := &Label{Name: name, Color: color}
	r.Labels[name] = l
	return l
}

// PatchRepo mengubah deskripsi repo.
func (s *Store) PatchRepo(r *Repo, description *string) *Repo {
	s.mu.Lock()
	defer s.mu.Unlock()
	if description != nil {
		r.Description = *description
	}
	r.UpdatedAt = s.nextTimeLocked()
	return r
}

// MergedAtISO mengembalikan merged_at PR sebagai ISO 8601 ("" bila belum merge).
func MergedAtISO(pr *Pull) string {
	if pr.MergedAt.IsZero() {
		return ""
	}
	return pr.MergedAt.UTC().Format(time.RFC3339)
}
