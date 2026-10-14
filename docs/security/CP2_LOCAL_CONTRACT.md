# CP2 local orchestration reference

`src/security/session-service.ts`, `token-envelope.ts` and `csrf.ts` preserve the injected local orchestration reference and its tests. The single-owner application uses `src/owner-auth.ts` and `src/owner-runtime.ts` instead; this package does not activate a custom durable session platform.

The reference service exposes login challenge, login, MFA challenge/completion, authorization, refresh, rotation, logout and recovery initiation. Subject epoch/recovery and single-use origin-bound challenge ports supplement session CAS. Fresh membership, epoch, recovery and loaded revision are checked around asynchronous completion. Provider success cannot erase local terminal restrictions.

Opaque handles are server-only transport values; storage contains hashes and encrypted provider tokens. Atomic CAS includes audit and hash retirement. All-device logout invalidates captured epochs; recovery blocks old handles and new primary login. Neither operation reenables membership or completes recovery. Provider revocation and local persistence are separate boundaries, with unconfirmed results explicitly requiring reconciliation.

AES-256-GCM envelopes authenticate algorithm, key version and complete identity binding. Explicit cloned keys, canonical bounded encodings, retained-key decryption, nonce misuse guards and generic errors are tested. CSRF uses domain-separated HMAC-SHA-256, canonical proofs, constant-time comparison and exact configured Origin. Rotation changes the proof binding; refresh retains it.

Configuration, caller inputs and port results are detached before later awaits. CAS retries are bounded. Refresh ownership prevents late completion from overwriting newer leases or terminal events; it does not extend idle/absolute/MFA recency. Business authorization commits activity and returns the resulting permit revision. Elevated actions require mutation CSRF. Concrete durability, shared limit enforcement and real-provider behavior remain separate responsibilities.

Tests include `tests/session-service.test.ts`, `security-primitives.test.ts`, `agent4-auth-session.test.ts` and `agent4-metadata-access.test.ts`. Synthetic fakes and local PGlite compositions are not production or real-Supabase acceptance. Owner-runtime concurrency, provider reuse, recovery preparation and deployment boundaries are described in the repository README.
