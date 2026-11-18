# git-forge r5 — Desain (Go static binary)

Tujuan: kalahkan rank 1 (966, Perf grader 166) di GRADER. Kunci: Perf lokal harus
≥199 (semua workload di cap 50) karena faktor grader ≈ 2,33× dari lokal (r3: lokal
199 → grader 138). Target lokal: push ≤280ms, clone ≤45ms, read ≤470ms, write ≤60ms.

## Arsitektur

- Go 1.27.4, stdlib SAJA (tanpa dependensi luar). Modul `forge`.
- Entry point grader adalah `node /bot/main.ts` (Node 22). `main.ts` hanya launcher tipis:
  spawn `./forge` (binary Go di repo yang sama) dengan env diteruskan, tunggu sampai
  selesai. Kalau exec bit hilang saat push (push-files), salin ke /tmp/forge + chmod +x.
- `forge` (Go) yang menjalankan SEMUA logika: lifecycle + HTTP server.
- Lifecycle: kalau `MAKEFUN_ENV_URL` ada → mode grader (bind ephemeral, POST
  /register {"port": N}, poll GET /done sampai {"done": true}, exit 0). Kalau `PORT`
  ada → mode lokal (listen 127.0.0.1:$PORT, tanpa register). Token bearer dari
  `MAKEFUN_SHOP_TOKEN` (kalau env kosong: terima bearer apa pun yang dikirim, tapi
  tetap 401 kalau header Authorization tidak ada).

## File

- `main.go` — lifecycle + wiring server.
- `main.ts` — launcher (spawn ./forge, fallback /tmp).
- `scenario.go` — reimplementasi RNG skenario (seed 0x6a09e667f3bcc909): viewer
  `adaiversen` (id 1000), teammate `quinnkeller`, stranger `olgabauer`, org
  `faint-meadow-org`. Dipakai untuk login viewer + user yang dikenal.
- `store.go` — tipe domain + Store (thread-safe, satu RWMutex global).
- `pack.go` — objek git, SHA-1, pack read/write (full object SAJA saat menulis;
  baca full + OFS/REF delta), tree/commit/tag parse+build, reachability.
- `http.go` — server, auth middleware, JSON helpers, X-GitHub-Request-Id.
- `git.go` — smart HTTP: info/refs (upload-pack v2, receive-pack v0),
  git-upload-pack (ls-refs + fetch v2), git-receive-pack (v0 + report-status).
- `rest.go` — REST v3 (lihat rest-spec.md).
- `graphql.go` — GraphQL v4 (lihat graphql-mcp-spec.md).
- `mcp.go` — MCP JSON-RPC 2.0 Streamable HTTP (lihat graphql-mcp-spec.md).

## Store API (dipakai semua permukaan)

Tipe: `User{ID,Login,Name,Email}`, `Label{Name,Color,Description}`,
`Comment{ID,Body,Author,CreatedAt}`, `Issue{ID,Number,Title,Body,State,Labels,Author,CreatedAt,UpdatedAt,Comments}`,
`PRFile{Filename,Status,Additions,Deletions,Changes}`, `Pull{ID,Number,Title,Body,Head,Base,HeadSHA,BaseSHA,State,Merged,Mergeable,MergeCommitSHA,Files,Author,CreatedAt,UpdatedAt}`,
`Repo{ID,Owner,Name,Description,Private,DefaultBranch,CreatedAt,UpdatedAt,Refs,Objects,Issues,IssueSeq,Pulls,PullSeq,Labels}`,
`GitObject{Type,Data}` + `OID()` (SHA-1 "type size\0"+data).

Metode Store (semua mengunci sendiri; pemanggil TIDAK mengunci):
`CreateRepo(owner,name,desc,priv)`, `GetRepo(owner,name)`, `DeleteRepo(owner,name)`,
`ListRepos(owner)`, `CreateIssue(r,title,body,labels)`, `GetIssue(r,n)`,
`PatchIssue(r,n,fields)`, `CreateComment(r,issueN,body)`, `CreatePull(r,title,body,head,base)`,
`GetPull(r,n)`, `MergePull(r,n,method)`, `PutContents(r,path,content,message,sha,author)`,
`GetContents(r,path)`, `DeleteContents(r,path,message,sha)`, `GetObject(r,oid)`,
`PutObjects(r,objs)`, `GetRef(r,ref)`, `SetRef(r,ref,oid)`, `ListRefs(r)`.

Aturan store:
- Timestamp `CreatedAt`/`UpdatedAt` HARUS strictly increasing per pembuatan
  (pakai `nextTime()`: max(now, last+1ms)) supaya sort by created_at = urutan nomor.
- Issue/PR `Number` mulai 1 per repo, naik berurutan. Repo `ID` naik global mulai 1.
- `PutContents`: file disimpan sebagai objek git (blob/tree/commit) di branch default;
  commit baru parent = tip lama; author = viewer; message = yang dikirim klien.
- `MergePull` (squash default): commit merge di base branch, tree = tree head,
  parent = [tip base]; `Merged=true`, `State=closed`, `MergeCommitSHA` = commit baru.
  Mergeable = head turunan base, atau tidak ada konflik file (3-way sederhana);
  kalau konflik → merge 405.
- Objek git disimpan APA ADANYA (byte-exact); SHA-1 dihitung ulang saat PutObjects.

## HTTP plumbing (http.go)

- Router: `net/http` ServeMux Go 1.22 (pattern `METHOD /path/{var}`).
- Auth: semua route KECUALI `/healthz` butuh `Authorization: Bearer <token>`.
  Tanpa/bukan token → 401 JSON `{"message":"..."}`. Git smart HTTP juga butuh auth
  (klien selalu mengirim Bearer); repo yang tidak ada → 404 (setelah auth lolos).
- `X-GitHub-Request-Id`: header non-empty di SEMUA balasan API (REST/GraphQL/MCP).
- JSON: `writeJSON(w, status, v)` (Content-Type application/json, kunci terurut),
  `writeErr(w, status, msg)` → `{"message": msg}`.
- `/healthz` → 200 `{"status":"ok"}` (atau teks "ok"; tanpa auth).
- Jangan pernah panic di handler: recover → 500 JSON, server tetap hidup.

## Git (git.go) — ringkasan protokol

- `GET /{owner}/{repo}.git/info/refs?service=git-upload-pack` → v2: paket pertama
  `version 2\n`, lalu capability per pkt-line: `fetch=shallow`, `ls-refs=unborn`,
  `object-format=sha1`, `agent`. Diakhiri flush. Content-Type
  `application/x-git-upload-pack-advertisement`.
- `GET .../info/refs?service=git-receive-pack` → v0: baris pertama
  `<oid> <ref>\0<capabilities>` (capabilities: `report-status side-band-64k
  delete-refs ofs-delta agent symref=HEAD:refs/heads/main`), satu baris per ref,
  peeled tag `<oid> <ref>^{}`. Repo kosong: satu baris
  `000...0 capabilities^{}\0<caps>`. Content-Type
  `application/x-git-receive-pack-advertisement`. Repo tidak ada → 404.
- `POST /{owner}/{repo}.git/git-upload-pack` (Git-Protocol: version=2):
  perintah `ls-refs` (argumen: peel, symrefs, unborn, ref-prefix X) dan `fetch`
  (thin-pack, no-progress, ofs-delta, want, have, shallow, deepen N, done).
  Balasan fetch: seksi dipisah delim/flush: `acknowledgments\n` (NAK + ready,
  hanya kalau ada haves), `shallow-info\n` (shallow/unshallow), `packfile\n`
  (sideband band 1 = byte pack, band 2 = progress; SELALU ≥1 paket sideband).
  Pack: versi 2, full object saja (tanpa delta), trailer SHA-1 benar. Pack kosong
  (0 objek) tetap valid (12 header + 20 trailer = 32 byte).
- `POST /{owner}/{repo}.git/git-receive-pack` (v0): baca command list + pack,
  simpan objek, terapkan perintah per ref: create (old ZERO) ok; update FF ok;
  non-FF → `ng <ref> non-fast-forward`; delete (new ZERO) ok. Balasan:
  report-status sebagai pkt-line di dalam sideband band 1 (`unpack ok\n`,
  `ok <ref>\n` / `ng <ref> <reason>\n`), lalu flush luar. Unpack SELALU ok
  (walau ada ref ditolak). Content-Type `application/x-git-receive-pack-result`.
- Have/want (fetch): kirim closure(wants) MINUS closure(haves). Depth: potong
  di kedalaman N (commit di batas = shallow); deepen dari shallow lama:
  kirim 1 generasi tambahan + `unshallow` untuk batas lama yang kini tercapai.
  Tag: peel ke commit untuk ls-refs `peel`; sertakan objek tag saat want = tag.
- Pkt-line: panjang 4 hex termasuk header; flush `0000`, delim `0001`.
  Batas payload 65516. Request malformed → 400/500 JSON tapi server tetap hidup.

## Perf (aturan keras)

- JANGAN alokasi yang tidak perlu di hot path: reuse buffer, marshal JSON langsung
  ke ResponseWriter (json.Encoder), hindari fmt.Sprintf di loop.
- Pack clone: salin objek di bawah RLock, lepas lock, baru deflate (paralel 50).
- Deflate: `compress/zlib` level default; pertimbangkan `flate.BestSpeed` untuk
  blob besar (uji: kecepatan vs ukuran tidak dinilai, hanya waktu).
- Read (GET issue): lookup map + marshal — target <0,2ms/req.
- Write (POST issue): parse body + buat issue + marshal — target <0,3ms/req.
- Push: parse pack (3 objek kecil) + update ref + report — target <1,4ms/push.
- Clone depth-1: 4 objek kecil per clone, 50 konkuren — target <45ms/round.
- JANGAN baca file kode r3/r4. Tulis SEMUA kode Go fresh dari spek ini + spek permukaan.
