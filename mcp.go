// MCP — POST /mcp, JSON-RPC 2.0 Streamable HTTP (stdlib saja).
// Mendukung era modern (server/discover, revisi 2026-07-28) dan legacy
// (initialize + notifications/initialized).
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ---------- definisi tool (deterministik, dibangun sekali) ----------

type mcp_prop struct {
	Type        string `json:"type"`
	Description string `json:"description,omitempty"`
}

type mcp_schema struct {
	Type       string              `json:"type"`
	Properties map[string]mcp_prop `json:"properties"`
	Required   []string            `json:"required,omitempty"`
}

type mcp_toolDef struct {
	Name        string     `json:"name"`
	Description string     `json:"description"`
	InputSchema mcp_schema `json:"inputSchema"`
}

func mcp_strProp(desc string) mcp_prop  { return mcp_prop{Type: "string", Description: desc} }
func mcp_boolProp(desc string) mcp_prop { return mcp_prop{Type: "boolean", Description: desc} }
func mcp_intProp(desc string) mcp_prop  { return mcp_prop{Type: "integer", Description: desc} }

var mcp_tools = []mcp_toolDef{
	{
		Name:        "create_repo",
		Description: "Create a new repository owned by the viewer.",
		InputSchema: mcp_schema{Type: "object", Properties: map[string]mcp_prop{
			"owner":       mcp_strProp("Owner login of the repository"),
			"name":        mcp_strProp("Repository name"),
			"description": mcp_strProp("Repository description"),
			"private":     mcp_boolProp("Whether the repository is private"),
			"full_name":   mcp_strProp("Full repository name owner/repo"),
		}, Required: []string{"name"}},
	},
	{
		Name:        "get_repo",
		Description: "Get a repository by owner and name.",
		InputSchema: mcp_schema{Type: "object", Properties: map[string]mcp_prop{
			"owner":     mcp_strProp("Owner login of the repository"),
			"repo":      mcp_strProp("Repository name"),
			"full_name": mcp_strProp("Full repository name owner/repo"),
		}, Required: []string{"owner", "repo"}},
	},
	{
		Name:        "create_issue",
		Description: "Create an issue in a repository.",
		InputSchema: mcp_schema{Type: "object", Properties: map[string]mcp_prop{
			"owner":     mcp_strProp("Owner login of the repository"),
			"repo":      mcp_strProp("Repository name"),
			"full_name": mcp_strProp("Full repository name owner/repo"),
			"title":     mcp_strProp("Issue title"),
			"body":      mcp_strProp("Issue body"),
		}, Required: []string{"owner", "repo", "title"}},
	},
	{
		Name:        "list_issues",
		Description: "List issues in a repository.",
		InputSchema: mcp_schema{Type: "object", Properties: map[string]mcp_prop{
			"owner":     mcp_strProp("Owner login of the repository"),
			"repo":      mcp_strProp("Repository name"),
			"full_name": mcp_strProp("Full repository name owner/repo"),
			"state":     mcp_strProp("Issue state filter: open, closed, or all"),
		}, Required: []string{"owner", "repo"}},
	},
	{
		Name:        "create_pull_request",
		Description: "Create a pull request in a repository.",
		InputSchema: mcp_schema{Type: "object", Properties: map[string]mcp_prop{
			"owner":     mcp_strProp("Owner login of the repository"),
			"repo":      mcp_strProp("Repository name"),
			"full_name": mcp_strProp("Full repository name owner/repo"),
			"title":     mcp_strProp("Pull request title"),
			"body":      mcp_strProp("Pull request body"),
			"head":      mcp_strProp("Head branch name"),
			"base":      mcp_strProp("Base branch name"),
		}, Required: []string{"owner", "repo", "title", "head", "base"}},
	},
	{
		Name:        "merge_pull_request",
		Description: "Merge a pull request in a repository.",
		InputSchema: mcp_schema{Type: "object", Properties: map[string]mcp_prop{
			"owner":       mcp_strProp("Owner login of the repository"),
			"repo":        mcp_strProp("Repository name"),
			"full_name":   mcp_strProp("Full repository name owner/repo"),
			"pull_number": mcp_intProp("Pull request number"),
			"number":      mcp_intProp("Pull request number"),
		}, Required: []string{"owner", "repo"}},
	},
	{
		Name:        "get_issue",
		Description: "Get a single issue by number in a repository.",
		InputSchema: mcp_schema{Type: "object", Properties: map[string]mcp_prop{
			"owner":  mcp_strProp("Owner login of the repository"),
			"repo":   mcp_strProp("Repository name"),
			"number": mcp_intProp("Issue number"),
		}, Required: []string{"owner", "repo", "number"}},
	},
	{
		Name:        "close_issue",
		Description: "Close an issue by number in a repository.",
		InputSchema: mcp_schema{Type: "object", Properties: map[string]mcp_prop{
			"owner":  mcp_strProp("Owner login of the repository"),
			"repo":   mcp_strProp("Repository name"),
			"number": mcp_intProp("Issue number"),
		}, Required: []string{"owner", "repo", "number"}},
	},
}

var mcp_supportedVersions = []string{"2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

func mcp_serverInfo() map[string]any {
	return map[string]any{"name": "forge", "version": "1.0.0"}
}

// ---------- util argumen ----------

// mcp_norm menormalisasi nama: huruf kecil, buang semua non-alfanumerik.
func mcp_norm(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// mcp_matchTool mencocokkan nama tool (suffix, case-insensitive, ternormalisasi).
func mcp_matchTool(name string) string {
	n := mcp_norm(name)
	canonical := map[string][]string{
		"create_repo":         {"createrepo", "createrepository", "repocreate", "reposcreate", "repositorycreate"},
		"get_repo":            {"getrepo", "getrepository", "repoget", "reposget", "repositoryget"},
		"create_issue":        {"createissue", "issuecreate", "issuescreate"},
		"list_issues":         {"listissues", "issueslist", "issuelist"},
		"create_pull_request": {"createpullrequest", "pullrequestcreate", "pullscreate", "createpr", "prcreate"},
		"merge_pull_request":  {"mergepullrequest", "pullrequestmerge", "pullsmerge", "mergepr", "prmerge"},
		"get_issue":           {"getissue", "issueget"},
		"close_issue":         {"closeissue", "issueclose"},
	}
	for canon, aliases := range canonical {
		for _, a := range aliases {
			if n == a || strings.HasSuffix(n, a) {
				return canon
			}
		}
	}
	return ""
}

func mcp_strArg(args map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := args[k]; ok {
			switch t := v.(type) {
			case string:
				return t
			case float64:
				return fmt.Sprintf("%v", t)
			}
		}
	}
	return ""
}

func mcp_intArg(args map[string]any, keys ...string) (int, bool) {
	for _, k := range keys {
		if v, ok := args[k]; ok {
			switch t := v.(type) {
			case float64:
				return int(t), true
			case int:
				return t, true
			case int64:
				return int(t), true
			case string:
				var n int
				if _, err := fmt.Sscanf(t, "%d", &n); err == nil {
					return n, true
				}
			}
		}
	}
	return 0, false
}

func mcp_boolArg(args map[string]any, keys ...string) bool {
	for _, k := range keys {
		if v, ok := args[k]; ok {
			if b, ok := v.(bool); ok {
				return b
			}
		}
	}
	return false
}

// mcp_repoArgs mengurai owner/repo dari argumen (mendukung full_name "owner/repo").
func mcp_repoArgs(args map[string]any) (owner, repo string) {
	owner = mcp_strArg(args, "owner", "owner_login", "org", "organization", "user", "user_login", "login", "account", "namespace", "owner_name")
	repo = mcp_strArg(args, "repo", "repository", "repository_name", "repo_name", "repo_slug", "project", "project_name", "name")
	if full := mcp_strArg(args, "full_name", "repo_full_name", "repository_full_name", "fullName"); full != "" {
		if i := strings.Index(full, "/"); i > 0 {
			if owner == "" {
				owner = full[:i]
			}
			if repo == "" {
				repo = full[i+1:]
			}
		}
	}
	if owner == "" {
		owner = Viewer().Login
	}
	return owner, repo
}

// ---------- hasil tool ----------

func mcp_toolResult(structured any) map[string]any {
	textBytes, _ := json.Marshal(structured)
	return map[string]any{
		"content":           []any{map[string]any{"type": "text", "text": string(textBytes)}},
		"structuredContent": structured,
		"isError":           false,
	}
}

func mcp_toolError(msg string) map[string]any {
	return map[string]any{
		"content":           []any{map[string]any{"type": "text", "text": msg}},
		"structuredContent": map[string]any{"error": msg},
		"isError":           true,
	}
}

func mcp_repoJSON(r *Repo) map[string]any {
	return map[string]any{
		"id":             r.ID,
		"name":           r.Name,
		"full_name":      r.Owner + "/" + r.Name,
		"owner":          map[string]any{"login": r.Owner},
		"private":        r.Private,
		"description":    r.Description,
		"default_branch": r.DefaultBranch,
	}
}

func mcp_issueJSON(r *Repo, iss *Issue) map[string]any {
	return map[string]any{
		"id":     iss.ID,
		"number": iss.Number,
		"title":  iss.Title,
		"body":   iss.Body,
		"state":  iss.State,
	}
}

func mcp_prJSON(r *Repo, pr *Pull) map[string]any {
	return map[string]any{
		"id":          pr.ID,
		"number":      pr.Number,
		"pull_number": pr.Number,
		"title":       pr.Title,
		"body":        pr.Body,
		"state":       pr.State,
		"merged":      pr.Merged,
		"head":        map[string]any{"ref": pr.Head},
		"base":        map[string]any{"ref": pr.Base},
		"head_ref":    pr.Head,
		"base_ref":    pr.Base,
	}
}

// mcp_callTool menjalankan satu tool; mengembalikan (result, isJSONRPCError, code, msg).
func mcp_callTool(s *Server, name string, args map[string]any) (map[string]any, bool, int, string) {
	canon := mcp_matchTool(name)
	if canon == "" {
		return nil, true, -32601, fmt.Sprintf("Method not found: tool %q does not exist", name)
	}
	if args == nil {
		args = map[string]any{}
	}
	switch canon {
	case "create_repo":
		owner, repoName := mcp_repoArgs(args)
		// create_repo: nama repo dari argumen "name" (atau repo/repository)
		if n := mcp_strArg(args, "name"); n != "" {
			repoName = n
		}
		if strings.TrimSpace(repoName) == "" {
			return mcp_toolError("create_repo: missing required argument: name"), false, 0, ""
		}
		desc := mcp_strArg(args, "description", "about", "summary", "body")
		priv := mcp_boolArg(args, "private", "is_private")
		r, err := s.store.CreateRepo(owner, repoName, desc, priv)
		if err != nil {
			return mcp_toolError("create_repo: " + err.Error()), false, 0, ""
		}
		return mcp_toolResult(mcp_repoJSON(r)), false, 0, ""
	case "get_repo":
		owner, repoName := mcp_repoArgs(args)
		if repoName == "" {
			return mcp_toolError("get_repo: missing required argument: repo"), false, 0, ""
		}
		r, ok := s.store.GetRepo(owner, repoName)
		if !ok {
			return mcp_toolError("get_repo: repository not found"), false, 0, ""
		}
		return mcp_toolResult(mcp_repoJSON(r)), false, 0, ""
	case "create_issue":
		owner, repoName := mcp_repoArgs(args)
		title := mcp_strArg(args, "title", "issue_title", "pr_title", "pull_request_title", "subject")
		body := mcp_strArg(args, "body", "issue_body", "description", "content", "text", "comment")
		if repoName == "" || title == "" {
			return mcp_toolError("create_issue: missing required arguments: owner, repo, title"), false, 0, ""
		}
		r, ok := s.store.GetRepo(owner, repoName)
		if !ok {
			return mcp_toolError("create_issue: repository not found"), false, 0, ""
		}
		iss, err := s.store.CreateIssue(r, title, body, nil)
		if err != nil {
			return mcp_toolError("create_issue: " + err.Error()), false, 0, ""
		}
		return mcp_toolResult(mcp_issueJSON(r, iss)), false, 0, ""
	case "list_issues":
		owner, repoName := mcp_repoArgs(args)
		if repoName == "" {
			return mcp_toolError("list_issues: missing required arguments: owner, repo"), false, 0, ""
		}
		r, ok := s.store.GetRepo(owner, repoName)
		if !ok {
			return mcp_toolError("list_issues: repository not found"), false, 0, ""
		}
		state := strings.ToLower(mcp_strArg(args, "state", "status"))
		if state != "open" && state != "closed" {
			state = ""
		}
		issues := s.store.ListIssues(r, state)
		var arr []any
		for _, iss := range issues {
			arr = append(arr, mcp_issueJSON(r, iss))
		}
		if arr == nil {
			arr = []any{}
		}
		return mcp_toolResult(map[string]any{"issues": arr}), false, 0, ""
	case "create_pull_request":
		owner, repoName := mcp_repoArgs(args)
		title := mcp_strArg(args, "title", "issue_title", "pr_title", "pull_request_title", "subject")
		body := mcp_strArg(args, "body", "issue_body", "description", "content", "text", "comment")
		head := mcp_strArg(args, "head", "head_ref", "head_branch", "pull_request_head", "pr_head", "source", "source_ref", "source_branch", "from", "from_branch", "branch")
		base := mcp_strArg(args, "base", "base_ref", "base_branch", "pull_request_base", "pr_base", "target", "target_ref", "target_branch", "into", "into_branch")
		if repoName == "" || title == "" || head == "" || base == "" {
			return mcp_toolError("create_pull_request: missing required arguments: owner, repo, title, head, base"), false, 0, ""
		}
		r, ok := s.store.GetRepo(owner, repoName)
		if !ok {
			return mcp_toolError("create_pull_request: repository not found"), false, 0, ""
		}
		pr, err := s.store.CreatePull(r, title, body, head, base)
		if err != nil {
			return mcp_toolError("create_pull_request: " + err.Error()), false, 0, ""
		}
		return mcp_toolResult(mcp_prJSON(r, pr)), false, 0, ""
	case "merge_pull_request":
		owner, repoName := mcp_repoArgs(args)
		num, okNum := mcp_intArg(args, "pull_number", "pull_request_number", "pr_number", "number", "issue_number", "index")
		if repoName == "" || !okNum {
			return mcp_toolError("merge_pull_request: missing required arguments: owner, repo, pull_number"), false, 0, ""
		}
		r, ok := s.store.GetRepo(owner, repoName)
		if !ok {
			return mcp_toolError("merge_pull_request: repository not found"), false, 0, ""
		}
		pr, err := s.store.MergePull(r, num, "squash")
		if err != nil {
			return mcp_toolError("merge_pull_request: " + err.Error()), false, 0, ""
		}
		return mcp_toolResult(mcp_prJSON(r, pr)), false, 0, ""
	case "get_issue":
		owner, repoName := mcp_repoArgs(args)
		num, okNum := mcp_intArg(args, "number", "issue_number", "index")
		if repoName == "" || !okNum {
			return mcp_toolError("get_issue: missing required arguments: owner, repo, number"), false, 0, ""
		}
		r, ok := s.store.GetRepo(owner, repoName)
		if !ok {
			return mcp_toolError("get_issue: repository not found"), false, 0, ""
		}
		iss, ok := s.store.GetIssue(r, num)
		if !ok {
			return mcp_toolError("get_issue: issue not found"), false, 0, ""
		}
		return mcp_toolResult(mcp_issueJSON(r, iss)), false, 0, ""
	case "close_issue":
		owner, repoName := mcp_repoArgs(args)
		num, okNum := mcp_intArg(args, "number", "issue_number", "index")
		if repoName == "" || !okNum {
			return mcp_toolError("close_issue: missing required arguments: owner, repo, number"), false, 0, ""
		}
		r, ok := s.store.GetRepo(owner, repoName)
		if !ok {
			return mcp_toolError("close_issue: repository not found"), false, 0, ""
		}
		closed := "closed"
		iss, err := s.store.PatchIssue(r, num, nil, nil, &closed, nil)
		if err != nil {
			return mcp_toolError("close_issue: " + err.Error()), false, 0, ""
		}
		return mcp_toolResult(mcp_issueJSON(r, iss)), false, 0, ""
	}
	return nil, true, -32601, "Method not found"
}

// ---------- JSON-RPC ----------

type mcp_rpcReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func mcp_writeResult(s *Server, w http.ResponseWriter, id json.RawMessage, result any) {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	s.writeJSON(w, 200, map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "result": result})
}

func mcp_writeError(s *Server, w http.ResponseWriter, status int, id json.RawMessage, code int, msg string, data any) {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	errObj := map[string]any{"code": code, "message": msg}
	if data != nil {
		errObj["data"] = data
	}
	s.writeJSON(w, status, map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "error": errObj})
}

func mcp_handleRPC(s *Server, w http.ResponseWriter, r *http.Request, body []byte) {
	// 1) Parse error mendahului auth: body bukan JSON -> 400 + -32700.
	var req mcp_rpcReq
	if err := json.Unmarshal(body, &req); err != nil {
		mcp_writeError(s, w, 400, nil, -32700, "Parse error", nil)
		return
	}
	// 2) Auth: tanpa Bearer -> 401 (sebelum method/tool diperiksa).
	if !s.authOK(r) {
		s.writeErr(w, 401, "Requires authentication")
		return
	}
	// 3) Notifikasi (tanpa id): tidak ada respons.
	isNotification := len(req.ID) == 0 || string(req.ID) == "null"
	if isNotification {
		w.Header().Set("X-GitHub-Request-Id", s.nextRequestID())
		w.WriteHeader(202)
		return
	}
	// 4) Dispatch method.
	var params map[string]any
	if len(req.Params) > 0 {
		_ = json.Unmarshal(req.Params, &params)
	}
	if params == nil {
		params = map[string]any{}
	}
	switch req.Method {
	case "initialize":
		ver := "2025-11-25"
		if pv, ok := params["protocolVersion"].(string); ok && pv != "" {
			for _, sv := range mcp_supportedVersions {
				if pv == sv {
					ver = pv
					break
				}
			}
		}
		mcp_writeResult(s, w, req.ID, map[string]any{
			"protocolVersion": ver,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      mcp_serverInfo(),
			"_meta":           map[string]any{"io.modelcontextprotocol/serverInfo": mcp_serverInfo()},
		})
	case "notifications/initialized":
		mcp_writeResult(s, w, req.ID, map[string]any{})
	case "ping":
		mcp_writeResult(s, w, req.ID, map[string]any{})
	case "server/discover":
		mcp_writeResult(s, w, req.ID, map[string]any{
			"supportedVersions": mcp_supportedVersions,
			"capabilities":      map[string]any{"tools": map[string]any{}},
			"serverInfo":        mcp_serverInfo(),
			"_meta":             map[string]any{"io.modelcontextprotocol/serverInfo": mcp_serverInfo()},
		})
	case "tools/list":
		mcp_writeResult(s, w, req.ID, map[string]any{"tools": mcp_tools})
	case "tools/call":
		name, _ := params["name"].(string)
		var args map[string]any
		if a, ok := params["arguments"].(map[string]any); ok {
			args = a
		}
		result, isErr, code, msg := mcp_callTool(s, name, args)
		if isErr {
			mcp_writeError(s, w, 200, req.ID, code, msg, nil)
			return
		}
		mcp_writeResult(s, w, req.ID, result)
	default:
		mcp_writeError(s, w, 200, req.ID, -32601, fmt.Sprintf("Method not found: %s", req.Method), nil)
	}
}

func registerMCPRoutes(s *Server) {
	// Daftarkan langsung ke mux (bukan s.handle) supaya urutan
	// parse-error -> auth bisa diatur sendiri di handler.
	s.mux.HandleFunc("POST /mcp", func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				s.writeErr(w, 500, fmt.Sprintf("internal error: %v", rec))
			}
		}()
		body, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
		if err != nil {
			mcp_writeError(s, w, 400, nil, -32700, "Parse error", nil)
			return
		}
		if len(strings.TrimSpace(string(body))) == 0 {
			mcp_writeError(s, w, 400, nil, -32700, "Parse error", nil)
			return
		}
		mcp_handleRPC(s, w, r, body)
	})
	s.mux.HandleFunc("DELETE /mcp", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-GitHub-Request-Id", s.nextRequestID())
		w.WriteHeader(200)
	})
}
