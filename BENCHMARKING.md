# Benchmarking & load testing (Harmony)

This document explains **what our current benchmark scripts actually measure**, **what they do not measure**, and **how to build a professional, layered load-testing program** aligned with how Harmony works (Supabase, Realtime, federation, BullMQ, LiveKit).

---

## 1. Why “can we handle 100k users?” needs a definition

**Concurrent usage is not one number.** Before benchmarking, define scenarios in concrete terms:

| Question | Why it matters |
|----------|----------------|
| **100k what?** | Open tabs with active WebSockets? Users sending messages this minute? Daily active users spread over 24h? |
| **Read vs write ratio?** | Chat apps are often read-heavy with bursts of writes; notification/federation paths are write- and queue-heavy. |
| **Which subsystems?** | PostgREST, Supabase Realtime, federation HTTP, Bull workers, Redis, LiveKit, and the browser app are separate bottlenecks. |

**Example scenarios (good inputs to a test plan):**

- *S1 - Connected clients:* N simultaneous Realtime WebSocket connections, minimal messages.
- *S2 - Channel read load:* N users polling or subscribing while scrolling history (REST + Realtime).
- *S3 - Chat write load:* M messages per second into one or many channels (inserts + triggers + notifications).
- *S4 - Federation:* Inbound/outbound ActivityPub rate and Bull queue depth / worker throughput.
- *S5 - Voice/video:* Concurrent LiveKit participants (see LiveKit docs + `scripts/benchmark-voice.sh`).

Until scenarios are defined, **no single script can prove “100k users.”**

---

## 2. What we ship today (and what it proves)

### 2.1 `scripts/benchmark-api.sh`

| Mode | Behavior | Useful for |
|------|-----------|------------|
| **`--mode quick`** | `curl` latency probes against a few PostgREST `GET`s (+ optional federation `/health`, WebFinger, NodeInfo). | Smoke tests, regressions, “is the API up and roughly fast?” |
| **`--mode full`** | **k6** with many virtual users (VUs) looping **HTTP GET**s: servers, channels, messages, profiles, federation health. | **Anonymous read** throughput and latency on PostgREST + a simple federation check. |

**Credentials:** Uses the **anon** key (`Authorization: Bearer <anon>` + `apikey`). That is the same **PostgreSQL `anon` role** as a logged-out app visitor-not “no auth.” Whether rows return empty or 200 with data is determined by **RLS policies**.

**Not covered by this script:**

- Logged-in **user JWT** traffic (different RLS paths).
- **Writes** (messages, reactions, edits, DMs).
- **Supabase Realtime** (long-lived WebSockets, `postgres_changes`, broadcast channels, presence).
- **BullMQ** (jobs only appear when code paths enqueue work-plain reads do not).
- **LiveKit** (use the voice benchmark script instead).

**Implication:** A passing run means “under this synthetic **read** pattern, these endpoints behaved within thresholds.” It does **not** mean “the product supports 100k concurrent real users.”

### 2.2 `scripts/benchmark-voice.sh`

Wraps LiveKit’s official **`lk load-test`** CLI (see [LiveKit benchmarking](https://docs.livekit.io/transport/self-hosting/benchmark/)). Tests **media SFU** capacity (audio/video publishers and subscribers), not the Harmony app server or database.

**Also see:** `webrtc/TESTING.md`.

### 2.3 `webrtc/test/load-test.ts` (legacy / limited)

Uses browser-oriented SDK patterns; **not** suitable as a headless Node load generator without a real browser. Prefer **`lk load-test`** for LiveKit.

---

## 3. Virtual users (VUs) vs real humans

- **k6 VU** = one concurrent loop executing your script (HTTP/WebSocket steps + think time).
- **100 VUs** with a short sleep can generate **more requests per second** than 100 casual humans-or fewer, depending on sleeps and scenario.
- **100k concurrent “users”** in production usually implies **100k long-lived connections** (especially Realtime), **regional distribution**, and **horizontal scaling**. That requires **distributed load generators** and infra limits (file descriptors, connection counts, pooler mode, etc.), not a single laptop.

---

## 4. Why Bull Board may show nothing during API benchmarks

**Bull Board shows queued jobs.** The default `benchmark-api.sh` traffic is **read-only HTTP** to PostgREST and `/health`. Those paths typically **do not enqueue** federation or notification jobs.

Expect Bull activity only when tests (or real traffic) hit paths that **push jobs** (e.g. federation delivery, async workers). Design write/federation scenarios explicitly if queue behavior is part of the SLO.

---

## 5. Building an efficient, professional benchmark program

Use a **layered** approach: prove each tier, then combine representative **mix scenarios**.

### Phase A - Goals and SLOs

1. Write down **Service Level Objectives** (e.g. p95 REST < 500 ms at X RPS; Realtime connect success > 99.9%; max Bull backlog < N; zero 5xx under Y load).
2. Map SLOs to **components**: PostgREST, Realtime, DB pooler, federation API, workers, Redis, LiveKit.
3. Decide **environment**: **staging / dedicated load env** strongly recommended; avoid hammering production without approval and safeguards.

### Phase B - Baseline and observability

1. Ensure **metrics and logs** exist: DB CPU/latency, pooler stats, Realtime metrics, federation process metrics, Redis, queue depth, nginx/ingress.
2. Run **light** smoke tests (`benchmark-api.sh --mode quick`) to establish a baseline before changes.
3. Document **hardware** (vCPU, RAM, region) for every result-otherwise numbers are not comparable.

### Phase C - Layer 1: HTTP (REST / RPC)

1. **Anon reads** - current `benchmark-api.sh` (optional: tune k6 thresholds to match your SLOs; high concurrency often exceeds naive p95 targets).
2. **Authenticated reads/writes** - extend k6 to use **`SUPABASE_USER_JWT`** (or per-VU tokens) so RLS matches real users.
3. **Write scenarios** - rate-limited inserts to a **dedicated test channel** or via RPC; measure latency, errors, and **side effects** (triggers, notifications, federation).
4. **Service role** - only in isolated envs; never in client-facing benchmarks; documents “upper bound” of DB/PostgREST, not user security.

### Phase D - Layer 2: Realtime (WebSockets)

1. Use **k6 WebSocket** (or Supabase’s documented approaches) to open **long-lived** connections.
2. Subscribe to realistic topics: `postgres_changes` on messages, broadcast channels, presence if applicable.
3. Measure **connection success rate**, **reconnect storms**, **message latency**, and **server resource usage** under N concurrent sockets.
4. Scale with **distributed k6** (multiple agents) when approaching thousands+ of connections.

### Phase E - Layer 3: Federation & queues

1. Define **inbound** load (HTTP POST to inbox) vs **outbound** (jobs processed per second).
2. Monitor **Bull** depth, **processing time**, failures, and retries under sustained load.
3. Correlate with **DB write** load and **rate limits** (remote instances, signatures, etc.).

### Phase F - Layer 4: Voice/video (LiveKit)

1. Use **`lk load-test`** via `scripts/benchmark-voice.sh`.
2. Run the load generator on **separate** machines from the SFU when possible; raise `ulimit -n` only when simulating very many participants on the generator host.

### Phase G - Mix scenarios (“soak” and “peak”)

1. **Peak:** short burst combining REST + Realtime + a slice of writes.
2. **Soak:** moderate load for hours/days to find leaks, connection churn issues, and slow disk growth.
3. **Failure injection** (advanced): pooler failover, worker restart, single Realtime node loss-validate recovery.

### Phase H - Reporting

1. Store **k6 summary** + **Grafana/dashboard screenshots** + **git SHA** + **env spec**.
2. Record **pass/fail against SLOs**, not just “no errors.”
3. Re-run on **release candidates** or after schema/migration changes that touch hot paths.

---

## 6. Practical commands (current repo)

```bash
# REST smoke test (no k6)
./scripts/benchmark-api.sh --mode quick

# REST load test (k6; anon reads)
./scripts/benchmark-api.sh --mode full --vus 100 --duration 60s

# Voice/video (LiveKit CLI)
./scripts/benchmark-voice.sh --preset audio-small
```

Environment variables are documented in `./scripts/benchmark-api.sh --help` and `webrtc/TESTING.md`.

---

## 7. Summary

| Question | Answer |
|----------|--------|
| Does `benchmark-api.sh` simulate 100k real users? | **No.** It stresses a **subset of anonymous HTTP reads** (and optional federation health). |
| Is it useless? | **No** - it’s useful for **smoke tests** and **read-heavy PostgREST** regression checks. |
| What’s needed for “professional” capacity confidence? | **Defined scenarios**, **layered tests** (HTTP + Realtime + writes + queues + LiveKit), **observability**, **staging**, and often **distributed** load generation for very large N. |

---

## 8. References

- [k6 documentation](https://grafana.com/docs/k6/latest/)
- [k6 WebSockets](https://grafana.com/docs/k6/latest/using-k6/protocols/websockets/)
- [Supabase Realtime benchmarks (overview)](https://supabase.com/docs/guides/realtime/benchmarks)
- [LiveKit self-hosting benchmarks](https://docs.livekit.io/transport/self-hosting/benchmark/)
