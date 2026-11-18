// Reimplementasi RNG skenario dari kit (sdk/conformance/wire.ts) supaya server tahu
// identitas viewer/teammate/stranger/org TANPA membaca data suite saat jalan.
// Algoritma: FNV-1a 64-bit, splitmix64 finalizer (mix64), xorshift64*.
// Terverifikasi: viewer=adaiversen, teammate=quinnkeller, stranger=olgabauer,
// org=faint-meadow-org (cocok dengan buildScenario() kit).
package main

const scenarioSeed uint64 = 0x6a09e667f3bcc909

var firstNames = []string{
	"ada", "bram", "cora", "dmitri", "elena", "felix", "greta", "hugo", "iris", "jonas",
	"kira", "lars", "mira", "nico", "olga", "pavel", "quinn", "rosa", "sven", "tess",
	"ulla", "vito", "wren", "yara", "zane",
}

var lastNames = []string{
	"anders", "bauer", "costa", "dahl", "eriksen", "fischer", "garcia", "holm", "iversen",
	"jansen", "keller", "lind", "moreau", "novak", "olsen", "peters", "quist", "rossi",
	"sato", "turi", "ulrich", "vega", "weber", "xu", "yilmaz", "zimmer",
}

var repoAdjectives = []string{
	"amber", "brisk", "calm", "crisp", "eager", "faint", "gentle", "happy", "idle", "jolly",
	"keen", "lively", "mellow", "nimble", "open", "plain", "quick", "quiet", "rapid", "soft",
	"steady", "tidy", "upbeat", "vivid", "warm", "witty", "young", "zesty",
}

var repoNouns = []string{
	"acorn", "badger", "canyon", "cedar", "comet", "coral", "delta", "ember", "falcon",
	"glade", "harbor", "indigo", "juniper", "kettle", "lantern", "meadow", "nebula", "orchid",
	"pebble", "quartz", "raven", "saffron", "thistle", "umber", "violet", "willow", "yarrow",
	"zephyr",
}

func fnv1a64(text string) uint64 {
	hash := uint64(0xcbf29ce484222325)
	for i := 0; i < len(text); i++ {
		hash ^= uint64(text[i])
		hash *= 0x100000001b3
	}
	return hash
}

func mix64(v uint64) uint64 {
	z := v + 0x9e3779b97f4a7c15
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

func scenarioSeedFor(label string) uint64 {
	return mix64(scenarioSeed ^ fnv1a64(label))
}

// rng adalah xorshift64* dengan state 64-bit.
type rng struct{ state uint64 }

func newRng(seed uint64) *rng {
	if seed == 0 {
		seed = scenarioSeed
	}
	return &rng{state: seed}
}

func (r *rng) nextU64() uint64 {
	x := r.state
	x ^= x >> 12
	x ^= x << 25
	x ^= x >> 27
	r.state = x
	return x * 0x2545f4914f6cdd1d
}

func (r *rng) nextU32() uint32 { return uint32(r.nextU64() >> 32) }

func (r *rng) nextInt(maxExclusive int) int {
	if maxExclusive <= 1 {
		return 0
	}
	const range32 = 4294967296
	limit := range32 - (range32 % uint64(maxExclusive))
	for {
		v := uint64(r.nextU32())
		if v < limit {
			return int(v % uint64(maxExclusive))
		}
	}
}

func (r *rng) pick(items []string) string { return items[r.nextInt(len(items))] }

func generateUsers(r *rng, count int) []User {
	used := map[string]bool{}
	users := make([]User, 0, count)
	for i := 0; i < count; i++ {
		first := r.pick(firstNames)
		last := r.pick(lastNames)
		base := first + last
		login := base
		suffix := 2
		for used[login] {
			login = base + "-" + itoa(suffix)
			suffix++
		}
		used[login] = true
		users = append(users, User{
			ID:    int64(1000 + i),
			Login: login,
			Name:  first + " " + last,
			Email: login + "@example.invalid",
		})
	}
	return users
}

func itoa(n int) string {
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

// scenarioUsers adalah 12 user skenario; index 0 = viewer, 1 = teammate, 2 = stranger.
var scenarioUsers = func() []User {
	return generateUsers(newRng(scenarioSeedFor("users")), 12)
}()

// scenarioOrg adalah nama organisasi skenario.
var scenarioOrg = func() string {
	r := newRng(scenarioSeedFor("org"))
	return r.pick(repoAdjectives) + "-" + r.pick(repoNouns) + "-org"
}()

// Viewer adalah pemilik token (users[0]).
func Viewer() User { return scenarioUsers[0] }

// Teammate adalah users[1].
func Teammate() User { return scenarioUsers[1] }

// Stranger adalah users[2].
func Stranger() User { return scenarioUsers[2] }

// OrgName adalah nama organisasi skenario.
func OrgName() string { return scenarioOrg }

// KnownUser mencari user skenario berdasarkan login.
func KnownUser(login string) (User, bool) {
	for _, u := range scenarioUsers {
		if u.Login == login {
			return u, true
		}
	}
	if login == scenarioOrg {
		return User{ID: 9000, Login: login, Name: login, Email: login + "@example.invalid"}, true
	}
	return User{}, false
}
