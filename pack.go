// Primitif git: objek, SHA-1, packfile, tree/commit/tag, reachability.
// PENTING: dialek pack suite ini memakai entri zlib-wrapped (bukan raw deflate):
// klien menulis dengan deflateSync dan membaca dengan inflateSync (Node zlib).
// Jadi writer DAN reader di sini memakai compress/zlib.
package main

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sort"
)

const zeroOID = "0000000000000000000000000000000000000000"

func isOID(s string) bool {
	if len(s) != 40 {
		return false
	}
	for i := 0; i < 40; i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func hashObject(typ string, data []byte) string {
	h := sha1.New()
	h.Write([]byte(typ))
	h.Write([]byte(" "))
	h.Write([]byte(itoa(len(data))))
	h.Write([]byte{0})
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// --- tree ---

type TreeEntry struct {
	Mode string
	Name string
	OID  string
}

// ParseTree mengurai byte tree menjadi entri (mode SP name NUL oid-20byte).
func ParseTree(data []byte) []TreeEntry {
	var out []TreeEntry
	i := 0
	for i < len(data) {
		sp := bytes.IndexByte(data[i:], ' ')
		if sp < 0 {
			break
		}
		mode := string(data[i : i+sp])
		i += sp + 1
		nul := bytes.IndexByte(data[i:], 0)
		if nul < 0 || i+nul+21 > len(data) {
			break
		}
		name := string(data[i : i+nul])
		i += nul + 1
		oid := hex.EncodeToString(data[i : i+20])
		i += 20
		out = append(out, TreeEntry{Mode: mode, Name: name, OID: oid})
	}
	return out
}

// treeLess adalah urutan kanonik git: nama, direktori dibanding sebagai nama+"/".
func treeLess(a, b TreeEntry) bool {
	an, bn := a.Name, b.Name
	if a.Mode == "40000" {
		an += "/"
	}
	if b.Mode == "40000" {
		bn += "/"
	}
	return an < bn
}

// BuildTree membangun byte tree dari entri (diurutkan kanonik).
func BuildTree(entries []TreeEntry) []byte {
	sorted := append([]TreeEntry(nil), entries...)
	sort.Slice(sorted, func(i, j int) bool { return treeLess(sorted[i], sorted[j]) })
	var buf bytes.Buffer
	for _, e := range sorted {
		buf.WriteString(e.Mode)
		buf.WriteByte(' ')
		buf.WriteString(e.Name)
		buf.WriteByte(0)
		raw, _ := hex.DecodeString(e.OID)
		buf.Write(raw)
	}
	return buf.Bytes()
}

// --- commit / tag ---

type CommitView struct {
	Tree      string
	Parents   []string
	Author    string
	Committer string
	Message   string
}

func ParseCommit(data []byte) CommitView {
	var c CommitView
	rest := data
	// Header sampai baris kosong.
	for {
		nl := bytes.IndexByte(rest, '\n')
		if nl < 0 {
			return c
		}
		line := string(rest[:nl])
		rest = rest[nl+1:]
		if line == "" {
			break
		}
		switch {
		case len(line) > 5 && line[:5] == "tree ":
			c.Tree = line[5:]
		case len(line) > 7 && line[:7] == "parent ":
			c.Parents = append(c.Parents, line[7:])
		case len(line) > 7 && line[:7] == "author ":
			c.Author = line[7:]
		case len(line) > 10 && line[:10] == "committer ":
			c.Committer = line[10:]
		}
	}
	c.Message = string(rest)
	return c
}

// BuildCommit membangun byte commit. Identitas: "Nama <email> ts +0000".
func BuildCommit(tree string, parents []string, author, committer string, ts int64, msg string) []byte {
	var buf bytes.Buffer
	buf.WriteString("tree " + tree + "\n")
	for _, p := range parents {
		buf.WriteString("parent " + p + "\n")
	}
	stamp := " " + itoa64(ts) + " +0000"
	buf.WriteString("author " + author + stamp + "\n")
	buf.WriteString("committer " + committer + stamp + "\n")
	buf.WriteString("\n")
	buf.WriteString(msg)
	return buf.Bytes()
}

func itoa64(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

type TagView struct {
	Object string
	Type   string
	Tag    string
	Tagger string
	Message string
}

func ParseTag(data []byte) TagView {
	var t TagView
	rest := data
	for {
		nl := bytes.IndexByte(rest, '\n')
		if nl < 0 {
			return t
		}
		line := string(rest[:nl])
		rest = rest[nl+1:]
		if line == "" {
			break
		}
		switch {
		case len(line) > 7 && line[:7] == "object ":
			t.Object = line[7:]
		case len(line) > 5 && line[:5] == "type ":
			t.Type = line[5:]
		case len(line) > 4 && line[:4] == "tag ":
			t.Tag = line[4:]
		case len(line) > 7 && line[:7] == "tagger ":
			t.Tagger = line[7:]
		}
	}
	t.Message = string(rest)
	return t
}

func BuildTag(object, typ, tag, tagger string, ts int64, msg string) []byte {
	var buf bytes.Buffer
	buf.WriteString("object " + object + "\n")
	buf.WriteString("type " + typ + "\n")
	buf.WriteString("tag " + tag + "\n")
	buf.WriteString("tagger " + tagger + " " + itoa64(ts) + " +0000\n")
	buf.WriteString("\n")
	buf.WriteString(msg)
	return buf.Bytes()
}

// --- packfile ---

// packEntry adalah satu entri pack yang sudah dibaca (delta belum di-resolve).
type packEntry struct {
	offset   int
	typeCode int
	size     int
	data     []byte // data hasil inflate (untuk delta: instruksi delta)
	baseOff  int    // OFS_DELTA: offset absolut base
	baseOID  string // REF_DELTA: oid base
}

var errPack = errors.New("packfile tidak valid")

// readPackVarint membaca varint type/size git.
func readPackVarint(buf []byte, off int) (first byte, size int, next int, err error) {
	if off >= len(buf) {
		return 0, 0, 0, errPack
	}
	first = buf[off]
	b := first
	off++
	size = int(b & 0x0f)
	shift := 4
	for b&0x80 != 0 {
		if off >= len(buf) {
			return 0, 0, 0, errPack
		}
		b = buf[off]
		off++
		size |= int(b&0x7f) << shift
		shift += 7
	}
	return first, size, off, nil
}

// inflateZlib meng-inflate satu stream zlib dari buf[off:] dan mengembalikan
// data + offset setelah stream. Memakai bytes.Reader (io.ByteReader) supaya
// tidak ada over-read.
func inflateZlib(buf []byte, off int) ([]byte, int, error) {
	br := bytes.NewReader(buf[off:])
	zr, err := zlib.NewReader(br)
	if err != nil {
		return nil, 0, err
	}
	data, err := io.ReadAll(zr)
	zr.Close()
	if err != nil {
		return nil, 0, err
	}
	consumed := len(buf[off:]) - br.Len()
	return data, off + consumed, nil
}

// applyDelta menerapkan instruksi delta git ke base.
func applyDelta(base, delta []byte) ([]byte, error) {
	off := 0
	readVarint := func() (int, error) {
		v, shift := 0, 0
		for {
			if off >= len(delta) {
				return 0, errPack
			}
			b := delta[off]
			off++
			v |= int(b&0x7f) << shift
			shift += 7
			if b&0x80 == 0 {
				break
			}
			if shift > 63 {
				return 0, errPack
			}
		}
		return v, nil
	}
	srcSize, err := readVarint()
	if err != nil {
		return nil, err
	}
	if srcSize != len(base) {
		return nil, fmt.Errorf("delta base %d, got %d", srcSize, len(base))
	}
	tgtSize, err := readVarint()
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, tgtSize)
	for off < len(delta) {
		op := delta[off]
		off++
		if op&0x80 != 0 {
			copyOff, copySize := 0, 0
			for bit := 0; bit < 4; bit++ {
				if op&(1<<bit) != 0 {
					if off >= len(delta) {
						return nil, errPack
					}
					copyOff |= int(delta[off]) << (bit * 8)
					off++
				}
			}
			for bit := 0; bit < 3; bit++ {
				if op&(1<<(bit+4)) != 0 {
					if off >= len(delta) {
						return nil, errPack
					}
					copySize |= int(delta[off]) << (bit * 8)
					off++
				}
			}
			if copySize == 0 {
				copySize = 0x10000
			}
			if copyOff+copySize > len(base) {
				return nil, errPack
			}
			out = append(out, base[copyOff:copyOff+copySize]...)
		} else if op != 0 {
			n := int(op & 0x7f)
			if off+n > len(delta) {
				return nil, errPack
			}
			out = append(out, delta[off:off+n]...)
			off += n
		} else {
			return nil, errPack
		}
	}
	if len(out) != tgtSize {
		return nil, fmt.Errorf("delta menghasilkan %d dari %d", len(out), tgtSize)
	}
	return out, nil
}

var packTypeCode = map[int]string{1: "commit", 2: "tree", 3: "blob", 4: "tag"}
var packTypeNum = map[string]int{"commit": 1, "tree": 2, "blob": 3, "tag": 4}

// ReadPack membaca packfile (versi 2/3), memverifikasi trailer SHA-1, dan
// me-resolve semua objek (termasuk delta). resolveBase dipakai untuk REF_DELTA
// yang basisnya tidak ada di pack (objek yang sudah dimiliki server/klien).
func ReadPack(pack []byte, resolveBase func(oid string) *GitObject) ([]*GitObject, error) {
	if len(pack) < 32 {
		return nil, errPack
	}
	if string(pack[:4]) != "PACK" {
		return nil, errPack
	}
	version := binary.BigEndian.Uint32(pack[4:8])
	if version != 2 && version != 3 {
		return nil, fmt.Errorf("versi pack %d", version)
	}
	count := int(binary.BigEndian.Uint32(pack[8:12]))
	trailerStart := len(pack) - 20
	// Verifikasi trailer.
	sum := sha1.Sum(pack[:trailerStart])
	if !bytes.Equal(sum[:], pack[trailerStart:]) {
		return nil, errors.New("trailer pack tidak cocok")
	}
	entries := make([]*packEntry, 0, count)
	byOffset := map[int]*packEntry{}
	off := 12
	for i := 0; i < count; i++ {
		start := off
		first, size, next, err := readPackVarint(pack, off)
		if err != nil {
			return nil, err
		}
		off = next
		typeCode := int((first >> 4) & 0x07)
		e := &packEntry{offset: start, typeCode: typeCode, size: size}
		if typeCode == 6 {
			// OFS_DELTA: varint offset negatif.
			if off >= len(pack) {
				return nil, errPack
			}
			b := pack[off]
			off++
			baseOff := int(b & 0x7f)
			for b&0x80 != 0 {
				if off >= len(pack) {
					return nil, errPack
				}
				b = pack[off]
				off++
				baseOff = ((baseOff + 1) << 7) | int(b&0x7f)
			}
			e.baseOff = start - baseOff
		} else if typeCode == 7 {
			if off+20 > trailerStart {
				return nil, errPack
			}
			e.baseOID = hex.EncodeToString(pack[off : off+20])
			off += 20
		} else if packTypeCode[typeCode] == "" {
			return nil, fmt.Errorf("type pack %d", typeCode)
		}
		data, nextOff, err := inflateZlib(pack[:trailerStart], off)
		if err != nil {
			return nil, err
		}
		if len(data) != size {
			return nil, fmt.Errorf("entri pack ukuran %d, inflate %d", size, len(data))
		}
		e.data = data
		off = nextOff
		entries = append(entries, e)
		byOffset[start] = e
	}
	if off != trailerStart {
		return nil, errors.New("byte sisa sebelum trailer pack")
	}
	// Resolve (rekursif, dengan deteksi siklus).
	resolved := map[int]*GitObject{}
	resolving := map[int]bool{}
	var resolve func(e *packEntry) (*GitObject, error)
	resolve = func(e *packEntry) (*GitObject, error) {
		if o, ok := resolved[e.offset]; ok {
			return o, nil
		}
		if resolving[e.offset] {
			return nil, errors.New("siklus delta")
		}
		resolving[e.offset] = true
		defer delete(resolving, e.offset)
		var typ string
		var data []byte
		switch e.typeCode {
		case 6:
			baseEntry, ok := byOffset[e.baseOff]
			if !ok {
				return nil, errors.New("base ofs-delta tidak ada di pack")
			}
			base, err := resolve(baseEntry)
			if err != nil {
				return nil, err
			}
			typ = base.Type
			data, err = applyDelta(base.Data, e.data)
			if err != nil {
				return nil, err
			}
		case 7:
			var base *GitObject
			for _, cand := range resolved {
				if cand.OID() == e.baseOID {
					base = cand
					break
				}
			}
			if base == nil && resolveBase != nil {
				base = resolveBase(e.baseOID)
			}
			if base == nil {
				return nil, fmt.Errorf("base ref-delta %s tidak ditemukan", e.baseOID)
			}
			typ = base.Type
			var err error
			data, err = applyDelta(base.Data, e.data)
			if err != nil {
				return nil, err
			}
		default:
			typ = packTypeCode[e.typeCode]
			data = e.data
		}
		o := &GitObject{Type: typ, Data: data}
		resolved[e.offset] = o
		return o, nil
	}
	out := make([]*GitObject, 0, len(entries))
	seen := map[string]bool{}
	for _, e := range entries {
		o, err := resolve(e)
		if err != nil {
			return nil, err
		}
		if !seen[o.OID()] {
			seen[o.OID()] = true
			out = append(out, o)
		}
	}
	return out, nil
}

// writePackObjectHeader menulis header type/size varint git.
func writePackObjectHeader(typ string, size int) []byte {
	code := packTypeNum[typ]
	var out []byte
	first := byte((code << 4) | (size & 0x0f))
	size >>= 4
	for size > 0 {
		out = append(out, first|0x80)
		first = byte(size & 0x7f)
		size >>= 7
	}
	out = append(out, first)
	return out
}

// WritePack membangun packfile versi 2 dari objek penuh (tanpa delta).
// Entri memakai kompresi BestSpeed (waktu lebih penting dari ukuran pack;
// klien hanya memverifikasi struktur + checksum, bukan ukuran).
// Objek diurutkan berdasarkan OID supaya pack deterministik untuk input sama.
func WritePack(objs []*GitObject) []byte {
	sorted := make([]*GitObject, len(objs))
	copy(sorted, objs)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].OID() < sorted[j].OID() })
	var buf bytes.Buffer
	hdr := make([]byte, 12)
	copy(hdr, "PACK")
	binary.BigEndian.PutUint32(hdr[4:8], 2)
	binary.BigEndian.PutUint32(hdr[8:12], uint32(len(sorted)))
	buf.Write(hdr)
	for _, o := range sorted {
		buf.Write(writePackObjectHeader(o.Type, len(o.Data)))
		zw, _ := zlib.NewWriterLevel(&buf, zlib.BestSpeed)
		zw.Write(o.Data)
		zw.Close()
	}
	sum := sha1.Sum(buf.Bytes())
	buf.Write(sum[:])
	return buf.Bytes()
}

// --- reachability ---

// fetchPlan adalah hasil perencanaan fetch: objek yang dikirim + info shallow.
type fetchPlan struct {
	objects   []*GitObject
	shallow   []string
	unshallow []string
}

// planFetch menghitung objek yang harus dikirim untuk wants, dikurangi yang
// sudah dimiliki klien (haves). depth: 0 = tanpa batas; N = N generasi commit.
// clientShallow: batas shallow yang sudah dimiliki klien.
func planFetch(r *Repo, wants, haves []string, clientShallow []string, depth int) fetchPlan {
	// held: closure haves; shallow have hanya commit+tree+blob-nya (tanpa parent).
	held := map[string]bool{}
	shallowHave := map[string]bool{}
	for _, s := range clientShallow {
		shallowHave[s] = true
	}
	var markHeld func(oid string, isCommit bool, allowParents bool)
	markHeld = func(oid string, isCommit bool, allowParents bool) {
		if held[oid] {
			return
		}
		o, ok := r.Objects[oid]
		if !ok {
			return
		}
		held[oid] = true
		switch o.Type {
		case "commit":
			c := ParseCommit(o.Data)
			markHeld(c.Tree, false, true)
			if allowParents && !shallowHave[oid] {
				for _, p := range c.Parents {
					markHeld(p, true, true)
				}
			}
		case "tree":
			for _, e := range ParseTree(o.Data) {
				markHeld(e.OID, false, true)
			}
		case "tag":
			t := ParseTag(o.Data)
			markHeld(t.Object, t.Type == "commit", true)
		}
	}
	for _, h := range haves {
		markHeld(h, true, true)
	}

	// include: commit yang masuk (BFS dari wants, dibatasi depth).
	included := map[string]bool{}
	includedCommits := map[string]int{} // oid -> generasi (1 = want)
	type queueItem struct {
		oid string
		gen int
	}
	queue := []queueItem{}
	pushCommit := func(oid string, gen int) {
		if includedCommits[oid] != 0 {
			return
		}
		includedCommits[oid] = gen
		queue = append(queue, queueItem{oid, gen})
	}
	for _, w := range wants {
		o, ok := r.Objects[w]
		if !ok {
			continue
		}
		if o.Type == "tag" {
			included[w] = true
			t := ParseTag(o.Data)
			if t.Type == "commit" {
				pushCommit(t.Object, 1)
			} else {
				included[t.Object] = true
			}
		} else if o.Type == "commit" {
			pushCommit(w, 1)
		} else {
			included[w] = true
		}
	}
	// BFS parent.
	for len(queue) > 0 {
		it := queue[0]
		queue = queue[1:]
		included[it.oid] = true
		if depth > 0 && it.gen >= depth {
			continue
		}
		o := r.Objects[it.oid]
		if o == nil || o.Type != "commit" {
			continue
		}
		for _, p := range ParseCommit(o.Data).Parents {
			if _, ok := r.Objects[p]; ok {
				pushCommit(p, it.gen+1)
			}
		}
	}
	// Objek yang dikirim: semua yang reachable dari included, dikurangi held.
	send := map[string]bool{}
	var collect func(oid string)
	collect = func(oid string) {
		if send[oid] || held[oid] {
			return
		}
		o, ok := r.Objects[oid]
		if !ok {
			return
		}
		send[oid] = true
		switch o.Type {
		case "commit":
			c := ParseCommit(o.Data)
			collect(c.Tree)
		case "tree":
			for _, e := range ParseTree(o.Data) {
				collect(e.OID)
			}
		case "tag":
			collect(ParseTag(o.Data).Object)
		}
	}
	for oid := range included {
		collect(oid)
	}
	// Urutan deterministik: commit dulu (generasi naik), lalu sisanya by oid.
	var objs []*GitObject
	var commits []string
	var rest []string
	for oid := range send {
		if _, isCommit := includedCommits[oid]; isCommit {
			commits = append(commits, oid)
		} else {
			rest = append(rest, oid)
		}
	}
	sort.Slice(commits, func(i, j int) bool { return includedCommits[commits[i]] < includedCommits[commits[j]] })
	sort.Strings(rest)
	for _, oid := range commits {
		objs = append(objs, r.Objects[oid])
	}
	for _, oid := range rest {
		objs = append(objs, r.Objects[oid])
	}
	// shallow baru: commit yang masuk di batas depth (punya parent tapi tidak masuk).
	var shallow []string
	if depth > 0 {
		for oid, gen := range includedCommits {
			if gen != depth {
				continue
			}
			o := r.Objects[oid]
			if o == nil || o.Type != "commit" {
				continue
			}
			parents := ParseCommit(o.Data).Parents
			hasMissingParent := false
			for _, p := range parents {
				if includedCommits[p] == 0 {
					hasMissingParent = true
				}
			}
			if len(parents) > 0 && hasMissingParent {
				shallow = append(shallow, oid)
			} else if len(parents) == 0 {
				// Root commit di batas depth tetap shallow (tidak ada parent untuk dikirim).
				shallow = append(shallow, oid)
			}
		}
		sort.Strings(shallow)
	}
	// unshallow: batas lama klien yang kini lengkap (commit + parent-nya masuk).
	var unshallow []string
	for _, s := range clientShallow {
		gen, ok := includedCommits[s]
		if !ok || gen == 0 {
			continue
		}
		o := r.Objects[s]
		if o == nil || o.Type != "commit" {
			continue
		}
		parents := ParseCommit(o.Data).Parents
		allIn := true
		for _, p := range parents {
			if includedCommits[p] == 0 {
				allIn = false
			}
		}
		if allIn {
			unshallow = append(unshallow, s)
		}
	}
	sort.Strings(unshallow)
	return fetchPlan{objects: objs, shallow: shallow, unshallow: unshallow}
}

// flattenTreeLocked mengurai tree menjadi map path -> blob oid (rekursif).
func flattenTreeLocked(r *Repo, treeOID string) map[string]string {
	out := map[string]string{}
	var walk func(treeOID, prefix string)
	walk = func(treeOID, prefix string) {
		o, ok := r.Objects[treeOID]
		if !ok || o.Type != "tree" {
			return
		}
		for _, e := range ParseTree(o.Data) {
			p := prefix + e.Name
			if e.Mode == "40000" {
				walk(e.OID, p+"/")
			} else {
				out[p] = e.OID
			}
		}
	}
	walk(treeOID, "")
	return out
}

// buildTreeFromMapLocked membangun ulang tree bersarang dari map path -> blob oid,
// menyimpan tree baru di r.Objects. Mengembalikan oid tree root.
func buildTreeFromMapLocked(r *Repo, files map[string]string) string {
	type node struct {
		files map[string]string
		dirs  map[string]*node
	}
	mk := func() *node { return &node{files: map[string]string{}, dirs: map[string]*node{}} }
	root := mk()
	for path, oid := range files {
		parts := splitPath(path)
		n := root
		for _, seg := range parts[:len(parts)-1] {
			if n.dirs[seg] == nil {
				n.dirs[seg] = mk()
			}
			n = n.dirs[seg]
		}
		n.files[parts[len(parts)-1]] = oid
	}
	var build func(n *node) string
	build = func(n *node) string {
		var entries []TreeEntry
		for name, oid := range n.files {
			entries = append(entries, TreeEntry{Mode: "100644", Name: name, OID: oid})
		}
		for name, child := range n.dirs {
			entries = append(entries, TreeEntry{Mode: "40000", Name: name, OID: build(child)})
		}
		data := BuildTree(entries)
		oid := hashObject("tree", data)
		if _, ok := r.Objects[oid]; !ok {
			r.Objects[oid] = &GitObject{Type: "tree", Data: data}
		}
		return oid
	}
	return build(root)
}

func splitPath(p string) []string {
	var out []string
	cur := ""
	for i := 0; i < len(p); i++ {
		if p[i] == '/' {
			out = append(out, cur)
			cur = ""
		} else {
			cur += string(p[i])
		}
	}
	out = append(out, cur)
	return out
}

// headTreeLocked mengembalikan oid tree di tip branch ("" kalau kosong/tidak ada).
func headTreeLocked(r *Repo, branch string) string {
	tip, ok := r.Refs["refs/heads/"+branch]
	if !ok {
		return ""
	}
	o, ok := r.Objects[tip]
	if !ok || o.Type != "commit" {
		return ""
	}
	return ParseCommit(o.Data).Tree
}

// diffTreesLocked membandingkan tree base vs head (lewat commit), menghasilkan
// daftar file yang berubah.
func diffTreesLocked(r *Repo, baseSHA, headSHA string) []PRFile {
	baseTree, headTree := "", ""
	if o, ok := r.Objects[baseSHA]; ok && o.Type == "commit" {
		baseTree = ParseCommit(o.Data).Tree
	}
	if o, ok := r.Objects[headSHA]; ok && o.Type == "commit" {
		headTree = ParseCommit(o.Data).Tree
	}
	baseFiles := map[string]string{}
	if baseTree != "" {
		baseFiles = flattenTreeLocked(r, baseTree)
	}
	headFiles := map[string]string{}
	if headTree != "" {
		headFiles = flattenTreeLocked(r, headTree)
	}
	var out []PRFile
	for path, oid := range headFiles {
		if b, ok := baseFiles[path]; !ok {
			out = append(out, PRFile{Filename: path, Status: "added", Additions: 1, Deletions: 0, Changes: 1})
		} else if b != oid {
			out = append(out, PRFile{Filename: path, Status: "modified", Additions: 1, Deletions: 1, Changes: 2})
		}
	}
	for path := range baseFiles {
		if _, ok := headFiles[path]; !ok {
			out = append(out, PRFile{Filename: path, Status: "removed", Additions: 0, Deletions: 1, Changes: 1})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Filename < out[j].Filename })
	return out
}

// isAncestorLocked: true kalau anc adalah ancestor (atau sama) dari desc.
func isAncestorLocked(r *Repo, anc, desc string) bool {
	if anc == desc {
		return true
	}
	seen := map[string]bool{}
	queue := []string{desc}
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
		for _, p := range ParseCommit(o.Data).Parents {
			if p == anc {
				return true
			}
			queue = append(queue, p)
		}
	}
	return false
}

// mergeBaseLocked mencari merge-base (ancestor bersama pertama via BFS).
func mergeBaseLocked(r *Repo, a, b string) string {
	ancA := map[string]bool{}
	queue := []string{a}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if ancA[cur] {
			continue
		}
		ancA[cur] = true
		o, ok := r.Objects[cur]
		if !ok || o.Type != "commit" {
			continue
		}
		queue = append(queue, ParseCommit(o.Data).Parents...)
	}
	queue = []string{b}
	seen := map[string]bool{}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		if ancA[cur] {
			return cur
		}
		o, ok := r.Objects[cur]
		if !ok || o.Type != "commit" {
			continue
		}
		queue = append(queue, ParseCommit(o.Data).Parents...)
	}
	return ""
}

// mergeableLocked: head turunan base, atau perubahan head vs merge-base tidak
// bertabrakan dengan perubahan base vs merge-base.
func mergeableLocked(r *Repo, baseSHA, headSHA string) bool {
	if isAncestorLocked(r, baseSHA, headSHA) {
		return true
	}
	mb := mergeBaseLocked(r, baseSHA, headSHA)
	if mb == "" {
		return false
	}
	baseTree, headTree, mbTree := "", "", ""
	treeOf := func(sha string) string {
		if o, ok := r.Objects[sha]; ok && o.Type == "commit" {
			return ParseCommit(o.Data).Tree
		}
		return ""
	}
	baseTree, headTree, mbTree = treeOf(baseSHA), treeOf(headSHA), treeOf(mb)
	baseFiles := flattenTreeLocked(r, baseTree)
	headFiles := flattenTreeLocked(r, headTree)
	mbFiles := flattenTreeLocked(r, mbTree)
	changedInBase := map[string]bool{}
	for p, oid := range baseFiles {
		if mbFiles[p] != oid {
			changedInBase[p] = true
		}
	}
	for p := range mbFiles {
		if _, ok := baseFiles[p]; !ok {
			changedInBase[p] = true
		}
	}
	for p, oid := range headFiles {
		if mbFiles[p] != oid && changedInBase[p] {
			// Kedua sisi mengubah path yang sama dengan hasil berbeda.
			if baseFiles[p] != oid {
				return false
			}
		}
	}
	for p := range mbFiles {
		if _, ok := headFiles[p]; !ok && changedInBase[p] {
			return false
		}
	}
	return true
}

// mergeTreesLocked: tree hasil merge (perubahan head diterapkan di atas tree base).
// "" kalau konflik.
func mergeTreesLocked(r *Repo, baseTip, headSHA string) string {
	if isAncestorLocked(r, baseTip, headSHA) {
		if o, ok := r.Objects[headSHA]; ok && o.Type == "commit" {
			return ParseCommit(o.Data).Tree
		}
		return ""
	}
	mb := mergeBaseLocked(r, baseTip, headSHA)
	if mb == "" {
		return ""
	}
	treeOf := func(sha string) string {
		if o, ok := r.Objects[sha]; ok && o.Type == "commit" {
			return ParseCommit(o.Data).Tree
		}
		return ""
	}
	baseFiles := flattenTreeLocked(r, treeOf(baseTip))
	headFiles := flattenTreeLocked(r, treeOf(headSHA))
	mbFiles := flattenTreeLocked(r, treeOf(mb))
	merged := map[string]string{}
	for p, oid := range baseFiles {
		merged[p] = oid
	}
	for p, oid := range headFiles {
		if mbFiles[p] != oid {
			// Head mengubah path ini: terapkan, kecuali base juga mengubahnya beda.
			if b, ok := baseFiles[p]; ok && b != mbFiles[p] && b != oid {
				return ""
			}
			merged[p] = oid
		}
	}
	for p := range mbFiles {
		if _, ok := headFiles[p]; !ok {
			// Head menghapus path ini.
			if b, ok := baseFiles[p]; ok && b != mbFiles[p] {
				return ""
			}
			delete(merged, p)
		}
	}
	return buildTreeFromMapLocked(r, merged)
}
