# Two locally hosted Macs on one hotspot

## How this mode works

Both computers run the complete Docker project and both users open
`http://localhost:8080` on their own Mac. The person who creates the room is
the room host. The full invitation code identifies that host to the joining
Mac, whose backend opens a bounded relay connection across the local network.

```text
Creator localhost browser -> creator backend -> creator ciphertext history
                                              ^
Joiner localhost browser  -> joiner backend ---+
```

There is no cloud service, public deployment, Bonjour discovery, or manual IP
entry. The creator Mac must remain running while the room is in use.

## Start both Macs

1. Put both Macs on the same trusted hotspot, Wi-Fi, or Ethernet network.
2. Start Docker Desktop on each Mac and wait until its engine is ready.
3. Open Terminal in the project folder on each Mac.
4. Run the following command on each Mac:

   ```sh
   chmod +x scripts/start_lan.sh
   ./scripts/start_lan.sh
   ```

5. Each person opens `http://localhost:8080` on her own computer.
6. One person selects **Create room**. Wait for the green LAN-ready message,
   enter a name, and choose **Create and enter**.
7. Copy the complete invitation code and send it to the other person.
8. The other person selects **Join room**, enters her name, pastes the complete
   code, and chooses **Join conversation**.
9. Wait for both browsers to show **Encrypted · Unverified**. Compare the full
   12-digit safety code through a separate trusted channel, then mark it
   verified on each browser.

Do not open `http://<creator-LAN-IP>:8080` as the chat page. Direct LAN HTTP is
not a supported Web Crypto context. Each participant keeps the browser on her
own `http://localhost:8080`; only the two backends use the LAN address.

A LAN invitation begins with `QKD-` and is 28 characters long. It includes a
16-character random room capability and a seven-character encoding of the
creator's private IPv4 address. The joining backend accepts only addresses in
`10.0.0.0/8`, `172.16.0.0/12`, or `192.168.0.0/16` and always uses port 8080.
Public, loopback, link-local, malformed, and CLAT translation addresses are
rejected.

Legacy short room codes still work between two tabs connected to the same
backend, but they do not connect two independently hosted Macs.

## What the launcher configures

The helper:

- detects the active private Wi-Fi or Ethernet IPv4 address;
- writes an untracked `.env.lan` without changing `.env`;
- sets `LAN_ADVERTISE_IP` so the UI can create a routed invitation;
- publishes port 8080 on the private network;
- keeps localhost and the selected LAN Origin in the allowlist;
- builds and starts Docker Compose; and
- verifies the local health endpoint before reporting ready.

If automatic detection chooses the wrong adapter, provide the address shown in
**System Settings > Network**:

```sh
./scripts/start_lan.sh --ip 192.168.1.42
```

Never supply a public address or an address belonging to another computer.

## Quick diagnosis

Run these checks in order.

1. On both Macs, confirm the local services are healthy:

   ```sh
   docker compose --env-file .env.lan ps
   curl http://127.0.0.1:8080/api/health
   curl http://127.0.0.1:8080/api/network
   ```

   The health response should report `"status":"ok"`. The network response
   should report `"mode":"lan"`, `"ready":true`, and that Mac's private IP.

2. On the creator Mac, note the `LAN diagnostic URL` printed by the launcher.
   On the joining Mac, test it directly. Replace the example with the printed
   address:

   ```sh
   curl http://192.168.1.42:8080/api/health
   ```

   This `curl` request is a backend reachability check. Do not open that LAN
   URL as the browser chat client.

3. If that request times out, the application cannot cross the hotspot:

   - confirm both Macs are connected to the exact same hotspot or SSID;
   - turn off VPNs temporarily if they change local routing;
   - avoid guest Wi-Fi and disable AP/client isolation on the hotspot;
   - allow incoming connections for Docker Desktop in macOS Firewall options;
   - confirm port 8080 is not used by another application; and
   - try a normal home router if the phone hotspot isolates its clients.

4. If the UI reports **Room host unavailable**, confirm the creator Mac and its
   Docker containers are still running. If its DHCP address changed, both Macs
   should rerun the launcher and the creator should make a new invitation.

5. View service errors when needed:

   ```sh
   docker compose --env-file .env.lan logs --tail=100 backend frontend
   ```

6. If macOS reports `getcwd: operation not permitted` or refuses to execute
   `scripts/start_lan.sh`, the terminal application does not have permission
   to read the folder containing the project. In **System Settings > Privacy &
   Security > Files and Folders**, allow Desktop or Downloads access for
   Terminal, iTerm or VS Code, then open a new terminal. Alternatively, move
   the extracted project to a user-created folder such as `~/Projects` and
   run the command there.

## If the Mac shows `192.0.0.2`

An address such as `192.0.0.2/32`, together with `CLAT46` or `NAT64`, indicates
an IPv6-only network. It is an outbound translation address, not an address the
other Mac can reach. The launcher intentionally refuses it.

Move both Macs to a network that gives each one a `10.x`, `192.168.x`, or
`172.16-31.x` address. Do not force `192.0.0.2` through `--ip`.

## Stop without deleting history

Run this on each Mac:

```sh
docker compose --env-file .env.lan down
```

This preserves the Docker volume. Do not add `-v` unless you intentionally want
to permanently delete that Mac's stored chat history.

## Security limitations

This is a Phase 4 classroom prototype. Each localhost browser uses P-256 ECDH,
HKDF-SHA-256 and AES-256-GCM, and the creator stores encrypted-message
ciphertext rather than plaintext. The invitation remains a room locator and
bearer capability. Display names and public keys are self-asserted. Before the
complete safety code is compared through a different trusted channel, an
active relay can substitute public keys and perform a man-in-the-middle
attack.

The backend-to-backend LAN hop does not use TLS. Message content is already
encrypted on that hop, but room, name, public-key, timing, presence and size
metadata remain visible. The persistent room/profile key design has no Noise
handshake, Double Ratchet, forward secrecy or post-compromise security. A
compromised Mac, browser, extension or local application code can read
plaintext.

The separate creator-hosted BB84/QBER and post-processing report remains a
classical teaching simulation. Temporary derived material is discarded and
never supplies, verifies or changes chat keys.

A teaching seed is included in the shared public result. A seeded run is
deterministic and reconstructible by anyone with the shared settings and
room/session context, so its simulated candidate and derived values are not
secret. A `key_material_exposed: false` metric means only that key bytes were
not serialized in the result.

- Use the mode only on a trusted private network.
- Share the invitation with only the intended partner.
- Compare all 12 safety-code digits outside this chat before treating the peer
  browser key as verified.
- Do not port-forward or publicly expose port 8080.
- Do not send confidential information.
- Stop both stacks after the demonstration.
