// GraphQL v4 — POST /api/graphql (stdlib saja).
// Parser + executor kecil untuk dokumen yang dipakai suite conformance.
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// ---------- global id (opaque, stabil) ----------

func gql_encodeID(kind string, parts ...int64) string {
	var sb strings.Builder
	sb.WriteString(kind)
	for _, p := range parts {
		sb.WriteString(":")
		sb.WriteString(strconv.FormatInt(p, 10))
	}
	return base64.StdEncoding.EncodeToString([]byte(sb.String()))
}

func gql_decodeID(id string) (string, []int64, bool) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(id))
	if err != nil {
		return "", nil, false
	}
	segs := strings.Split(string(raw), ":")
	if len(segs) < 2 {
		return "", nil, false
	}
	nums := make([]int64, 0, len(segs)-1)
	for _, s := range segs[1:] {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return "", nil, false
		}
		nums = append(nums, n)
	}
	return segs[0], nums, true
}

func gql_repoID(r *Repo) string         { return gql_encodeID("Repository", r.ID) }
func gql_issueID(r *Repo, n int) string { return gql_encodeID("Issue", r.ID, int64(n)) }
func gql_prID(r *Repo, n int) string    { return gql_encodeID("PullRequest", r.ID, int64(n)) }
func gql_commentID(r *Repo, issueN int, cID int64) string {
	return gql_encodeID("Comment", r.ID, int64(issueN), cID)
}

// gql_repoByID mencari repo berdasarkan id numerik (dipakai decode global id).
func gql_repoByID(s *Store, id int64) (*Repo, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, r := range s.repos {
		if r.ID == id {
			return r, true
		}
	}
	return nil, false
}

// ---------- lexer ----------

type gql_tok struct {
	kind string // "name","int","float","string","punct","eof"
	val  string
}

func gql_lex(src string) ([]gql_tok, error) {
	var out []gql_tok
	i := 0
	for i < len(src) {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',':
			i++
		case c == '#':
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case c == '"':
			i++
			var sb strings.Builder
			for i < len(src) && src[i] != '"' {
				if src[i] == '\\' && i+1 < len(src) {
					i++
					switch src[i] {
					case 'n':
						sb.WriteByte('\n')
					case 't':
						sb.WriteByte('\t')
					case 'r':
						sb.WriteByte('\r')
					case '"':
						sb.WriteByte('"')
					case '\\':
						sb.WriteByte('\\')
					case '/':
						sb.WriteByte('/')
					case 'u':
						if i+4 < len(src) {
							if n, err := strconv.ParseInt(src[i+1:i+5], 16, 32); err == nil {
								sb.WriteRune(rune(n))
							}
							i += 4
						}
					default:
						sb.WriteByte(src[i])
					}
					i++
				} else {
					sb.WriteByte(src[i])
					i++
				}
			}
			if i >= len(src) {
				return nil, fmt.Errorf("unterminated string")
			}
			i++
			out = append(out, gql_tok{"string", sb.String()})
		case c == '.' && i+2 < len(src) && src[i+1] == '.' && src[i+2] == '.':
			out = append(out, gql_tok{"punct", "..."})
			i += 3
		case strings.IndexByte("{}()[]:!=$@=", c) >= 0:
			out = append(out, gql_tok{"punct", string(c)})
			i++
		case c == '-' || (c >= '0' && c <= '9'):
			j := i
			if src[j] == '-' {
				j++
			}
			isFloat := false
			for j < len(src) && src[j] >= '0' && src[j] <= '9' {
				j++
			}
			if j < len(src) && src[j] == '.' {
				isFloat = true
				j++
				for j < len(src) && src[j] >= '0' && src[j] <= '9' {
					j++
				}
			}
			if j < len(src) && (src[j] == 'e' || src[j] == 'E') {
				isFloat = true
				j++
				if j < len(src) && (src[j] == '+' || src[j] == '-') {
					j++
				}
				for j < len(src) && src[j] >= '0' && src[j] <= '9' {
					j++
				}
			}
			kind := "int"
			if isFloat {
				kind = "float"
			}
			out = append(out, gql_tok{kind, src[i:j]})
			i = j
		case (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_':
			j := i
			for j < len(src) && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= '0' && src[j] <= '9') || src[j] == '_') {
				j++
			}
			out = append(out, gql_tok{"name", src[i:j]})
			i = j
		default:
			return nil, fmt.Errorf("unexpected character %q", c)
		}
	}
	out = append(out, gql_tok{"eof", ""})
	return out, nil
}

// ---------- parser ----------

type gql_value struct {
	kind string // "string","int","float","bool","null","enum","var","list","object"
	s    string
	n    int64
	f    float64
	b    bool
	list []gql_value
	obj  map[string]gql_value
}

type gql_field struct {
	alias    string
	name     string
	args     map[string]gql_value
	sel      []*gql_field
	frag     bool   // inline fragment
	fragType string // tipe fragment ("Repository" dsb), "" = tanpa kondisi tipe
}

type gql_op struct {
	kind string // "query" | "mutation"
	name string
	sel  []*gql_field
}

type gql_parser struct {
	toks []gql_tok
	pos  int
}

func (p *gql_parser) peek() gql_tok { return p.toks[p.pos] }
func (p *gql_parser) next() gql_tok {
	t := p.toks[p.pos]
	if p.pos < len(p.toks)-1 {
		p.pos++
	}
	return t
}
func (p *gql_parser) expect(val string) error {
	t := p.next()
	if t.val != val {
		return fmt.Errorf("expected %q, got %q", val, t.val)
	}
	return nil
}

func gql_parse(src string) (*gql_op, error) {
	toks, err := gql_lex(src)
	if err != nil {
		return nil, err
	}
	p := &gql_parser{toks: toks}
	return p.parseOp()
}

func (p *gql_parser) parseOp() (*gql_op, error) {
	op := &gql_op{kind: "query"}
	t := p.peek()
	if t.kind == "name" && (t.val == "query" || t.val == "mutation" || t.val == "subscription") {
		op.kind = p.next().val
		if p.peek().kind == "name" {
			op.name = p.next().val
		}
	} else if t.val == "{" {
		// shorthand query
	} else {
		return nil, fmt.Errorf("expected operation, got %q", t.val)
	}
	// variable definitions: (...): lewati seimbang
	if p.peek().val == "(" {
		depth := 0
		for {
			tk := p.next()
			if tk.kind == "eof" {
				return nil, fmt.Errorf("unterminated variable definitions")
			}
			if tk.val == "(" {
				depth++
			} else if tk.val == ")" {
				depth--
				if depth == 0 {
					break
				}
			}
		}
	}
	// directives sebelum selection set: lewati
	for p.peek().val == "@" {
		p.next()
		if p.peek().kind == "name" {
			p.next()
		}
		if p.peek().val == "(" {
			depth := 0
			for {
				tk := p.next()
				if tk.kind == "eof" {
					break
				}
				if tk.val == "(" {
					depth++
				} else if tk.val == ")" {
					depth--
					if depth == 0 {
						break
					}
				}
			}
		}
	}
	sel, err := p.parseSelSet()
	if err != nil {
		return nil, err
	}
	op.sel = sel
	return op, nil
}

func (p *gql_parser) parseSelSet() ([]*gql_field, error) {
	if err := p.expect("{"); err != nil {
		return nil, err
	}
	var out []*gql_field
	for {
		t := p.peek()
		if t.val == "}" {
			p.next()
			return out, nil
		}
		if t.kind == "eof" {
			return nil, fmt.Errorf("unterminated selection set")
		}
		f, err := p.parseField()
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
}

func (p *gql_parser) parseField() (*gql_field, error) {
	t := p.peek()
	if t.val == "..." {
		p.next()
		f := &gql_field{frag: true}
		if p.peek().kind == "name" && p.peek().val == "on" {
			p.next()
			if p.peek().kind == "name" {
				f.fragType = p.next().val
			}
		} else if p.peek().kind == "name" {
			// fragment bernama — tidak dipakai suite; lewati namanya
			p.next()
		}
		// directives
		for p.peek().val == "@" {
			p.next()
			if p.peek().kind == "name" {
				p.next()
			}
			if p.peek().val == "(" {
				depth := 0
				for {
					tk := p.next()
					if tk.val == "(" {
						depth++
					} else if tk.val == ")" {
						depth--
						if depth == 0 {
							break
						}
					} else if tk.kind == "eof" {
						break
					}
				}
			}
		}
		sel, err := p.parseSelSet()
		if err != nil {
			return nil, err
		}
		f.sel = sel
		return f, nil
	}
	if t.kind != "name" {
		return nil, fmt.Errorf("expected field name, got %q", t.val)
	}
	f := &gql_field{name: p.next().val, args: map[string]gql_value{}}
	if p.peek().val == ":" {
		p.next()
		if p.peek().kind != "name" {
			return nil, fmt.Errorf("expected field name after alias")
		}
		f.alias = f.name
		f.name = p.next().val
	}
	if p.peek().val == "(" {
		args, err := p.parseArgs()
		if err != nil {
			return nil, err
		}
		f.args = args
	}
	// directives
	for p.peek().val == "@" {
		p.next()
		if p.peek().kind == "name" {
			p.next()
		}
		if p.peek().val == "(" {
			depth := 0
			for {
				tk := p.next()
				if tk.val == "(" {
					depth++
				} else if tk.val == ")" {
					depth--
					if depth == 0 {
						break
					}
				} else if tk.kind == "eof" {
					break
				}
			}
		}
	}
	if p.peek().val == "{" {
		sel, err := p.parseSelSet()
		if err != nil {
			return nil, err
		}
		f.sel = sel
	}
	return f, nil
}

func (p *gql_parser) parseArgs() (map[string]gql_value, error) {
	if err := p.expect("("); err != nil {
		return nil, err
	}
	out := map[string]gql_value{}
	for {
		t := p.peek()
		if t.val == ")" {
			p.next()
			return out, nil
		}
		if t.kind != "name" {
			return nil, fmt.Errorf("expected argument name, got %q", t.val)
		}
		name := p.next().val
		if err := p.expect(":"); err != nil {
			return nil, err
		}
		v, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		out[name] = v
	}
}

func (p *gql_parser) parseValue() (gql_value, error) {
	t := p.next()
	switch t.kind {
	case "string":
		return gql_value{kind: "string", s: t.val}, nil
	case "int":
		n, _ := strconv.ParseInt(t.val, 10, 64)
		return gql_value{kind: "int", n: n}, nil
	case "float":
		f, _ := strconv.ParseFloat(t.val, 64)
		return gql_value{kind: "float", f: f}, nil
	case "name":
		switch t.val {
		case "true":
			return gql_value{kind: "bool", b: true}, nil
		case "false":
			return gql_value{kind: "bool", b: false}, nil
		case "null":
			return gql_value{kind: "null"}, nil
		default:
			return gql_value{kind: "enum", s: t.val}, nil
		}
	}
	if t.val == "$" {
		if p.peek().kind != "name" {
			return gql_value{}, fmt.Errorf("expected variable name")
		}
		return gql_value{kind: "var", s: p.next().val}, nil
	}
	if t.val == "[" {
		var list []gql_value
		for {
			if p.peek().val == "]" {
				p.next()
				return gql_value{kind: "list", list: list}, nil
			}
			v, err := p.parseValue()
			if err != nil {
				return gql_value{}, err
			}
			list = append(list, v)
		}
	}
	if t.val == "{" {
		obj := map[string]gql_value{}
		for {
			if p.peek().val == "}" {
				p.next()
				return gql_value{kind: "object", obj: obj}, nil
			}
			if p.peek().kind != "name" {
				return gql_value{}, fmt.Errorf("expected object key, got %q", p.peek().val)
			}
			k := p.next().val
			if err := p.expect(":"); err != nil {
				return gql_value{}, err
			}
			v, err := p.parseValue()
			if err != nil {
				return gql_value{}, err
			}
			obj[k] = v
		}
	}
	return gql_value{}, fmt.Errorf("unexpected value token %q", t.val)
}

// ---------- resolusi nilai (variabel -> Go) ----------

func gql_resolveValue(v gql_value, vars map[string]any) any {
	switch v.kind {
	case "var":
		if vars == nil {
			return nil
		}
		return vars[v.s]
	case "string":
		return v.s
	case "int":
		return v.n
	case "float":
		return v.f
	case "bool":
		return v.b
	case "null":
		return nil
	case "enum":
		return v.s
	case "list":
		out := make([]any, 0, len(v.list))
		for _, e := range v.list {
			out = append(out, gql_resolveValue(e, vars))
		}
		return out
	case "object":
		out := map[string]any{}
		for k, e := range v.obj {
			out[k] = gql_resolveValue(e, vars)
		}
		return out
	}
	return nil
}

func gql_argStr(args map[string]gql_value, name string, vars map[string]any) string {
	v, ok := args[name]
	if !ok {
		return ""
	}
	if s, ok := gql_resolveValue(v, vars).(string); ok {
		return s
	}
	return ""
}

func gql_argInt(args map[string]gql_value, name string, vars map[string]any, def int) int {
	v, ok := args[name]
	if !ok {
		return def
	}
	switch n := gql_resolveValue(v, vars).(type) {
	case float64:
		return int(n)
	case int64:
		return int(n)
	case int:
		return n
	case nil:
		return def
	}
	return def
}

func gql_argHas(args map[string]gql_value, name string) bool {
	_, ok := args[name]
	return ok
}

// ---------- cursor pagination ----------

func gql_cursor(offset int) string {
	return base64.StdEncoding.EncodeToString([]byte("offset:" + strconv.Itoa(offset)))
}

func gql_parseCursor(c string) int {
	if c == "" {
		return 0
	}
	raw, err := base64.StdEncoding.DecodeString(c)
	if err != nil {
		return 0
	}
	s := strings.TrimPrefix(string(raw), "offset:")
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// ---------- executor ----------

type gql_ctx struct {
	store *Store
	vars  map[string]any
}

type gql_execErr struct{ msg string }

func (e *gql_execErr) Error() string { return e.msg }

func gql_errf(format string, a ...any) *gql_execErr {
	return &gql_execErr{msg: fmt.Sprintf(format, a...)}
}

// objek hasil query: kind + pointer domain
type gql_obj struct {
	kind  string // "User","Repository","Issue","PullRequest","Comment"
	user  *User
	repo  *Repo
	issue *Issue
	pr    *Pull
	// untuk Comment
	comment *Comment
	// repo pemilik issue/PR (untuk id global komentar dsb)
	issueRepo *Repo
	issueNum  int
}

func gql_fieldName(f *gql_field) string {
	if f.alias != "" {
		return f.alias
	}
	return f.name
}

func (c *gql_ctx) exec(op *gql_op) (map[string]any, []*gql_execErr) {
	data := map[string]any{}
	var errs []*gql_execErr
	if op.kind == "mutation" {
		for _, f := range op.sel {
			v, err := c.resolveRootMutation(f)
			if err != nil {
				errs = append(errs, err)
				continue
			}
			data[gql_fieldName(f)] = v
		}
		return data, errs
	}
	for _, f := range op.sel {
		v, err := c.resolveRoot(f)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		data[gql_fieldName(f)] = v
	}
	return data, errs
}

func (c *gql_ctx) resolveRoot(f *gql_field) (any, *gql_execErr) {
	switch f.name {
	case "viewer":
		u := Viewer()
		return c.resolveObj(gql_obj{kind: "User", user: &u}, f.sel)
	case "repository":
		owner := gql_argStr(f.args, "owner", c.vars)
		name := gql_argStr(f.args, "name", c.vars)
		r, ok := c.store.GetRepo(owner, name)
		if !ok {
			return nil, nil
		}
		return c.resolveObj(gql_obj{kind: "Repository", repo: r}, f.sel)
	case "node":
		id := gql_argStr(f.args, "id", c.vars)
		kind, nums, ok := gql_decodeID(id)
		if !ok {
			return nil, nil
		}
		switch kind {
		case "Repository":
			if len(nums) < 1 {
				return nil, nil
			}
			r, ok := gql_repoByID(c.store, nums[0])
			if !ok {
				return nil, nil
			}
			return c.resolveObj(gql_obj{kind: "Repository", repo: r}, f.sel)
		case "Issue":
			if len(nums) < 2 {
				return nil, nil
			}
			r, ok := gql_repoByID(c.store, nums[0])
			if !ok {
				return nil, nil
			}
			iss, ok := c.store.GetIssue(r, int(nums[1]))
			if !ok {
				return nil, nil
			}
			return c.resolveObj(gql_obj{kind: "Issue", repo: r, issue: iss, issueRepo: r, issueNum: int(nums[1])}, f.sel)
		case "PullRequest":
			if len(nums) < 2 {
				return nil, nil
			}
			r, ok := gql_repoByID(c.store, nums[0])
			if !ok {
				return nil, nil
			}
			pr, ok := c.store.GetPull(r, int(nums[1]))
			if !ok {
				return nil, nil
			}
			return c.resolveObj(gql_obj{kind: "PullRequest", repo: r, pr: pr}, f.sel)
		}
		return nil, nil
	case "__type":
		name := gql_argStr(f.args, "name", c.vars)
		return c.resolveTypeObj(name, f.sel)
	case "__schema":
		return map[string]any{"queryType": map[string]any{"name": "Query"}}, nil
	}
	return nil, gql_errf("Cannot query field %q on type %q.", f.name, "Query")
}

func (c *gql_ctx) resolveRootMutation(f *gql_field) (any, *gql_execErr) {
	switch f.name {
	case "createIssue":
		input, _ := gql_resolveValue(f.args["input"], c.vars).(map[string]any)
		if input == nil {
			return nil, gql_errf("createIssue: input is required")
		}
		repoID, _ := input["repositoryId"].(string)
		kind, nums, ok := gql_decodeID(repoID)
		if !ok || kind != "Repository" || len(nums) < 1 {
			return nil, gql_errf("createIssue: invalid repositoryId")
		}
		r, ok := gql_repoByID(c.store, nums[0])
		if !ok {
			return nil, gql_errf("createIssue: repository not found")
		}
		title, _ := input["title"].(string)
		body, _ := input["body"].(string)
		iss, err := c.store.CreateIssue(r, title, body, nil)
		if err != nil {
			return nil, gql_errf("createIssue: %v", err)
		}
		return c.resolvePayload("CreateIssuePayload", gql_obj{kind: "Issue", repo: r, issue: iss, issueRepo: r, issueNum: iss.Number}, f.sel)
	case "closeIssue":
		input, _ := gql_resolveValue(f.args["input"], c.vars).(map[string]any)
		if input == nil {
			return nil, gql_errf("closeIssue: input is required")
		}
		issueID, _ := input["issueId"].(string)
		kind, nums, ok := gql_decodeID(issueID)
		if !ok || kind != "Issue" || len(nums) < 2 {
			return nil, gql_errf("closeIssue: invalid issueId")
		}
		r, ok := gql_repoByID(c.store, nums[0])
		if !ok {
			return nil, gql_errf("closeIssue: repository not found")
		}
		closed := "closed"
		iss, err := c.store.PatchIssue(r, int(nums[1]), nil, nil, &closed, nil)
		if err != nil {
			return nil, gql_errf("closeIssue: %v", err)
		}
		return c.resolvePayload("CloseIssuePayload", gql_obj{kind: "Issue", repo: r, issue: iss, issueRepo: r, issueNum: iss.Number}, f.sel)
	case "createPullRequest":
		input, _ := gql_resolveValue(f.args["input"], c.vars).(map[string]any)
		if input == nil {
			return nil, gql_errf("createPullRequest: input is required")
		}
		repoID, _ := input["repositoryId"].(string)
		kind, nums, ok := gql_decodeID(repoID)
		if !ok || kind != "Repository" || len(nums) < 1 {
			return nil, gql_errf("createPullRequest: invalid repositoryId")
		}
		r, ok := gql_repoByID(c.store, nums[0])
		if !ok {
			return nil, gql_errf("createPullRequest: repository not found")
		}
		title, _ := input["title"].(string)
		body, _ := input["body"].(string)
		head, _ := input["headRefName"].(string)
		base, _ := input["baseRefName"].(string)
		pr, err := c.store.CreatePull(r, title, body, head, base)
		if err != nil {
			return nil, gql_errf("createPullRequest: %v", err)
		}
		return c.resolvePayload("CreatePullRequestPayload", gql_obj{kind: "PullRequest", repo: r, pr: pr}, f.sel)
	case "mergePullRequest":
		input, _ := gql_resolveValue(f.args["input"], c.vars).(map[string]any)
		if input == nil {
			return nil, gql_errf("mergePullRequest: input is required")
		}
		prID, _ := input["pullRequestId"].(string)
		kind, nums, ok := gql_decodeID(prID)
		if !ok || kind != "PullRequest" || len(nums) < 2 {
			return nil, gql_errf("mergePullRequest: invalid pullRequestId")
		}
		r, ok := gql_repoByID(c.store, nums[0])
		if !ok {
			return nil, gql_errf("mergePullRequest: repository not found")
		}
		pr, err := c.store.MergePull(r, int(nums[1]), "squash")
		if err != nil {
			return nil, gql_errf("mergePullRequest: %v", err)
		}
		return c.resolvePayload("MergePullRequestPayload", gql_obj{kind: "PullRequest", repo: r, pr: pr}, f.sel)
	case "addComment":
		input, _ := gql_resolveValue(f.args["input"], c.vars).(map[string]any)
		if input == nil {
			return nil, gql_errf("addComment: input is required")
		}
		subjID, _ := input["subjectId"].(string)
		body, _ := input["body"].(string)
		kind, nums, ok := gql_decodeID(subjID)
		if !ok || kind != "Issue" || len(nums) < 2 {
			return nil, gql_errf("addComment: subject must be an issue id")
		}
		r, ok := gql_repoByID(c.store, nums[0])
		if !ok {
			return nil, gql_errf("addComment: repository not found")
		}
		cmt, err := c.store.CreateComment(r, int(nums[1]), body)
		if err != nil {
			return nil, gql_errf("addComment: %v", err)
		}
		// payload: { commentEdge: { node: {id, body} } }
		out := map[string]any{}
		for _, sf := range f.sel {
			if sf.frag {
				continue
			}
			switch sf.name {
			case "commentEdge":
				node := map[string]any{}
				for _, nf := range sf.sel {
					switch nf.name {
					case "node":
						nodeObj := map[string]any{}
						for _, cf := range nf.sel {
							switch cf.name {
							case "id":
								nodeObj["id"] = gql_commentID(r, int(nums[1]), cmt.ID)
							case "body":
								nodeObj["body"] = cmt.Body
							}
						}
						node["node"] = nodeObj
					}
				}
				// bentuk: commentEdge = { node: {...} }
				edge := map[string]any{}
				for _, nf := range sf.sel {
					if nf.name == "node" {
						edge["node"] = node["node"]
					}
				}
				out[gql_fieldName(sf)] = edge
			case "comment":
				nodeObj := map[string]any{}
				for _, cf := range sf.sel {
					switch cf.name {
					case "id":
						nodeObj["id"] = gql_commentID(r, int(nums[1]), cmt.ID)
					case "body":
						nodeObj["body"] = cmt.Body
					}
				}
				out[gql_fieldName(sf)] = nodeObj
			}
		}
		return out, nil
	}
	return nil, gql_errf("Cannot query field %q on type %q.", f.name, "Mutation")
}

// resolvePayload menyelesaikan {issue: ...} / {pullRequest: ...} pada hasil mutasi.
func (c *gql_ctx) resolvePayload(payloadType string, obj gql_obj, sel []*gql_field) (any, *gql_execErr) {
	out := map[string]any{}
	for _, f := range sel {
		if f.frag {
			continue
		}
		switch f.name {
		case "issue":
			if obj.kind != "Issue" {
				return nil, gql_errf("Cannot query field %q on type %q.", f.name, payloadType)
			}
			v, err := c.resolveObj(obj, f.sel)
			if err != nil {
				return nil, err
			}
			out[gql_fieldName(f)] = v
		case "pullRequest":
			if obj.kind != "PullRequest" {
				return nil, gql_errf("Cannot query field %q on type %q.", f.name, payloadType)
			}
			v, err := c.resolveObj(obj, f.sel)
			if err != nil {
				return nil, err
			}
			out[gql_fieldName(f)] = v
		default:
			return nil, gql_errf("Cannot query field %q on type %q.", f.name, payloadType)
		}
	}
	return out, nil
}

// ---------- introspection ----------

var gql_typeFields = map[string][]string{
	"Issue":                 {"id", "number", "title", "body", "state", "author", "labels", "comments", "createdAt", "updatedAt", "url"},
	"PullRequest":           {"id", "number", "title", "body", "state", "merged", "mergeable", "headRefName", "baseRefName", "headRef", "baseRef", "files", "author", "createdAt", "updatedAt", "mergeCommit"},
	"Repository":            {"id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest", "description", "private", "createdAt", "updatedAt", "url"},
	"User":                  {"id", "login", "name", "email", "url"},
	"Comment":               {"id", "body", "author", "createdAt", "updatedAt"},
	"Ref":                   {"id", "name", "target"},
	"IssueConnection":       {"nodes", "edges", "pageInfo", "totalCount"},
	"PullRequestConnection": {"nodes", "edges", "pageInfo", "totalCount"},
	"PageInfo":              {"hasNextPage", "hasPreviousPage", "endCursor", "startCursor"},
}

var gql_typeEnums = map[string][]string{
	"IssueState":             {"OPEN", "CLOSED"},
	"PullRequestState":       {"OPEN", "CLOSED", "MERGED"},
	"MergeableState":         {"MERGEABLE", "CONFLICTING", "UNKNOWN"},
	"PullRequestMergeMethod": {"MERGE", "SQUASH", "REBASE"},
	"RepositoryPermission":   {"ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"},
	"SearchType":             {"ISSUE", "REPOSITORY", "USER", "CODE", "DISCUSSION"},
	"IssueOrderField":        {"CREATED_AT", "UPDATED_AT", "COMMENTS"},
	"OrderDirection":         {"ASC", "DESC"},
}

func (c *gql_ctx) resolveTypeObj(name string, sel []*gql_field) (any, *gql_execErr) {
	out := map[string]any{}
	for _, f := range sel {
		if f.frag {
			continue
		}
		switch f.name {
		case "name":
			out[gql_fieldName(f)] = name
		case "kind":
			if _, ok := gql_typeEnums[name]; ok {
				out[gql_fieldName(f)] = "ENUM"
			} else {
				out[gql_fieldName(f)] = "OBJECT"
			}
		case "description":
			out[gql_fieldName(f)] = nil
		case "fields":
			names := gql_typeFields[name]
			var arr []any
			for _, n := range names {
				item := map[string]any{}
				for _, sf := range f.sel {
					if sf.name == "name" {
						item["name"] = n
					}
				}
				if len(item) == 0 {
					item["name"] = n
				}
				arr = append(arr, item)
			}
			if arr == nil {
				arr = []any{}
			}
			out[gql_fieldName(f)] = arr
		case "enumValues":
			names := gql_typeEnums[name]
			var arr []any
			for _, n := range names {
				item := map[string]any{}
				for _, sf := range f.sel {
					if sf.name == "name" {
						item["name"] = n
					}
				}
				if len(item) == 0 {
					item["name"] = n
				}
				arr = append(arr, item)
			}
			if arr == nil {
				arr = []any{}
			}
			out[gql_fieldName(f)] = arr
		default:
			return nil, gql_errf("Cannot query field %q on type %q.", f.name, "__Type")
		}
	}
	return out, nil
}

// ---------- resolve objek domain ----------

func (c *gql_ctx) resolveObj(obj gql_obj, sel []*gql_field) (any, *gql_execErr) {
	out := map[string]any{}
	for _, f := range sel {
		if f.frag {
			// fragment inline hanya berlaku bila tipenya cocok
			if f.fragType != "" && f.fragType != obj.kind {
				continue
			}
			v, err := c.resolveObj(obj, f.sel)
			if err != nil {
				return nil, err
			}
			if m, ok := v.(map[string]any); ok {
				for k, vv := range m {
					out[k] = vv
				}
			}
			continue
		}
		v, err := c.resolveField(obj, f)
		if err != nil {
			return nil, err
		}
		out[gql_fieldName(f)] = v
	}
	return out, nil
}

func gql_issueState(s string) string {
	if s == "closed" {
		return "CLOSED"
	}
	return "OPEN"
}

func gql_prState(pr *Pull) string {
	if pr.Merged {
		return "MERGED"
	}
	if pr.State == "closed" {
		return "CLOSED"
	}
	return "OPEN"
}

func gql_prMergeable(pr *Pull) string {
	if pr.Mergeable {
		return "MERGEABLE"
	}
	return "CONFLICTING"
}

func (c *gql_ctx) resolveField(obj gql_obj, f *gql_field) (any, *gql_execErr) {
	switch obj.kind {
	case "User":
		switch f.name {
		case "login":
			return obj.user.Login, nil
		case "id":
			return gql_encodeID("User", obj.user.ID), nil
		case "name":
			return obj.user.Name, nil
		case "email":
			return obj.user.Email, nil
		}
		return nil, gql_errf("Cannot query field %q on type %q.", f.name, "User")
	case "Repository":
		r := obj.repo
		switch f.name {
		case "id":
			return gql_repoID(r), nil
		case "databaseId":
			return r.ID, nil
		case "name":
			return r.Name, nil
		case "nameWithOwner":
			return r.Owner + "/" + r.Name, nil
		case "description":
			return r.Description, nil
		case "private":
			return r.Private, nil
		case "owner":
			u := Viewer()
			// owner login = pemilik repo; id user bila dikenal
			owner := &User{ID: u.ID, Login: r.Owner, Name: u.Name, Email: u.Email}
			if ku, ok := KnownUser(r.Owner); ok {
				owner = &User{ID: ku.ID, Login: ku.Login, Name: ku.Name, Email: ku.Email}
			}
			return c.resolveObj(gql_obj{kind: "User", user: owner}, f.sel)
		case "defaultBranchRef":
			return c.resolveObj(gql_obj{kind: "Ref", repo: r}, f.sel)
		case "viewerPermission":
			return "ADMIN", nil
		case "hasIssuesEnabled":
			return true, nil
		case "createdAt":
			return r.CreatedAt.Format("2006-01-02T15:04:05Z"), nil
		case "updatedAt":
			return r.UpdatedAt.Format("2006-01-02T15:04:05Z"), nil
		case "url":
			return "https://github.com/" + r.Owner + "/" + r.Name, nil
		case "issue":
			n := gql_argInt(f.args, "number", c.vars, 0)
			iss, ok := c.store.GetIssue(r, n)
			if !ok {
				return nil, nil
			}
			return c.resolveObj(gql_obj{kind: "Issue", repo: r, issue: iss, issueRepo: r, issueNum: n}, f.sel)
		case "issues":
			return c.resolveIssues(r, f)
		case "pullRequests":
			prs := c.store.ListPulls(r, "")
			first := gql_argInt(f.args, "first", c.vars, 0)
			if first > 0 && len(prs) > first {
				prs = prs[:first]
			}
			var nodes []any
			for _, pr := range prs {
				nodes = append(nodes, c.resolvePRNode(r, pr, f))
			}
			// bentuk connection: {nodes:[...], pageInfo, totalCount}
			return c.buildConnection(nodes, len(prs), f)
		case "pullRequest":
			n := gql_argInt(f.args, "number", c.vars, 0)
			pr, ok := c.store.GetPull(r, n)
			if !ok {
				return nil, nil
			}
			return c.resolveObj(gql_obj{kind: "PullRequest", repo: r, pr: pr}, f.sel)
		}
		return nil, gql_errf("Cannot query field %q on type %q.", f.name, "Repository")
	case "Ref":
		switch f.name {
		case "name":
			return obj.repo.DefaultBranch, nil
		case "id":
			return gql_encodeID("Ref", obj.repo.ID), nil
		}
		return nil, gql_errf("Cannot query field %q on type %q.", f.name, "Ref")
	case "Issue":
		iss := obj.issue
		switch f.name {
		case "id":
			return gql_issueID(obj.repo, iss.Number), nil
		case "number":
			return iss.Number, nil
		case "title":
			return iss.Title, nil
		case "body":
			return iss.Body, nil
		case "state":
			return gql_issueState(iss.State), nil
		case "author":
			u := Viewer()
			return c.resolveObj(gql_obj{kind: "User", user: &u}, f.sel)
		case "createdAt":
			return iss.CreatedAt.Format("2006-01-02T15:04:05Z"), nil
		case "updatedAt":
			return iss.UpdatedAt.Format("2006-01-02T15:04:05Z"), nil
		case "url":
			return "https://github.com/" + obj.repo.Owner + "/" + obj.repo.Name + "/issues/" + strconv.Itoa(iss.Number), nil
		}
		return nil, gql_errf("Cannot query field %q on type %q.", f.name, "Issue")
	case "PullRequest":
		pr := obj.pr
		switch f.name {
		case "id":
			return gql_prID(obj.repo, pr.Number), nil
		case "number":
			return pr.Number, nil
		case "title":
			return pr.Title, nil
		case "body":
			return pr.Body, nil
		case "state":
			return gql_prState(pr), nil
		case "merged":
			return pr.Merged, nil
		case "mergeable":
			return gql_prMergeable(pr), nil
		case "headRefName":
			return pr.Head, nil
		case "baseRefName":
			return pr.Base, nil
		case "author":
			u := Viewer()
			return c.resolveObj(gql_obj{kind: "User", user: &u}, f.sel)
		case "createdAt":
			return pr.CreatedAt.Format("2006-01-02T15:04:05Z"), nil
		case "updatedAt":
			return pr.UpdatedAt.Format("2006-01-02T15:04:05Z"), nil
		case "files":
			first := gql_argInt(f.args, "first", c.vars, 0)
			files := pr.Files
			if first > 0 && len(files) > first {
				files = files[:first]
			}
			var nodes []any
			for _, fl := range files {
				nodes = append(nodes, map[string]any{"path": fl.Filename})
			}
			if nodes == nil {
				nodes = []any{}
			}
			return c.buildConnection(nodes, len(files), f)
		}
		return nil, gql_errf("Cannot query field %q on type %q.", f.name, "PullRequest")
	case "Comment":
		switch f.name {
		case "id":
			return gql_commentID(obj.issueRepo, obj.issueNum, obj.comment.ID), nil
		case "body":
			return obj.comment.Body, nil
		case "author":
			u := Viewer()
			return c.resolveObj(gql_obj{kind: "User", user: &u}, f.sel)
		}
		return nil, gql_errf("Cannot query field %q on type %q.", f.name, "Comment")
	}
	return nil, gql_errf("Cannot query field %q on type %q.", f.name, obj.kind)
}

// selFor mencari sub-selection bernama name di dalam field connection.
func (f *gql_field) selFor(name string) []*gql_field {
	for _, sf := range f.sel {
		if sf.name == name {
			return sf.sel
		}
	}
	return nil
}

// resolvePRNode menyelesaikan satu node PR di dalam connection pullRequests.
func (c *gql_ctx) resolvePRNode(r *Repo, pr *Pull, conn *gql_field) any {
	nodeSel := conn.selFor("nodes")
	if nodeSel == nil {
		return map[string]any{}
	}
	v, err := c.resolveObj(gql_obj{kind: "PullRequest", repo: r, pr: pr}, nodeSel)
	if err != nil {
		return map[string]any{}
	}
	return v
}

// buildConnection membangun {nodes, pageInfo, totalCount} dari node yang sudah jadi.
func (c *gql_ctx) buildConnection(nodes []any, total int, f *gql_field) (any, *gql_execErr) {
	if nodes == nil {
		nodes = []any{}
	}
	out := map[string]any{}
	for _, sf := range f.sel {
		switch sf.name {
		case "nodes":
			out["nodes"] = nodes
		case "totalCount":
			out["totalCount"] = total
		case "pageInfo":
			pi := map[string]any{}
			for _, pf := range sf.sel {
				switch pf.name {
				case "hasNextPage":
					pi["hasNextPage"] = false
				case "hasPreviousPage":
					pi["hasPreviousPage"] = false
				case "endCursor":
					pi["endCursor"] = nil
				case "startCursor":
					pi["startCursor"] = nil
				}
			}
			out["pageInfo"] = pi
		case "edges":
			var edges []any
			for _, n := range nodes {
				edges = append(edges, map[string]any{"node": n, "cursor": ""})
			}
			if edges == nil {
				edges = []any{}
			}
			out["edges"] = edges
		}
	}
	return out, nil
}

// resolveIssues menyelesaikan repository.issues(first, after, states, orderBy).
func (c *gql_ctx) resolveIssues(r *Repo, f *gql_field) (any, *gql_execErr) {
	// filter states
	var states []string
	if v, ok := f.args["states"]; ok {
		if arr, ok := gql_resolveValue(v, c.vars).([]any); ok {
			for _, e := range arr {
				if s, ok := e.(string); ok {
					states = append(states, strings.ToLower(s))
				}
			}
		}
	}
	var all []*Issue
	if len(states) == 0 {
		all = c.store.ListIssues(r, "")
	} else {
		for _, st := range states {
			all = append(all, c.store.ListIssues(r, st)...)
		}
	}
	// orderBy
	field := "CREATED_AT"
	direction := "ASC"
	if v, ok := f.args["orderBy"]; ok {
		if m, ok := gql_resolveValue(v, c.vars).(map[string]any); ok {
			if s, ok := m["field"].(string); ok && s != "" {
				field = s
			}
			if s, ok := m["direction"].(string); ok && s != "" {
				direction = s
			}
		}
	}
	desc := direction == "DESC"
	sort.SliceStable(all, func(i, j int) bool {
		cmp := 0
		switch field {
		case "UPDATED_AT":
			if all[i].UpdatedAt.Before(all[j].UpdatedAt) {
				cmp = -1
			} else if all[i].UpdatedAt.After(all[j].UpdatedAt) {
				cmp = 1
			}
		case "COMMENTS":
			if len(all[i].Comments) < len(all[j].Comments) {
				cmp = -1
			} else if len(all[i].Comments) > len(all[j].Comments) {
				cmp = 1
			}
		default: // CREATED_AT
			if all[i].CreatedAt.Before(all[j].CreatedAt) {
				cmp = -1
			} else if all[i].CreatedAt.After(all[j].CreatedAt) {
				cmp = 1
			}
		}
		if cmp == 0 {
			if desc {
				return all[i].Number > all[j].Number
			}
			return all[i].Number < all[j].Number
		}
		if desc {
			return cmp > 0
		}
		return cmp < 0
	})
	// pagination
	first := gql_argInt(f.args, "first", c.vars, 0)
	after := gql_argStr(f.args, "after", c.vars)
	start := gql_parseCursor(after)
	if start > len(all) {
		start = len(all)
	}
	end := len(all)
	if first > 0 && start+first < end {
		end = start + first
	}
	page := all[start:end]
	hasNext := end < len(all)
	endCursor := ""
	if len(page) > 0 {
		endCursor = gql_cursor(end)
	}
	nodeSel := f.selFor("nodes")
	var nodes []any
	for _, iss := range page {
		v, err := c.resolveObj(gql_obj{kind: "Issue", repo: r, issue: iss, issueRepo: r, issueNum: iss.Number}, nodeSel)
		if err != nil {
			return nil, err
		}
		nodes = append(nodes, v)
	}
	if nodes == nil {
		nodes = []any{}
	}
	out := map[string]any{}
	for _, sf := range f.sel {
		switch sf.name {
		case "nodes":
			out["nodes"] = nodes
		case "totalCount":
			out["totalCount"] = len(all)
		case "pageInfo":
			pi := map[string]any{}
			for _, pf := range sf.sel {
				switch pf.name {
				case "hasNextPage":
					pi["hasNextPage"] = hasNext
				case "hasPreviousPage":
					pi["hasPreviousPage"] = start > 0
				case "endCursor":
					if endCursor == "" {
						pi["endCursor"] = nil
					} else {
						pi["endCursor"] = endCursor
					}
				case "startCursor":
					if len(page) == 0 {
						pi["startCursor"] = nil
					} else {
						pi["startCursor"] = gql_cursor(start)
					}
				}
			}
			out["pageInfo"] = pi
		case "edges":
			var edges []any
			for i, n := range nodes {
				edges = append(edges, map[string]any{"node": n, "cursor": gql_cursor(start + i + 1)})
			}
			if edges == nil {
				edges = []any{}
			}
			out["edges"] = edges
		}
	}
	return out, nil
}

// ---------- HTTP ----------

type gql_request struct {
	Query         string         `json:"query"`
	Variables     map[string]any `json:"variables"`
	OperationName string         `json:"operationName"`
}

func gql_executeDoc(s *Server, doc gql_request) map[string]any {
	op, err := gql_parse(doc.Query)
	if err != nil {
		return map[string]any{"data": nil, "errors": []map[string]string{{"message": err.Error()}}}
	}
	ctx := &gql_ctx{store: s.store, vars: doc.Variables}
	data, errs := ctx.exec(op)
	resp := map[string]any{"data": data}
	if len(errs) > 0 {
		var arr []map[string]string
		for _, e := range errs {
			arr = append(arr, map[string]string{"message": e.msg})
		}
		resp["errors"] = arr
		// bila ada error validasi (field tak dikenal), data jadi null agar jelas gagal
		if data != nil {
			empty := true
			for _, v := range data {
				if v != nil {
					empty = false
				}
			}
			if empty {
				resp["data"] = nil
			}
		}
	}
	return resp
}

func registerGraphQLRoutes(s *Server) {
	s.handle("POST /api/graphql", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
		if err != nil {
			s.writeJSON(w, 200, map[string]any{"data": nil, "errors": []map[string]string{{"message": "failed to read body"}}})
			return
		}
		trimmed := strings.TrimSpace(string(body))
		if strings.HasPrefix(trimmed, "[") {
			var docs []gql_request
			if err := json.Unmarshal(body, &docs); err != nil {
				s.writeJSON(w, 200, map[string]any{"data": nil, "errors": []map[string]string{{"message": "invalid batch JSON"}}})
				return
			}
			results := make([]map[string]any, 0, len(docs))
			for _, d := range docs {
				results = append(results, gql_executeDoc(s, d))
			}
			s.writeJSON(w, 200, results)
			return
		}
		var doc gql_request
		if err := json.Unmarshal(body, &doc); err != nil {
			s.writeJSON(w, 200, map[string]any{"data": nil, "errors": []map[string]string{{"message": "invalid JSON"}}})
			return
		}
		s.writeJSON(w, 200, gql_executeDoc(s, doc))
	})
}
