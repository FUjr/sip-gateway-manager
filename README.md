# SIP Gateway Manager

Authenticated, single-admin SIP management for Asterisk 22: device modem accounts,
external SIP clients, client groups, independent voice/SMS routes, and QModem JSON enrollment.
The Compose stack has exactly two containers: Asterisk plus FastAPI/SQLite, and a React/Nginx frontend.

## Start

1. Copy `.env.example` to `.env`. Generate independent random `ADMIN_PASSWORD` (16+ characters)
   and `AMI_SECRET` (24+ characters), for example with `openssl rand -hex 32`.
2. Put a trusted certificate and its private key in `certs/fullchain.pem` and `certs/privkey.pem`.
   Both WebUI and SIP TLS use this certificate. Protect `.env` and the private key with mode 0600.
3. Run `docker compose up -d --build`. Open `https://your-host:8443` and log in.
4. Set the public DNS hostname in Settings. Create a device and one device account per local modem.
   Create external client accounts and optionally client groups. Use unique numeric extensions.
5. Add separate inbound/outbound voice and SMS rules, then click **Apply to Asterisk**.
6. Export the device account's **Enrollment configuration**. On `voip_dev`, open the independent
   **SIP service** page, choose the actual local modem and network, paste/upload the JSON,
   preview, and apply. The device verifies the server certificate; its clock and CA trust must be correct.

Keep the public SIP TLS port and RTP range identical to the values in Settings and Compose.
Changing TLS/RTP settings requires a Compose restart and matching port mappings; account/routing
changes reload live. Validation and reload failures restore the previous PBX files.
Back up the named `gateway-data` volume securely; it contains SIP passwords and queued SMS.
Do not delete the volume during upgrades. Stop with `docker compose down` (without `-v`).

## Routing

A **device account** identifies one modem, not an entire router. Inbound rules select device sources
and client/group destinations. Outbound rules select client sources and a device destination.
SMS and voice have independent enabled flags and rules. Rules match exact numbers, prefixes, or any
number; lower priority runs first, ties sort by rule ID, and only the first matching rule runs.
No match rejects the request. Client-to-client numeric extensions support internal voice and SMS.
Voice groups ring eligible registered members in parallel; the first answer wins.
SMS groups create an independent durable delivery for every eligible member.

SMS acceptance (`202`) follows durable SQLite insertion. Delivery is recorded only after a final
SIP response, not the AMI action acknowledgement. Offline recipients retry independently, starting
at 30 seconds and capped at 5 minutes; registration wakes waiting deliveries. Default TTL is 7 days.
Bodies are erased when all targets finish or TTL expires; delivery metadata is retained 30 days.
Stable per-target delivery IDs let QModem's managed sender deduplicate cellular sends. Ordinary
external SIP clients may receive duplicates after a lost acknowledgement (at-least-once delivery).
Messages are UTF-8 text/plain, at most 4096 bytes. This is SIP MESSAGE routing, not SMS-over-IMS.

## Security and operation

Only HTTPS frontend, SIP TLS, and RTP are published. AMI binds to loopback; MESSAGE ingress and
completion callbacks use a private Unix socket. The WebUI uses an authenticated HttpOnly session,
CSRF checks, login throttling, and no public internal callback endpoints. This is a single-admin
service; all authenticated administrators can view exported device credentials.

Asterisk's image is pinned by digest and the matching module source archive by SHA-256.
Accounts use TLS, digest authentication, NAT contact rewriting and anchored RTP. External clients
must support SIP TLS and PCMA/PCMU. There is no built-in WebRTC softphone or automatic TLS issuer.
Health checks require both the backend and the custom Asterisk module.

## Validation

```sh
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/python -m pytest -q
cd frontend
npm ci
npm run build
npx playwright install chromium
npx playwright test
```

Browser tests use `.env` and the running disposable stack at `https://localhost:28443` by default;
set `WEB_TEST_URL` for another isolated stack. The real SIP test runs from the repository root:
`SIP_TEST_PORT=15061 WEB_TEST_URL=https://localhost:28443 .venv/bin/python tests/protocol.py`.
It requires a trusted test certificate for `sip.test` and creates test accounts/routes, so run it
only against a disposable stack. It covers TLS registration, digest authentication, internal/group
voice setup, bidirectional SMS, per-recipient offline recovery and stable-ID deduplication.

QModem target builds and service/import tests are separate from physical acceptance. Two real
modems with concurrent cellular calls, PCM traffic, AT/ADB recovery and SMS sends still require DUT
validation. No firmware flash or production deployment is performed by these tests.
