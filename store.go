// Domain + Store: semua state server tinggal di memori, di bawah satu RWMutex.
// Semua metode publik mengunci sendiri; helper ber-suffix Locked dipanggil dengan
// lock sudah dipegang.
package main

import (
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"sort"
	"sync"
	"time"
)

type User struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

type Label struct {
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
}

type Comment struct {
	ID        int64     `json:"id"`
	Body      string    `json:"body"`
	Author    string    `json:"-"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Issue struct {
	ID        int64      `json:"id"`
	Number    int        `json:"number"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	State     string     `json:"state"` // open | closed
	Labels    []string   `json:"labels"`
	Author    string     `json:"-"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	Comments  []*Comment `json:"-"`
}

type PRFile struct {
	Filename  string `json:"filename"`
	Status    string `json:"status"` // added | modified | removed
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Changes   int    `json:"changes"`
}

type Pull struct {
	ID             int64     `json:"id"`
	Number         int       `json:"number"`
	Title          string    `json:"title"`
	Body           string    `json:"body"`
	Head           string    `json:"-"`
	Base           string    `json:"-"`
	HeadSHA        string    `json:"-"`
	BaseSHA        string    `json:"-"`
	State          string    `json:"state"` // open | closed
	Merged         bool      `json:"merged"`
	Mergeable      bool      `json:"mergeable"`
	MergeCommitSHA string    `json:"-"`
	MergedAt       time.Time `json:"-"`
	Files          []PRFile  `json:"-"`
	Author         string    `json:"-"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// GitObject adalah satu objek git (isinya saja; OID dihitung dari type+data).
type GitObject struct {
	Type string
	Data []byte
}

// OID menghitung SHA-1 "type size\0data".
func (o *GitObject) OID() string {
	h := sha1.New()
	h.Write([]byte(o.Type))
	h.Write([]byte(" "))
	h.Write([]byte(itoa(len(o.Data))))
	h.Write([]byte{0})
	h.Write(o.Data)
	return hex.EncodeToString(h.Sum(nil))
}

type Repo struct {
	ID            int64
	Owner         string
	Name          string
	Description   string
	Private       bool
	DefaultBranch string
	CreatedAt     time.Time
	UpdatedAt     time.Time
	Refs          map[string]string // ref lengkap -> oid
	Objects       map[string]*GitObject
	Gen           uint64 // naik tiap mutasi objek/ref — kunci invalidasi pack cache
	Issues        map[int]*Issue
	IssueSeq      int
	Pulls         map[int]*Pull
	PullSeq       int
	Labels        map[string]*Label
}

type Store struct {
	mu       sync.RWMutex
	repos    map[string]*Repo // key owner + "/" + name
	repoSeq  int64
	commentSeq int64
	lastTime time.Time
}

func NewStore() *Store {
	return &Store{repos: map[string]*Repo{}}
}

// nextTimeLocked mengembalikan timestamp yang strictly naik (untuk sort stabil).
func (s *Store) nextTimeLocked() time.Time {
	now := time.Now().UTC()
	if !now.After(s.lastTime) {
		now = s.lastTime.Add(time.Millisecond)
	}
	s.lastTime = now
	return now
}

func repoKey(owner, name string) string { return owner + "/" + name }

var (
	ErrRepoExists    = errors.New("repository already exists")
	ErrRepoNotFound  = errors.New("repository not found")
	ErrIssueNotFound = errors.New("issue not found")
	ErrPullNotFound  = errors.New("pull request not found")
	ErrLabelNotFound = errors.New("label not found")
	ErrStaleSHA      = errors.New("stale sha")
	ErrConflict      = errors.New("merge conflict")
	ErrBadBranch     = errors.New("unknown branch")
)

func (s *Store) CreateRepo(owner, name, desc string, priv bool) (*Repo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := repoKey(owner, name)
	if _, ok := s.repos[key]; ok {
		return nil, ErrRepoExists
	}
	s.repoSeq++
	now := s.nextTimeLocked()
	r := &Repo{
		ID:            s.repoSeq,
		Owner:         owner,
		Name:          name,
		Description:   desc,
		Private:       priv,
		DefaultBranch: "main",
		CreatedAt:     now,
		UpdatedAt:     now,
		Refs:          map[string]string{},
		Objects:       map[string]*GitObject{},
		Issues:        map[int]*Issue{},
		Pulls:         map[int]*Pull{},
		Labels:        map[string]*Label{},
	}
	for _, n := range []string{"bug", "enhancement", "documentation", "question", "good first issue", "help wanted"} {
		r.Labels[n] = &Label{Name: n, Color: "ededed", Description: ""}
	}
	s.repos[key] = r
	return r, nil
}

func (s *Store) GetRepo(owner, name string) (*Repo, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.repos[repoKey(owner, name)]
	return r, ok
}

func (s *Store) DeleteRepo(owner, name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := repoKey(owner, name)
	if _, ok := s.repos[key]; !ok {
		return false
	}
	delete(s.repos, key)
	return true
}

func (s *Store) ListRepos(owner string) []*Repo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*Repo
	for _, r := range s.repos {
		if r.Owner == owner {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// --- issues ---

func (s *Store) CreateIssue(r *Repo, title, body string, labels []string) (*Issue, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range labels {
		if _, ok := r.Labels[l]; !ok {
			return nil, ErrLabelNotFound
		}
	}
	r.IssueSeq++
	now := s.nextTimeLocked()
	iss := &Issue{
		ID:        int64(r.ID*1000000 + int64(r.IssueSeq)),
		Number:    r.IssueSeq,
		Title:     title,
		Body:      body,
		State:     "open",
		Labels:    append([]string(nil), labels...),
		Author:    Viewer().Login,
		CreatedAt: now,
		UpdatedAt: now,
	}
	r.Issues[iss.Number] = iss
	return iss, nil
}

func (s *Store) GetIssue(r *Repo, n int) (*Issue, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	iss, ok := r.Issues[n]
	return iss, ok
}

// ListIssues mengembalikan issue terurut nomor naik; state "" = semua.
func (s *Store) ListIssues(r *Repo, state string) []*Issue {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*Issue
	for _, iss := range r.Issues {
		if state == "" || iss.State == state {
			out = append(out, iss)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Number < out[j].Number })
	return out
}

// PatchIssue mengubah title/body/state/labels (nil = tidak berubah).
func (s *Store) PatchIssue(r *Repo, n int, title, body, state *string, labels []string) (*Issue, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	iss, ok := r.Issues[n]
	if !ok {
		return nil, ErrIssueNotFound
	}
	if labels != nil {
		for _, l := range labels {
			if _, ok := r.Labels[l]; !ok {
				return nil, ErrLabelNotFound
			}
		}
		iss.Labels = append([]string(nil), labels...)
	}
	if title != nil {
		iss.Title = *title
	}
	if body != nil {
		iss.Body = *body
	}
	if state != nil {
		iss.State = *state
	}
	iss.UpdatedAt = s.nextTimeLocked()
	return iss, nil
}

func (s *Store) CreateComment(r *Repo, issueN int, body string) (*Comment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	iss, ok := r.Issues[issueN]
	if !ok {
		return nil, ErrIssueNotFound
	}
	s.commentSeq++
	now := s.nextTimeLocked()
	c := &Comment{ID: s.commentSeq, Body: body, Author: Viewer().Login, CreatedAt: now, UpdatedAt: now}
	iss.Comments = append(iss.Comments, c)
	iss.UpdatedAt = now
	return c, nil
}

func (s *Store) ListComments(r *Repo, issueN int) ([]*Comment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	iss, ok := r.Issues[issueN]
	if !ok {
		return nil, ErrIssueNotFound
	}
	return append([]*Comment(nil), iss.Comments...), nil
}

// --- pulls ---

func (s *Store) CreatePull(r *Repo, title, body, head, base string) (*Pull, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	headRef := "refs/heads/" + head
	baseRef := "refs/heads/" + base
	headSHA, ok := r.Refs[headRef]
	if !ok {
		return nil, ErrBadBranch
	}
	baseSHA, ok := r.Refs[baseRef]
	if !ok {
		return nil, ErrBadBranch
	}
	r.PullSeq++
	now := s.nextTimeLocked()
	pr := &Pull{
		ID:        int64(r.ID*1000000 + 500000 + int64(r.PullSeq)),
		Number:    r.PullSeq,
		Title:     title,
		Body:      body,
		Head:      head,
		Base:      base,
		HeadSHA:   headSHA,
		BaseSHA:   baseSHA,
		State:     "open",
		Merged:    false,
		Author:    Viewer().Login,
		CreatedAt: now,
		UpdatedAt: now,
	}
	pr.Files = diffTreesLocked(r, baseSHA, headSHA)
	pr.Mergeable = mergeableLocked(r, baseSHA, headSHA)
	r.Pulls[pr.Number] = pr
	return pr, nil
}

func (s *Store) GetPull(r *Repo, n int) (*Pull, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	pr, ok := r.Pulls[n]
	return pr, ok
}

func (s *Store) ListPulls(r *Repo, state string) []*Pull {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*Pull
	for _, pr := range r.Pulls {
		if state == "" || state == "all" || pr.State == state {
			out = append(out, pr)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Number < out[j].Number })
	return out
}

// MergePull menggabungkan PR (squash: satu commit di base branch, tree = tree head).
// Mergeability DIHITUNG ULANG terhadap tip base SAAT INI (bukan saat PR dibuat):
// PR B yang tadinya mergeable bisa jadi conflicted setelah PR A di-merge lebih dulu.
func (s *Store) MergePull(r *Repo, n int, method string) (*Pull, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pr, ok := r.Pulls[n]
	if !ok {
		return nil, ErrPullNotFound
	}
	if pr.Merged || pr.State == "closed" {
		return pr, nil
	}
	baseRef := "refs/heads/" + pr.Base
	baseTip, ok := r.Refs[baseRef]
	if !ok {
		return nil, ErrBadBranch
	}
	if !mergeableLocked(r, baseTip, pr.HeadSHA) {
		pr.Mergeable = false
		return nil, ErrConflict
	}
	pr.Mergeable = true
	// Tree hasil merge: tree head (head turunan base di skenario uji; kalau ada
	// perubahan base yang tidak konflik, terapkan perubahan head di atas tree base).
	mergedTree := mergeTreesLocked(r, baseTip, pr.HeadSHA)
	if mergedTree == "" {
		pr.Mergeable = false
		return nil, ErrConflict
	}
	now := s.nextTimeLocked()
	viewer := Viewer()
	ident := viewer.Name + " <" + viewer.Email + ">"
	msg := pr.Title
	commit := &GitObject{
		Type: "commit",
		Data: BuildCommit(mergedTree, []string{baseTip}, ident, ident, now.Unix(), msg),
	}
	commitOID := commit.OID()
	r.Objects[commitOID] = commit
	r.Refs[baseRef] = commitOID
	pr.Merged = true
	pr.State = "closed"
	pr.MergeCommitSHA = commitOID
	pr.MergedAt = now
	pr.UpdatedAt = now
	return pr, nil
}

// --- git objects & refs ---

func (s *Store) GetObject(r *Repo, oid string) (*GitObject, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	o, ok := r.Objects[oid]
	return o, ok
}

func (s *Store) PutObjects(r *Repo, objs []*GitObject) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, o := range objs {
		r.Objects[o.OID()] = o
	}
	r.Gen++
}

// RepoGen membaca generasi repo di bawah lock (untuk kunci pack cache).
func (s *Store) RepoGen(r *Repo) uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return r.Gen
}

func (s *Store) GetRef(r *Repo, ref string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	oid, ok := r.Refs[ref]
	return oid, ok
}

func (s *Store) SetRef(r *Repo, ref, oid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if oid == "" {
		delete(r.Refs, ref)
	} else {
		r.Refs[ref] = oid
	}
	r.Gen++
}

// ListRefs mengembalikan salinan semua ref.
func (s *Store) ListRefs(r *Repo) map[string]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]string, len(r.Refs))
	for k, v := range r.Refs {
		out[k] = v
	}
	return out
}

// SnapshotObjects menyalin objek yang diminta (untuk pack generation di luar lock).
func (s *Store) SnapshotObjects(r *Repo, oids []string) []*GitObject {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*GitObject, 0, len(oids))
	for _, oid := range oids {
		if o, ok := r.Objects[oid]; ok {
			out = append(out, o)
		}
	}
	return out
}

// PeelTag mengupas tag annotated ke commit target (dengan lock).
func (s *Store) PeelTag(r *Repo, oid string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return peelTag(r, oid)
}

// PlanFetch merencanakan fetch (dengan lock baca).
func (s *Store) PlanFetch(r *Repo, wants, haves, shallow []string, depth int) fetchPlan {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return planFetch(r, wants, haves, shallow, depth)
}

// IsAncestor memeriksa apakah anc adalah ancestor (atau sama) dari desc.
func (s *Store) IsAncestor(r *Repo, anc, desc string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return isAncestorLocked(r, anc, desc)
}
