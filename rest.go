// REST v3 — implementasi lengkap dari git-forge-r5-specs/rest-spec.md.
// Stdlib saja. File ini hanya mendefinisikan registerRestRoutes + tipe JSON REST.
package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---------- tipe JSON ----------

type userJSON struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

type repoJSON struct {
	ID            int64     `json:"id"`
	Name          string    `json:"name"`
	FullName      string    `json:"full_name"`
	Owner         *userJSON `json:"owner"`
	Private       bool      `json:"private"`
	Description   string    `json:"description"`
	DefaultBranch string    `json:"default_branch"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

func toRepoJSON(r *Repo) *repoJSON {
	u := Viewer()
	return &repoJSON{
		ID:            r.ID,
		Name:          r.Name,
		FullName:      r.Owner + "/" + r.Name,
		Owner:         &userJSON{ID: u.ID, Login: r.Owner, Name: u.Name, Email: u.Email},
		Private:       r.Private,
		Description:   r.Description,
		DefaultBranch: r.DefaultBranch,
		CreatedAt:     r.CreatedAt,
		UpdatedAt:     r.UpdatedAt,
	}
}

func toUserJSON(login string) *userJSON {
	u := Viewer()
	return &userJSON{ID: u.ID, Login: login, Name: u.Name, Email: u.Email}
}

type labelJSON struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

func toLabelJSON(l *Label) labelJSON {
	return labelJSON{Name: l.Name, Color: l.Color}
}

type issueJSON struct {
	ID        int64       `json:"id"`
	Number    int         `json:"number"`
	Title     string      `json:"title"`
	Body      string      `json:"body"`
	State     string      `json:"state"`
	Labels    []labelJSON `json:"labels"`
	User      *userJSON   `json:"user"`
	CreatedAt time.Time   `json:"created_at"`
	UpdatedAt time.Time   `json:"updated_at"`
}

func toIssueJSON(r *Repo, iss *Issue) *issueJSON {
	labels := make([]labelJSON, 0, len(iss.Labels))
	for _, name := range iss.Labels {
		color := ""
		if l, ok := r.Labels[name]; ok {
			color = l.Color
		}
		labels = append(labels, labelJSON{Name: name, Color: color})
	}
	return &issueJSON{
		ID: iss.ID, Number: iss.Number, Title: iss.Title, Body: iss.Body,
		State: iss.State, Labels: labels, User: toUserJSON(iss.Author),
		CreatedAt: iss.CreatedAt, UpdatedAt: iss.UpdatedAt,
	}
}

type commentJSON struct {
	ID        int64     `json:"id"`
	Body      string    `json:"body"`
	User      *userJSON `json:"user"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func toCommentJSON(c *Comment) *commentJSON {
	return &commentJSON{ID: c.ID, Body: c.Body, User: toUserJSON(c.Author), CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt}
}

type refJSON struct {
	Ref string `json:"ref"`
	SHA string `json:"sha"`
}

type pullJSON struct {
	ID             int64    `json:"id"`
	Number         int      `json:"number"`
	Title          string   `json:"title"`
	Body           string   `json:"body"`
	State          string   `json:"state"`
	Head           refJSON  `json:"head"`
	Base           refJSON  `json:"base"`
	Merged         bool     `json:"merged"`
	Mergeable      bool     `json:"mergeable"`
	MergedAt       string   `json:"merged_at"`
	MergeCommitSHA string   `json:"merge_commit_sha"`
	User           *userJSON `json:"user"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

func toPullJSON(pr *Pull) *pullJSON {
	return &pullJSON{
		ID: pr.ID, Number: pr.Number, Title: pr.Title, Body: pr.Body,
		State: pr.State,
		Head:  refJSON{Ref: pr.Head, SHA: pr.HeadSHA},
		Base:  refJSON{Ref: pr.Base, SHA: pr.BaseSHA},
		Merged: pr.Merged, Mergeable: pr.Mergeable,
		MergedAt: MergedAtISO(pr), MergeCommitSHA: pr.MergeCommitSHA,
		User: toUserJSON(pr.Author), CreatedAt: pr.CreatedAt, UpdatedAt: pr.UpdatedAt,
	}
}

type pullFileJSON struct {
	Filename  string `json:"filename"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Changes   int    `json:"changes"`
}

type branchJSON struct {
	Name      string `json:"name"`
	Commit    struct {
		SHA string `json:"sha"`
	} `json:"commit"`
	Protected bool `json:"protected"`
}

type commitJSON struct {
	SHA    string `json:"sha"`
	Commit struct {
		Message string `json:"message"`
	} `json:"commit"`
}

type contentFileJSON struct {
	Type     string `json:"type"`
	Encoding string `json:"encoding"`
	Content  string `json:"content"`
	SHA      string `json:"sha"`
	Size     int    `json:"size"`
	Name     string `json:"name"`
	Path     string `json:"path"`
}

type contentEntryJSON struct {
	Type string `json:"type"`
	Name string `json:"name"`
	Path string `json:"path"`
	SHA  string `json:"sha"`
	Size int    `json:"size"`
}

type gitRefJSON struct {
	Ref    string `json:"ref"`
	Object struct {
		SHA  string `json:"sha"`
		Type string `json:"type"`
	} `json:"object"`
}

// ---------- helper ----------

// getRepoOr404 mengambil repo dari path owner/repo; 404 bila tidak ada.
func (s *Server) getRepoOr404(w http.ResponseWriter, r *http.Request) (*Repo, bool) {
	repo, ok := s.store.GetRepo(r.PathValue("owner"), r.PathValue("repo"))
	if !ok {
		s.writeErr(w, 404, "Not Found")
		return nil, false
	}
	return repo, true
}

func parseNumber(r *http.Request) (int, bool) {
	n, err := strconv.Atoi(r.PathValue("number"))
	if err != nil {
		return 0, false
	}
	return n, true
}

// decodeBody membaca JSON body; body kosong (EOF) dianggap tidak ada body
// (bukan malformed). JSON rusak -> false.
func decodeBody(r *http.Request, v any) bool {
	b, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	_ = r.Body.Close()
	if err != nil {
		return false
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return true
	}
	if err := json.Unmarshal(b, v); err != nil {
		return false
	}
	return true
}

// decodeBodyRequired: body wajib ada dan valid; bila tidak, tulis 400.
func (s *Server) decodeBodyRequired(w http.ResponseWriter, r *http.Request, v any) bool {
	if !decodeBody(r, v) {
		s.writeErr(w, 400, "malformed JSON")
		return false
	}
	return true
}

func queryInt(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		return def
	}
	return n
}

// pageSlice memotong slice ke halaman (page 1-based, perPage item).
func pageSlice[T any](items []T, page, perPage int) []T {
	if perPage < 1 {
		perPage = 30
	}
	if page < 1 {
		page = 1
	}
	start := (page - 1) * perPage
	if start >= len(items) {
		return []T{}
	}
	end := start + perPage
	if end > len(items) {
		end = len(items)
	}
	return items[start:end]
}

// absoluteURL membangun URL absolut satu origin dari request.
func absoluteURL(r *http.Request, path string, q url.Values) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	u := url.URL{Scheme: scheme, Host: r.Host, Path: path, RawQuery: q.Encode()}
	return u.String()
}

// ---------- registrasi ----------

func registerRestRoutes(s *Server) {
	// GET /api/v3/ — root.
	rootHandler := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-OAuth-Scopes", "repo, user, admin:org")
		s.writeJSON(w, 200, map[string]any{"message": "GitHub API", "documentation_url": "https://docs.github.com/rest"})
	}
	// {$} = cocok persis, bukan subtree — route tak dikenal di bawah /api/v3/
	// harus jatuh ke catch-all 404 JSON di routes.go.
	s.handle("GET /api/v3/{$}", rootHandler)
	s.handle("GET /api/v3", rootHandler)

	// GET /api/v3/meta
	s.handle("GET /api/v3/meta", func(w http.ResponseWriter, r *http.Request) {
		s.writeJSON(w, 200, map[string]any{"installed_version": "3.0.0"})
	})

	// POST /api/v3/user/repos
	s.handle("POST /api/v3/user/repos", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Private     bool   `json:"private"`
		}
		if !s.decodeBodyRequired(w, r, &body) {
			return
		}
		if strings.TrimSpace(body.Name) == "" {
			s.writeErr(w, 422, "name is required")
			return
		}
		owner := Viewer().Login
		repo, err := s.store.CreateRepo(owner, body.Name, body.Description, body.Private)
		if err != nil {
			s.writeErr(w, 422, "Repository already exists")
			return
		}
		s.writeJSON(w, 201, toRepoJSON(repo))
	})

	// GET /api/v3/user/repos — pagination Link rel="next".
	s.handle("GET /api/v3/user/repos", func(w http.ResponseWriter, r *http.Request) {
		perPage := queryInt(r, "per_page", 30)
		page := queryInt(r, "page", 1)
		repos := s.store.ListRepos(Viewer().Login)
		total := len(repos)
		items := pageSlice(repos, page, perPage)
		out := make([]*repoJSON, 0, len(items))
		for _, repo := range items {
			out = append(out, toRepoJSON(repo))
		}
		if page*perPage < total {
			nq := url.Values{}
			nq.Set("per_page", strconv.Itoa(perPage))
			nq.Set("page", strconv.Itoa(page+1))
			next := absoluteURL(r, "/api/v3/user/repos", nq)
			w.Header().Set("Link", "<"+next+">; rel=\"next\"")
		}
		s.writeJSON(w, 200, out)
	})

	// GET /api/v3/repos/{owner}/{repo}
	s.handle("GET /api/v3/repos/{owner}/{repo}", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		s.writeJSON(w, 200, toRepoJSON(repo))
	})

	// PATCH /api/v3/repos/{owner}/{repo}
	s.handle("PATCH /api/v3/repos/{owner}/{repo}", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		var body struct {
			Description *string `json:"description"`
		}
		if !s.decodeBodyRequired(w, r, &body) {
			return
		}
		repo = s.store.PatchRepo(repo, body.Description)
		s.writeJSON(w, 200, toRepoJSON(repo))
	})

	// DELETE /api/v3/repos/{owner}/{repo}
	s.handle("DELETE /api/v3/repos/{owner}/{repo}", func(w http.ResponseWriter, r *http.Request) {
		if !s.store.DeleteRepo(r.PathValue("owner"), r.PathValue("repo")) {
			s.writeErr(w, 404, "Not Found")
			return
		}
		w.Header().Set("X-GitHub-Request-Id", s.nextRequestID())
		w.WriteHeader(204)
	})

	// POST /api/v3/repos/{owner}/{repo}/git/refs
	s.handle("POST /api/v3/repos/{owner}/{repo}/git/refs", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		var body struct {
			Ref string `json:"ref"`
			SHA string `json:"sha"`
		}
		if !s.decodeBodyRequired(w, r, &body) {
			return
		}
		if err := s.store.CreateRef(repo, body.Ref, body.SHA); err != nil {
			if err == ErrRefExists {
				s.writeErr(w, 422, "Reference already exists")
			} else {
				s.writeErr(w, 422, "Invalid sha")
			}
			return
		}
		var out gitRefJSON
		out.Ref = body.Ref
		out.Object.SHA = body.SHA
		out.Object.Type = "commit"
		s.writeJSON(w, 201, out)
	})

	// GET /api/v3/repos/{owner}/{repo}/branches
	s.handle("GET /api/v3/repos/{owner}/{repo}/branches", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		refs := s.store.ListRefs(repo)
		names := make([]string, 0, len(refs))
		for ref := range refs {
			if strings.HasPrefix(ref, "refs/heads/") {
				names = append(names, strings.TrimPrefix(ref, "refs/heads/"))
			}
		}
		sort.Strings(names)
		out := make([]branchJSON, 0, len(names))
		for _, name := range names {
			var b branchJSON
			b.Name = name
			b.Commit.SHA = refs["refs/heads/"+name]
			out = append(out, b)
		}
		s.writeJSON(w, 200, out)
	})

	// GET /api/v3/repos/{owner}/{repo}/commits
	s.handle("GET /api/v3/repos/{owner}/{repo}/commits", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		branch := r.URL.Query().Get("sha")
		commits, err := s.store.ListCommits(repo, branch)
		if err != nil {
			s.writeErr(w, 404, "Not Found")
			return
		}
		out := make([]commitJSON, 0, len(commits))
		for _, c := range commits {
			var cj commitJSON
			cj.SHA = c.SHA
			cj.Commit.Message = c.Message
			out = append(out, cj)
		}
		s.writeJSON(w, 200, out)
	})

	// PUT /api/v3/repos/{owner}/{repo}/contents/{path...}
	s.handle("PUT /api/v3/repos/{owner}/{repo}/contents/{path...}", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		var body struct {
			Message string `json:"message"`
			Content string `json:"content"`
			Branch  string `json:"branch"`
			SHA     string `json:"sha"`
		}
		if !s.decodeBodyRequired(w, r, &body) {
			return
		}
		raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(body.Content))
		if err != nil {
			// Coba base64 tanpa padding / raw.
			raw, err = base64.RawStdEncoding.DecodeString(strings.TrimSpace(body.Content))
			if err != nil {
				s.writeErr(w, 400, "content is not valid base64")
				return
			}
		}
		path := r.PathValue("path")
		blobSHA, commitSHA, created, err := s.store.PutContents(repo, path, raw, body.Message, body.SHA, body.Branch)
		if err != nil {
			switch err {
			case ErrStaleSHA:
				s.writeErr(w, 409, "sha does not match current file")
			case ErrBadBranch:
				s.writeErr(w, 422, "unknown branch")
			default:
				s.writeErr(w, 400, err.Error())
			}
			return
		}
		status := 200
		if created {
			status = 201
		}
		name := path
		if i := strings.LastIndex(path, "/"); i >= 0 {
			name = path[i+1:]
		}
		s.writeJSON(w, status, map[string]any{
			"content": map[string]any{
				"type": "file", "encoding": "base64", "name": name, "path": path,
				"sha": blobSHA, "size": len(raw),
			},
			"commit": map[string]any{"sha": commitSHA},
		})
	})

	// GET /api/v3/repos/{owner}/{repo}/contents/{path...}
	s.handle("GET /api/v3/repos/{owner}/{repo}/contents/{path...}", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		path := r.PathValue("path")
		ref := r.URL.Query().Get("ref")
		isDir, file, entries, err := s.store.GetContents(repo, path, ref)
		if err != nil {
			s.writeErr(w, 404, "Not Found")
			return
		}
		if isDir {
			out := make([]contentEntryJSON, 0, len(entries))
			for _, e := range entries {
				out = append(out, contentEntryJSON{Type: e.Type, Name: e.Name, Path: e.Path, SHA: e.SHA, Size: e.Size})
			}
			s.writeJSON(w, 200, out)
			return
		}
		s.writeJSON(w, 200, contentFileJSON{
			Type: file.Type, Encoding: file.Encoding, Content: file.Content,
			SHA: file.SHA, Size: file.Size, Name: file.Name, Path: file.Path,
		})
	})

	// DELETE /api/v3/repos/{owner}/{repo}/contents/{path...}
	s.handle("DELETE /api/v3/repos/{owner}/{repo}/contents/{path...}", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		var body struct {
			Message string `json:"message"`
			SHA     string `json:"sha"`
		}
		if !decodeBody(r, &body) {
			s.writeErr(w, 400, "malformed JSON")
			return
		}
		commitSHA, err := s.store.DeleteContents(repo, r.PathValue("path"), body.Message, body.SHA)
		if err != nil {
			switch err {
			case ErrNotFound:
				s.writeErr(w, 404, "Not Found")
			case ErrStaleSHA:
				s.writeErr(w, 409, "sha does not match current file")
			default:
				s.writeErr(w, 400, err.Error())
			}
			return
		}
		s.writeJSON(w, 200, map[string]any{"commit": map[string]any{"sha": commitSHA}})
	})

	// POST /api/v3/repos/{owner}/{repo}/labels
	s.handle("POST /api/v3/repos/{owner}/{repo}/labels", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		var body struct {
			Name  string `json:"name"`
			Color string `json:"color"`
		}
		if !s.decodeBodyRequired(w, r, &body) {
			return
		}
		if strings.TrimSpace(body.Name) == "" {
			s.writeErr(w, 422, "name is required")
			return
		}
		l := s.store.CreateLabel(repo, body.Name, body.Color)
		s.writeJSON(w, 201, toLabelJSON(l))
	})

	// POST /api/v3/repos/{owner}/{repo}/issues
	s.handle("POST /api/v3/repos/{owner}/{repo}/issues", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		var body struct {
			Title  string   `json:"title"`
			Body   string   `json:"body"`
			Labels []string `json:"labels"`
		}
		if !s.decodeBodyRequired(w, r, &body) {
			return
		}
		iss, err := s.store.CreateIssue(repo, body.Title, body.Body, body.Labels)
		if err != nil {
			if err == ErrLabelNotFound {
				s.writeErr(w, 422, "label not found")
			} else {
				s.writeErr(w, 400, err.Error())
			}
			return
		}
		s.writeJSON(w, 201, toIssueJSON(repo, iss))
	})

	// GET /api/v3/repos/{owner}/{repo}/issues
	s.handle("GET /api/v3/repos/{owner}/{repo}/issues", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		q := r.URL.Query()
		state := q.Get("state")
		if state == "all" {
			state = ""
		}
		issues := s.store.ListIssues(repo, state)
		// sort=created: nomor naik == urutan pembuatan (timestamp strictly naik).
		if q.Get("sort") == "created" && q.Get("direction") == "desc" {
			for i, j := 0, len(issues)-1; i < j; i, j = i+1, j-1 {
				issues[i], issues[j] = issues[j], issues[i]
			}
		}
		perPage := queryInt(r, "per_page", 30)
		page := queryInt(r, "page", 1)
		issues = pageSlice(issues, page, perPage)
		out := make([]*issueJSON, 0, len(issues))
		for _, iss := range issues {
			out = append(out, toIssueJSON(repo, iss))
		}
		s.writeJSON(w, 200, out)
	})

	// GET /api/v3/repos/{owner}/{repo}/issues/{number}
	s.handle("GET /api/v3/repos/{owner}/{repo}/issues/{number}", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		n, good := parseNumber(r)
		if !good {
			s.writeErr(w, 404, "Not Found")
			return
		}
		iss, found := s.store.GetIssue(repo, n)
		if !found {
			s.writeErr(w, 404, "Not Found")
			return
		}
		s.writeJSON(w, 200, toIssueJSON(repo, iss))
	})

	// PATCH /api/v3/repos/{owner}/{repo}/issues/{number}
	s.handle("PATCH /api/v3/repos/{owner}/{repo}/issues/{number}", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		n, good := parseNumber(r)
		if !good {
			s.writeErr(w, 404, "Not Found")
			return
		}
		var body struct {
			Title  *string   `json:"title"`
			Body   *string   `json:"body"`
			State  *string   `json:"state"`
			Labels *[]string `json:"labels"`
		}
		if !s.decodeBodyRequired(w, r, &body) {
			return
		}
		var labels []string
		if body.Labels != nil {
			labels = *body.Labels
		}
		iss, err := s.store.PatchIssue(repo, n, body.Title, body.Body, body.State, labels)
		if err != nil {
			switch err {
			case ErrIssueNotFound:
				s.writeErr(w, 404, "Not Found")
			case ErrLabelNotFound:
				s.writeErr(w, 422, "label not found")
			default:
				s.writeErr(w, 400, err.Error())
			}
			return
		}
		s.writeJSON(w, 200, toIssueJSON(repo, iss))
	})

	// POST /api/v3/repos/{owner}/{repo}/issues/{number}/comments
	s.handle("POST /api/v3/repos/{owner}/{repo}/issues/{number}/comments", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		n, good := parseNumber(r)
		if !good {
			s.writeErr(w, 404, "Not Found")
			return
		}
		var body struct {
			Body string `json:"body"`
		}
		if !s.decodeBodyRequired(w, r, &body) {
			return
		}
		c, err := s.store.CreateComment(repo, n, body.Body)
		if err != nil {
			s.writeErr(w, 404, "Not Found")
			return
		}
		s.writeJSON(w, 201, toCommentJSON(c))
	})

	// GET /api/v3/repos/{owner}/{repo}/issues/{number}/comments
	s.handle("GET /api/v3/repos/{owner}/{repo}/issues/{number}/comments", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		n, good := parseNumber(r)
		if !good {
			s.writeErr(w, 404, "Not Found")
			return
		}
		comments, err := s.store.ListComments(repo, n)
		if err != nil {
			s.writeErr(w, 404, "Not Found")
			return
		}
		out := make([]*commentJSON, 0, len(comments))
		for _, c := range comments {
			out = append(out, toCommentJSON(c))
		}
		s.writeJSON(w, 200, out)
	})

	// POST /api/v3/repos/{owner}/{repo}/pulls
	s.handle("POST /api/v3/repos/{owner}/{repo}/pulls", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		var body struct {
			Title string `json:"title"`
			Body  string `json:"body"`
			Head  string `json:"head"`
			Base  string `json:"base"`
		}
		if !s.decodeBodyRequired(w, r, &body) {
			return
		}
		pr, err := s.store.CreatePull(repo, body.Title, body.Body, body.Head, body.Base)
		if err != nil {
			if err == ErrBadBranch {
				s.writeErr(w, 422, "unknown head or base branch")
			} else {
				s.writeErr(w, 400, err.Error())
			}
			return
		}
		s.writeJSON(w, 201, toPullJSON(pr))
	})

	// GET /api/v3/repos/{owner}/{repo}/pulls
	s.handle("GET /api/v3/repos/{owner}/{repo}/pulls", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		q := r.URL.Query()
		state := q.Get("state")
		if state == "" {
			state = "open" // default: hanya open
		}
		pulls := s.store.ListPulls(repo, state)
		perPage := queryInt(r, "per_page", 30)
		page := queryInt(r, "page", 1)
		pulls = pageSlice(pulls, page, perPage)
		out := make([]*pullJSON, 0, len(pulls))
		for _, pr := range pulls {
			out = append(out, toPullJSON(pr))
		}
		s.writeJSON(w, 200, out)
	})

	// GET /api/v3/repos/{owner}/{repo}/pulls/{number}
	s.handle("GET /api/v3/repos/{owner}/{repo}/pulls/{number}", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		n, good := parseNumber(r)
		if !good {
			s.writeErr(w, 404, "Not Found")
			return
		}
		pr, found := s.store.GetPull(repo, n)
		if !found {
			s.writeErr(w, 404, "Not Found")
			return
		}
		s.writeJSON(w, 200, toPullJSON(pr))
	})

	// GET /api/v3/repos/{owner}/{repo}/pulls/{number}/files
	s.handle("GET /api/v3/repos/{owner}/{repo}/pulls/{number}/files", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		n, good := parseNumber(r)
		if !good {
			s.writeErr(w, 404, "Not Found")
			return
		}
		pr, found := s.store.GetPull(repo, n)
		if !found {
			s.writeErr(w, 404, "Not Found")
			return
		}
		out := make([]pullFileJSON, 0, len(pr.Files))
		for _, f := range pr.Files {
			out = append(out, pullFileJSON{
				Filename: f.Filename, Status: f.Status,
				Additions: f.Additions, Deletions: f.Deletions, Changes: f.Changes,
			})
		}
		s.writeJSON(w, 200, out)
	})

	// PUT /api/v3/repos/{owner}/{repo}/pulls/{number}/merge
	s.handle("PUT /api/v3/repos/{owner}/{repo}/pulls/{number}/merge", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := s.getRepoOr404(w, r)
		if !ok {
			return
		}
		n, good := parseNumber(r)
		if !good {
			s.writeErr(w, 404, "Not Found")
			return
		}
		var body struct {
			MergeMethod string `json:"merge_method"`
		}
		// Body boleh kosong; JSON rusak -> 400.
		if !decodeBody(r, &body) {
			s.writeErr(w, 400, "malformed JSON")
			return
		}
		pr, err := s.store.MergePull(repo, n, body.MergeMethod)
		if err != nil {
			switch err {
			case ErrPullNotFound:
				s.writeErr(w, 404, "Not Found")
			case ErrConflict:
				s.writeErr(w, 405, "merge conflict")
			case ErrBadBranch:
				s.writeErr(w, 422, "unknown base branch")
			default:
				s.writeErr(w, 400, err.Error())
			}
			return
		}
		s.writeJSON(w, 200, map[string]any{
			"merged":  true,
			"sha":     pr.MergeCommitSHA,
			"message": "Pull request successfully merged",
		})
	})
}
