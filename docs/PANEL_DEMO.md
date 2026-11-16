# Major-project demonstration: encryption, Eve and network traffic

For the shortest explanation, start with [the simple **hi → ciphertext → hi**
exercise](SIMPLE_ENCRYPTION_DEMO.md), which uses real, inspectable learning keys.
The header entry is now **Encryption demo**. Select **Live chat** for the compact
actual-message view, or expand **Live activity & security details** for the detailed live path described below. This replaces the older
**Live security view** button/title without changing the chat protocol.

Use three distinct demonstrations: **real browser encryption**, **a simulated
BB84 interception experiment**, and **a capture of your own network traffic**.
They answer different questions. The application does not detect Wireshark,
perform physical quantum communication, or use the BB84 result as its chat key.

## Before the panel arrives

Use two Macs running the same updated project. Follow [LAN_SETUP.md](LAN_SETUP.md):
start Docker Desktop, run `./scripts/start_lan.sh` separately on each Mac, and
open `http://localhost:8080` on each. Create a new room on one Mac and share its
complete invitation. A short, manually chosen room name will not connect two
independently hosted Macs. Compare all 12 safety-code digits verbally, then mark
the current keys verified on both browsers.

This upgrade is prepared in `bb84-secure-chat-starter 6`; the earlier
`bb84-secure-chat-starter final` folder remains the preserved working copy.
Use the upgraded folder on both Macs when presenting its new views. A local
preview on port 8090 is for reviewing the interface; use the LAN launcher and
port 8080 on both Macs for this two-machine demonstration.

Prepare a harmless sentence such as **“Panel demo: the meeting starts at 10.”**
and a small image you are comfortable sharing. Use a fresh demonstration room
so that old conversations and personal filenames are not projected.

The network path is:

```text
Alice's browser → Alice's local backend
                         ↕ encrypted envelopes over the LAN
Bob's browser   → Bob's local backend
```

The creator's backend owns the room and stored ciphertext. Both browsers hold
their own private keys. Keep the creator Mac awake throughout the presentation.

## A seven-minute presentation

| Time | Show | Explain |
| --- | --- | --- |
| 0:00–1:00 | Both chat windows and matching safety codes | The browsers establish keys; people verify the current device keys by comparing the code. |
| 1:00–2:30 | **Live security view** and one message in each direction | These are real observations from this browser, not an animation of guessed delivery. |
| 2:30–4:00 | **BB84 lab**, then **Run without Eve** and **Run with Eve** | A classical simulation illustrates how measurement interference can introduce errors. |
| 4:00–6:00 | A short, filtered Wireshark capture or the DevTools fallback | The network carries encrypted message contents and visible routing metadata. |
| 6:00–7:00 | An encrypted image and the limitations | Files are encrypted locally too; the prototype has clear security boundaries. |

### 1. Show what really happens to a chat message

1. Open **Live security view** on Bob's Mac. The dialog is titled
   **See encryption happen**. Keep Alice's chat composer visible on her Mac.
2. Point out that connection, encryption and verification are separate states.
   An open connection alone does not establish encryption or verify a device.
3. Send the harmless sentence from Alice. On Bob's view, show the actual
   incoming encrypted envelope and the successful local authentication and
   decryption observation. The message contents remain in the chat; the
   presentation does not reveal private keys or secret values.
4. Open Alice's live view to review her recent send. Explain the difference
   between encryption, handing ciphertext to the socket, and the server's
   acknowledgement. **Server acceptance does not prove Bob decrypted it.**
   Bob's own view supplies the local decryption observation.
5. Reverse the roles and send a reply. Use **Clear observations** when you
   want a short timeline for the next example. Clearing observations does not
   erase chat history or reset keys.

The observations use the current browser's clock. They are not a synchronized
latency measurement, a network packet capture, or a cryptographic audit log.
Events may happen faster than a person can watch, so the bounded timeline keeps
the observed sequence available for explanation without slowing the encryption
or inventing intermediate work. Review a real event rather than claiming a
decorative moving icon is a packet travelling between the Macs.

Say:

> “Each browser keeps its private key. They exchange public keys, use ECDH to
> establish shared material, and use HKDF to derive separate AES keys for each
> direction. The sender encrypts before sending. The receiving browser checks
> integrity and decrypts. The server relays encrypted contents.”

### 2. Depict Eve with the BB84 experiment

Open **BB84 lab** and use the comparison controls. **Run without Eve** and
**Run with Eve** use the same classroom settings except for interception:

| Setting | Without Eve | With Eve |
| --- | --- | --- |
| Prepared transmissions | 1,024 | 1,024 |
| Teaching seed | 7 | 7 |
| Channel error | 0% | 0% |
| Interception | 0% | 100% |
| Sample checked | 25% of matching positions | 25% of matching positions |
| Acceptable error threshold | 11% | 11% |

The current Python simulation and post-processing functions were executed with
these settings on 13 November 2026. They produced these **actual preset results**:

| Measurement | Without Eve | With Eve |
| --- | --- | --- |
| Matching positions after basis comparison | 527 | 527 |
| Sample positions checked | 132 | 132 |
| Sample mismatches | 0 | 33 |
| Measured error rate | 0% | 25% |
| BB84 decision | Accepted | Aborted |
| Post-processing | Completed | Skipped |
| Privacy-amplified output length | 128 simulated bits | No output |

The clean run retained 395 candidate positions, disclosed 7 parity bits during
correction, and estimated 356 secret bits under this project's illustrative
model. Its 128-bit privacy-amplified output was expanded to a 256-bit
demonstration value and discarded. Expansion does not create extra entropy,
and this value never enters chat encryption.

Show Alice's and Bob's encoding choices using the returned, redacted
transmission examples. Step through the recorded examples at your own pace.
The backend returns one completed report; the review is not a live stream of
photons or separate per-stage server events. The comparison only fills in a
scenario after an actual result arrives.

Explain Eve as an **intercept-and-resend participant in the simulation**:
she measures using a randomly chosen method and sends the resulting modeled
state onward. A different method can disturb the information. Alice and Bob
discard different-basis positions, then check a sample of the remaining ones.
The observed 25% error rate in this preset exceeds the configured 11% limit,
so the experiment stops before key preparation.

Do not say “Eve is absent” after the clean result. Say **“The sampled error
level is within the configured limit.”** Noise can also produce errors, and a
finite sample is not proof that an observer is absent. The optional seed makes
this a repeatable teaching example: the seed and settings are public, so its
simulated secrets are reconstructible. These values are not suitable chat keys.

Most importantly: **passively recording ordinary network packets does not
trigger this simulated Eve or change its error rate.** Wireshark observation
and BB84 interception are separate demonstrations.

### 3. Show the encrypted traffic with Wireshark

Capture on one of the two participating Macs, with both participants' consent.
You are observing that Mac's own application traffic. A third laptop on the
same hotspot is not guaranteed to see other devices' packets; this demo does
not require Wi-Fi monitor mode, traffic redirection, or an active attack.

**Prepare capture access.** Install Wireshark from its official macOS package.
For packet capture, the official installation guide describes installing
**ChmodBPF** from the disk image, or via **Wireshark → About Wireshark → Folders
→ macOS Extras**. Run the Wireshark application normally; do not launch the
whole GUI as root. [Wireshark's macOS installation instructions](https://www.wireshark.org/docs/wsug_html_chunked/ChBuildInstallOSXInstall.html)

**Select the correct interface and limit the capture.** On the Mac running
Wireshark, find the route to the other Mac. The IP below is an example; replace
it with the other Mac's current private address:

```sh
route -n get 192.168.1.42
```

Use the interface shown in that output, often `en0` for Wi-Fi. In Wireshark's
capture options, choose that interface and enter this **capture filter**, again
replacing the example IP:

```text
tcp port 8080 and host 192.168.1.42
```

Capture filters restrict what is recorded. They use different syntax from the
display filter at the top of the main window. [Wireshark capture-filter guide](https://www.wireshark.org/docs/wsug_html_chunked/ChCapCaptureFilterSection.html)

1. Start capture **before** the second Mac joins a fresh room, so the HTTP
   upgrade and WebSocket setup are included. Open the normal localhost app;
   do not open the creator's plain LAN address as the browser chat page.
2. Send the harmless sentence, wait for its arrival, then send a reply.
3. Stop capture after this short exchange.
4. Apply this **display filter**:

   ```text
   tcp.port == 8080 && ip.addr == 192.168.1.42
   ```

5. Select the connection's WebSocket packet and use **Analyze → Follow →
   WebSocket Stream** when available. This lets Wireshark decode WebSocket
   framing. **Follow → TCP Stream** also shows the connection, but raw
   WebSocket framing and masking can make its application data hard to read.
   Following a stream opens a separate view; reopen it if you resume capturing
   and want newer data. [Wireshark stream-following guide](https://www.wireshark.org/docs/wsug_html_chunked/ChAdvFollowStreamSection.html)
6. If the connection is identified only as TCP, select a packet, use
   **Analyze → Decode As**, and set TCP port 8080 to HTTP. Retry with a fresh
   capture including the upgrade handshake if WebSocket still is not decoded.
   [Wireshark protocol decoding guide](https://www.wireshark.org/docs/wsug_html_chunked/ChCustProtocolDissectionSection.html)

Keep the capture small and scoped. Display filters hide rows; they do not
remove other recorded packets from a saved file. A capture can contain the
room invitation, names, addresses, public keys and timing. Keep the file
private instead of uploading a full capture to a public report.

**What to point at:**

| Visible in decoded traffic | What it means |
| --- | --- |
| Public-key advertisements | Public values used to establish keys; these are not private keys. |
| `encrypted_message`, `algorithm`, `iv`, `ciphertext` | A message envelope with AES-GCM encrypted contents. An IV is public input, not the AES key. |
| Room, sender, message identifiers and timestamps | Routing and timing metadata remain visible. |
| Message length and traffic volume | Encryption does not hide when people send data or its approximate size. |
| Attachment upload/download bodies | Encrypted file bytes; the file's secret descriptor travels inside an encrypted chat message. |

The harmless sentence should appear in the chat after decryption, but not as a
plaintext field in its decoded `encrypted_message` envelope. Inspect the
decoded WebSocket message; merely failing to find a word in raw masked bytes
does not demonstrate encryption. Base64url is an encoding for binary values,
and WebSocket masking is reversible framing. Its masking value is carried in
the frame; it is not the AES key. [WebSocket framing and masking specification](https://www.rfc-editor.org/rfc/rfc6455.html#section-5.3)
**AES-GCM is the content encryption.** The classroom LAN relay uses HTTP/WebSocket without TLS, so
public metadata and handshake information remain readable.

This inspection demonstrates the intended data boundary for the observed
exchange. It is not proof that every possible attack is prevented.

### DevTools fallback if capture setup takes too long

On either participating browser, open Chrome DevTools **before** joining the
room, choose **Network**, select **WS**, click the `/ws/...` connection, and
open **Messages**. Send a new harmless message and inspect the actual
`encrypted_message` JSON. Chrome shows the message data, length and time.
[Chrome's WebSocket inspection guide](https://developer.chrome.com/docs/devtools/network/reference#frames)

This is a browser-level view of the browser-to-local-server connection. Label
it as such; it does not capture the separate backend-to-backend LAN hop. It is
a useful fallback because the message was already AES-encrypted before the
browser handed it to WebSocket.

### Optional terminal capture

Wireshark is easier for presenting. If you prefer an on-demand terminal
capture on your own participant Mac, replace the example interface and peer IP
first, open a private working folder outside the project repository, then run
this command manually:

```sh
sudo tcpdump -i en0 -nn -s 0 -c 200 -w ./bb84-panel.pcap 'tcp port 8080 and host 192.168.1.42'
```

It stops after 200 matching packets; press **Control-C** to stop earlier. It
can wait indefinitely if there is no matching traffic, so stop it when the
short demo exchange is complete. Open the saved file in Wireshark normally.
The command asks for administrator permission for capture and writes packet
contents to a local file; no capture is started automatically by the app.
Check `man tcpdump` on your Mac for its installed options. The filter syntax
is documented in [libpcap's filter manual](https://www.tcpdump.org/manpages/pcap-filter.7.html).

### 4. Show an image without exposing its key

Use the paperclip, select your prepared image, review it and choose **Send
file**. On the second Mac, select **Open image**. Files up to 10 MB use a fresh
browser-generated AES-GCM key; the server stores opaque encrypted bytes. The
file key and other descriptor fields are carried inside an encrypted chat
message. Do not expand decrypted attachment descriptors in debugging tools.
See [ENCRYPTED_MEDIA.md](ENCRYPTED_MEDIA.md) for the exact lifecycle and limits.

## A 30-second explanation

> “Our project combines encrypted communication with a separate BB84 teaching
> experiment. Real chat encryption happens inside the browsers using ECDH,
> HKDF and AES-GCM. Our live view shows actual local encryption and decryption
> events, and the network capture shows encrypted contents with visible
> metadata. The BB84 lab illustrates how intercept-and-resend can introduce
> errors in a simulated exchange. We reject that experiment when its sample
> exceeds the chosen limit. This is a classical software demonstration, not
> physical quantum key distribution or quantum-secure chat.”

## Likely panel questions

| Question | Accurate answer |
| --- | --- |
| Is BB84 generating the AES chat keys? | No. Chat keys come from browser ECDH and HKDF. The separate BB84 simulation's output is discarded. |
| Does starting Wireshark make Eve appear? | No. Passive packet capture does not disturb this classical network or drive the BB84 simulation. Eve is an explicit experiment setting. |
| Can the backend read chat content? | In the intended honest-relay flow, it receives encrypted contents and public metadata, not private chat keys. Before safety-code verification, an active relay can substitute public keys. Compromised browsers or delivered application code can expose plaintext. |
| Does the backend know the BB84 bits? | Yes, temporarily: it runs both sides of the classical simulation. Seeded examples are also reconstructible from public inputs. This is why these simulated values do not become chat keys. |
| What does “verified” prove? | Someone compared the current full safety code through a trusted channel on that browser. It does not prove a person's legal identity or that a device is uncompromised. |
| Is low error proof that Eve is absent? | No. It means the measured sample was within the configured limit. Noise and finite sampling also matter. |
| Does a server acknowledgement mean the recipient decrypted? | No. It confirms server acceptance. Successful decryption is observed locally on the receiving browser. |
| Is this ready for production? | It is a classroom prototype. The LAN hop lacks TLS, metadata is visible, and the persistent key design has no forward secrecy or ratchet. It has not had an independent security audit. |

## If the live demonstration stalls

- **No partner appears:** use the complete LAN invitation, keep both Macs on
  the same reachable private network, and follow [LAN_SETUP.md](LAN_SETUP.md).
- **No packets appear:** check the selected interface and peer IP, start the
  capture before a new join, and confirm the filter uses capture syntax.
  Two tabs on one Mac mainly use localhost; use DevTools for that rehearsal.
- **Only TCP appears:** capture the initial handshake and use HTTP Decode As
  for port 8080. Do not call unreadable framing “encryption.”
- **Different experiment numbers:** check all six settings and teaching seed.
  If the seed is empty, fresh random runs can differ; explain the result
  actually displayed rather than promising a fixed number.
- **Device key changed or encryption failed:** explain the visible paused
  state and use the existing security flow. Do not bypass it to keep the demo
  moving or enable plaintext fallback.

The preset calculation above was executed against the source functions. A
physical two-Mac Wireshark capture is a presenter step, not a test claimed by
this document. Record your own rehearsal date and observed outcome separately.
