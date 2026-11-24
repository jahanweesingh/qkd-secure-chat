# Troubleshooting

This page collects operational guidance from the project README. Start with the
[testing guide](TESTING.md), [LAN setup](LAN_SETUP.md), or
[Render hosting guide](FREE_HOSTING.md) for complete procedures.

## Docker cannot connect

Start Docker Desktop (or the Docker-compatible engine) and wait until it reports
that it is ready, then retry the command.

## Port 8080 is already in use

Set `APP_PORT=8090` in `.env` and add the matching origin
(`http://localhost:8090`) to `ALLOWED_ORIGINS`.

## The room is full

A room supports two distinct live client IDs. Create another room or close one
participant's tab.

## The second Mac cannot connect

Both participants should run their own local app and open
`http://localhost:8080` in their own browser. Confirm both LAN launchers are
running, paste the complete invitation code, and follow the hotspot and firewall
checks in [LAN setup](LAN_SETUP.md).

Do not open `http://<creator-LAN-IP>:8080` as the browser chat page. Web Crypto
requires a secure context. Each participant opens their own localhost page; the
joining backend relays to the creator backend over the LAN.

## Encryption is waiting

Both participants must be connected, and each browser must advertise its
current public key. Keep both tabs open, reconnect if needed, then retry.

## The peer key changed

Sending is paused intentionally. Compare the newly displayed safety code
through a separate trusted channel before verifying and sending again.

## A repeated AES-GCM IV was rejected

Sending remains paused. Retry encryption to rotate this browser's room/profile
identity, then compare and verify the replacement safety code before resuming.

## The key is session-only

IndexedDB was unavailable. The key lasts only for that browser tab; a refresh or
closed session changes the identity and may make earlier ciphertext
undecryptable.

## Messages remain after restart

This is expected when using the local named Docker volume. Encrypted message
bodies remain ciphertext in the database.

## Reset local data

`docker compose down -v` permanently removes the local chat database. It does
not clear browser IndexedDB or local verification records. Clear site data
separately only if you intend to rotate the browser identity.
