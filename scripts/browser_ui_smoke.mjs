import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const debuggingUrl = process.env.CHROME_DEBUG_URL || 'http://127.0.0.1:9225';
const secondaryDebuggingUrl = process.env.CHROME_DEBUG_URL_SECONDARY || debuggingUrl;
const appUrl = process.env.CHAT_BASE_URL || 'http://127.0.0.1:8080';
const artifactDir = resolve(process.env.UI_SMOKE_ARTIFACT_DIR || 'artifacts/ui-smoke');
const timeoutMs = 12_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Set();
    this.diagnostics = [];
    socket.addEventListener('message', (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.id) {
        const pending = this.pending.get(payload.id);
        if (!pending) return;
        this.pending.delete(payload.id);
        if (payload.error) pending.reject(new Error(payload.error.message));
        else pending.resolve(payload.result);
        return;
      }
      if (payload.method === 'Runtime.exceptionThrown') {
        this.diagnostics.push(`exception: ${payload.params.exceptionDetails.text}`);
      }
      if (payload.method === 'Runtime.consoleAPICalled'
        && ['error', 'warning'].includes(payload.params.type)) {
        const text = payload.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
        this.diagnostics.push(`${payload.params.type}: ${text}`);
      }
      for (const waiter of [...this.waiters]) {
        if (waiter.method !== payload.method) continue;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(payload.params);
      }
    });
  }

  static async connect(webSocketDebuggerUrl) {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolveConnection, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out')), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolveConnection();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP connection failed'));
      }, { once: true });
    });
    return new CdpSession(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCommand, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveCommand(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method) {
    return new Promise((resolveEvent, reject) => {
      const waiter = { method, resolve: resolveEvent, timer: undefined };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`CDP event timed out: ${method}`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async screenshot(filename) {
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
    });
    await writeFile(resolve(artifactDir, filename), Buffer.from(result.data, 'base64'));
  }

  close() {
    this.socket.close();
  }
}

async function createPage(width, height, browserDebuggingUrl = debuggingUrl) {
  const response = await fetch(`${browserDebuggingUrl}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
  });
  assert(response.ok, `Could not create Chrome target (${response.status})`);
  const target = await response.json();
  const page = await CdpSession.connect(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__labResults = [];
    window.__mediaUploads = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (init?.method === 'POST' && String(input).includes('/attachments/')) {
        const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        window.__mediaUploads.push({
          url: String(input), bytes: bytes.length,
          type: new Headers(init.headers).get('Content-Type'),
          digest: Array.from(new Uint8Array(digest)).join(',')
        });
      }
      return originalFetch(input, init);
    };
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = class extends OriginalWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (event) => {
          const value = JSON.parse(event.data);
          if (value.type === 'bb84_result') window.__labResults.push(value);
        });
      }
    };
  ` });
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 430,
  });
  const loaded = page.waitFor('Page.loadEventFired');
  await page.send('Page.navigate', { url: appUrl });
  await loaded;
  return page;
}

async function waitFor(page, expression, description) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await page.evaluate(expression)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function setInput(page, selector, value) {
  await page.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) throw new Error('Missing input: ' + ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value'
    ).set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
  })()`);
}

async function clickText(page, text) {
  await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent.trim().includes(${JSON.stringify(text)}));
    if (!button) throw new Error('Missing button: ' + ${JSON.stringify(text)});
    button.click();
  })()`);
}

async function enterRoom(page, name, room) {
  await clickText(page, 'Join room');
  await setInput(page, '#display-name', name);
  await setInput(page, '#room-code', room);
  await clickText(page, 'Join conversation');
  await waitFor(
    page,
    `document.querySelector('.conversation-title h1')?.textContent.includes(${JSON.stringify(room)}) === true`,
    `${name} to enter room`,
  );
}

async function chooseFixture(page, name, kind) {
  await page.evaluate(`(async () => {
    window.__mediaFixtures ??= {};
    let fixture = window.__mediaFixtures[${JSON.stringify(name)}];
    if (!fixture) {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d');
      const draw = (frame = 0) => {
        ctx.fillStyle = '#173f32'; ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = '#edf5f0'; ctx.font = 'bold 23px sans-serif';
        ctx.fillText('A private exchange.', 24, 65);
        ctx.font = '14px sans-serif'; ctx.fillText('BB84 major project · media demo', 24, 98);
        ctx.fillStyle = '#94bca5'; ctx.fillRect(24 + frame % 70, 125, 70, 5);
      };
      draw();
      let blob;
      if (${JSON.stringify(kind)} === 'image') {
        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      } else {
        const stream = canvas.captureStream(12);
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
        const recorder = new MediaRecorder(stream, { mimeType });
        const chunks = [];
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        blob = await new Promise((resolve, reject) => {
          recorder.onerror = () => reject(new Error('Test video recorder failed'));
          let frame = 0;
          const timer = setInterval(() => draw(frame += 8), 80);
          recorder.onstop = () => {
            clearInterval(timer); stream.getTracks().forEach(track => track.stop());
            resolve(new Blob(chunks, { type: 'video/webm' }));
          };
          recorder.start(100);
          setTimeout(() => recorder.stop(), 800);
        });
      }
      if (!blob?.size) throw new Error('Test media generation produced no bytes');
      const file = new File([blob], ${JSON.stringify(name)}, { type: ${JSON.stringify(kind)} === 'image' ? 'image/png' : 'video/webm' });
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      fixture = { file, digest: Array.from(new Uint8Array(digest)).join(',') };
      window.__mediaFixtures[${JSON.stringify(name)}] = fixture;
    }
    const transfer = new DataTransfer(); transfer.items.add(fixture.file);
    const input = document.querySelector('[aria-label="Choose image or video"]');
    if (!input || input.disabled) throw new Error('Attachment picker is unavailable');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(page, `document.querySelector('.file-review')?.textContent.includes(${JSON.stringify(name)})`, 'selected media preview');
}

async function openMedia(page, name, kind) {
  await waitFor(page, `[...document.querySelectorAll('.attachment-message')].some(el => el.textContent.includes(${JSON.stringify(name)}))`, 'encrypted attachment message');
  await page.evaluate(`(() => {
    const card = [...document.querySelectorAll('.attachment-message')].find(el => el.textContent.includes(${JSON.stringify(name)}));
    card.querySelector('button')?.click();
  })()`);
  await waitFor(page, `(() => {
    const card = [...document.querySelectorAll('.attachment-message')].find(el => el.textContent.includes(${JSON.stringify(name)}));
    const media = card?.querySelector(${JSON.stringify(kind === 'image' ? 'img' : 'video')});
    return media && ${kind === 'image' ? 'media.complete && media.naturalWidth === 320' : 'media.readyState >= 1 && media.videoWidth === 320'};
  })()`, `${kind} decoded after authenticated decryption`);
  if (kind === 'video') {
    await page.evaluate(`(async () => {
      const card = [...document.querySelectorAll('.attachment-message')].find(el => el.textContent.includes(${JSON.stringify(name)}));
      const video = card.querySelector('video'); video.muted = true; await video.play();
    })()`);
    await waitFor(page, `[...document.querySelectorAll('.attachment-message')].find(el => el.textContent.includes(${JSON.stringify(name)})).querySelector('video').currentTime > 0`, 'decrypted video playback');
    await page.evaluate(`[...document.querySelectorAll('.attachment-message')].find(el => el.textContent.includes(${JSON.stringify(name)})).querySelector('video').pause()`);
  }
}

await mkdir(artifactDir, { recursive: true });
const room = `UI-${String(Date.now()).slice(-10)}`;
const alice = await createPage(1440, 1000);
const bob = await createPage(1440, 1000, secondaryDebuggingUrl);

try {
  // Capture the stable visual state after the short entrance transition,
  // rather than an intermediate opacity frame.
  await alice.send('Page.bringToFront');
  await new Promise((resolveWait) => setTimeout(resolveWait, 650));
  const onboardingVisual = await alice.evaluate(`(() => {
    const story = document.querySelector('.onboarding-story__content');
    const card = document.querySelector('.onboarding-card');
    const title = document.querySelector('#welcome-title');
    const storyStyle = getComputedStyle(story);
    const cardStyle = getComputedStyle(card);
    return {
      storyOpacity: Number(storyStyle.opacity),
      cardOpacity: Number(cardStyle.opacity),
      storyAnimation: [storyStyle.animationName, storyStyle.animationDuration, storyStyle.animationDelay, storyStyle.animationFillMode, storyStyle.animationPlayState],
      cardAnimation: [cardStyle.animationName, cardStyle.animationDuration, cardStyle.animationDelay, cardStyle.animationFillMode, cardStyle.animationPlayState],
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      titleColor: getComputedStyle(title).color,
      titleWidth: title.getBoundingClientRect().width,
      cardWidth: card.getBoundingClientRect().width
    };
  })()`);
  assert(onboardingVisual.storyOpacity >= 0.99, `Onboarding story did not finish its entrance transition: ${JSON.stringify(onboardingVisual)}`);
  assert(onboardingVisual.cardOpacity >= 0.99, `Onboarding card did not finish its entrance transition: ${JSON.stringify(onboardingVisual)}`);
  assert(onboardingVisual.titleWidth > 100 && onboardingVisual.cardWidth > 300, 'Onboarding content is not visibly laid out');
  await alice.screenshot('01-onboarding-desktop.png');
  await bob.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await bob.screenshot('11-onboarding-mobile.png');
  for (const width of [320, 390, 768]) {
    await bob.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 500 });
    assert(await bob.evaluate(`document.documentElement.scrollWidth <= innerWidth`), `Welcome overflows at ${width}px`);
  }
  await bob.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await waitFor(bob, `!document.querySelector('.primary-button').disabled`, 'entry form ready');
  await bob.evaluate(`document.querySelector('.primary-button').click()`);
  await waitFor(bob, `document.activeElement.id === 'display-name' && document.activeElement.getAttribute('aria-invalid') === 'true'`, 'invalid field focus');
  await enterRoom(alice, 'Alice', room);
  await waitFor(alice, `Boolean(document.querySelector('.empty-state'))`, 'empty room');
  await alice.screenshot('12-empty-room-desktop.png');
  await enterRoom(bob, 'Bob', room);

  const encryptedReady = `document.querySelector('.encryption-badge')?.textContent.includes('Encrypted · Unverified') === true`;
  await Promise.all([
    waitFor(alice, encryptedReady, 'Alice encryption'),
    waitFor(bob, encryptedReady, 'Bob encryption'),
  ]);

  await setInput(alice, '#message-composer', 'This arrived through authenticated ciphertext.');
  await alice.evaluate(`document.querySelector('.send-button').click()`);
  await waitFor(
    bob,
    `document.querySelector('.message-list')?.textContent.includes('This arrived through authenticated ciphertext.') === true`,
    'Bob to decrypt Alice message',
  );

  await setInput(bob, '#message-composer', 'Reply decrypted on Bob’s partner browser.');
  await bob.evaluate(`document.querySelector('.send-button').click()`);
  await waitFor(
    alice,
    `document.querySelector('.message-list')?.textContent.includes('Reply decrypted on Bob’s partner browser.') === true`,
    'Alice to decrypt Bob message',
  );

  await alice.evaluate(`document.querySelector('.encryption-badge').click()`);
  await bob.evaluate(`document.querySelector('.encryption-badge').click()`);
  await Promise.all([
    waitFor(alice, `Boolean(document.querySelector('[aria-label="Safety code"]'))`, 'Alice safety code'),
    waitFor(bob, `Boolean(document.querySelector('[aria-label="Safety code"]'))`, 'Bob safety code'),
  ]);
  const aliceCode = await alice.evaluate(`document.querySelector('[aria-label="Safety code"]').textContent.trim()`);
  const bobCode = await bob.evaluate(`document.querySelector('[aria-label="Safety code"]').textContent.trim()`);
  assert(/^\d{4} \d{4} \d{4}$/.test(aliceCode), `Unexpected safety code format: ${aliceCode}`);
  assert(aliceCode === bobCode, 'The two visible safety codes did not match');
  const drawerCopy = await alice.evaluate(`document.querySelector('.security-panel').innerText`);
  assert(drawerCopy.includes('AES-256-GCM'), 'Security drawer omitted AES-256-GCM');
  assert(drawerCopy.includes('HKDF-SHA-256'), 'Security drawer omitted HKDF-SHA-256');
  assert(drawerCopy.includes('active relay could substitute browser keys'), 'Security drawer omitted the verification warning');
  await alice.screenshot('02-security-drawer-desktop.png');

  await alice.evaluate(`document.querySelector('.verification-check input').click()`);
  await clickText(alice, 'Codes match');
  await waitFor(
    alice,
    `document.querySelector('.encryption-badge')?.textContent.includes('Verified on this browser') === true`,
    'verified encryption badge',
  );
  await alice.evaluate(`document.querySelector('[aria-label="Close encryption details"]').click()`);
  await waitFor(alice, `getComputedStyle(document.querySelector('.encryption-badge')).backgroundColor === 'rgb(237, 245, 240)'`, 'verified status color');
  await alice.screenshot('03-encrypted-conversation-desktop.png');

  const desktopLayout = await alice.evaluate(`({
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    composerEnabled: !document.querySelector('#message-composer').disabled,
    status: document.querySelector('.encryption-badge').textContent.trim(),
    relayAck: document.querySelector('.message-meta')?.textContent.includes('Accepted for encrypted relay') === true,
    ownBubbleColor: getComputedStyle(document.querySelector('.message-row--mine .message-bubble')).color,
    ownBubbleBackground: getComputedStyle(document.querySelector('.message-row--mine .message-bubble')).backgroundColor
  })`);
  assert(desktopLayout.documentWidth <= desktopLayout.viewport, 'Desktop page has horizontal overflow');
  assert(desktopLayout.composerEnabled, 'Desktop composer is disabled after encryption setup');
  assert(desktopLayout.relayAck, 'Relay acknowledgement copy was not visible');
  assert(desktopLayout.ownBubbleColor === 'rgb(255, 255, 255)', 'Own-message text is not white');
  assert(desktopLayout.ownBubbleBackground === 'rgb(40, 95, 71)', 'Own-message background is not the readable green surface');

  await bob.evaluate(`document.querySelector('[aria-label="Close encryption details"]').click()`);
  await bob.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  const mobileLayout = await bob.evaluate(`({
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    composerVisible: Boolean(document.querySelector('#message-composer')),
    badgeVisible: Boolean(document.querySelector('.encryption-badge'))
  })`);
  assert(mobileLayout.documentWidth <= mobileLayout.viewport, 'Mobile page has horizontal overflow');
  assert(mobileLayout.composerVisible && mobileLayout.badgeVisible, 'Mobile chat controls are missing');
  assert(await bob.evaluate(`['.protocol-lab-trigger span', '.connection-badge span'].every(selector => { const el = document.querySelector(selector); const style = getComputedStyle(el); return el.getBoundingClientRect().width > 15 && style.clipPath === 'none' && style.visibility === 'visible'; })`), 'Mobile lab or connection label is hidden');
  for (const width of [320, 390]) {
    await bob.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    assert(await bob.evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.conversation-header').scrollWidth <= innerWidth`), `Chat header overflows at ${width}px`);
  }
  await bob.screenshot('04-encrypted-conversation-mobile.png');
  await setInput(bob, '#message-composer', 'A longer draft stays readable.\nSecond line.\nThird line.\nFourth line.\nFifth line.\nSixth line.\nSeventh line.');
  await waitFor(bob, `document.querySelector('#message-composer').getBoundingClientRect().height >= 140`, 'expanding composer');
  assert(await bob.evaluate(`document.querySelector('#message-composer').getBoundingClientRect().height <= 160`), 'Composer exceeded its bounded height');
  await bob.screenshot('13-multiline-composer-mobile.png');
  await setInput(bob, '#message-composer', '');
  await waitFor(bob, `document.querySelector('#message-composer').getBoundingClientRect().height <= 50`, 'composer shrinking after clearing');
  await bob.evaluate(`document.querySelector('[aria-label="Open room details"]').click()`);
  await waitFor(bob, `document.querySelector('.chat-sidebar').classList.contains('is-open')`, 'mobile room menu');
  await bob.evaluate(`document.querySelector('.sidebar-lab').click()`);
  await waitFor(bob, `Boolean(document.querySelector('.protocol-lab'))`, 'sidebar lab entry');
  await bob.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await bob.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await waitFor(bob, `!document.querySelector('.protocol-lab') && document.activeElement.classList.contains('protocol-lab-trigger')`, 'lab return to visible mobile trigger');
  await bob.evaluate(`document.querySelector('.encryption-badge').click()`);
  await waitFor(bob, `Boolean(document.querySelector('.security-panel'))`, 'mobile security drawer');
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  const mobileDrawer = await bob.evaluate(`({
    viewport: innerWidth,
    panelWidth: document.querySelector('.security-panel').getBoundingClientRect().width,
    documentWidth: document.documentElement.scrollWidth
  })`);
  assert(mobileDrawer.panelWidth <= mobileDrawer.viewport, 'Mobile security drawer exceeds viewport');
  assert(mobileDrawer.documentWidth <= mobileDrawer.viewport, 'Mobile drawer causes horizontal overflow');
  await bob.screenshot('05-security-drawer-mobile.png');

  await bob.evaluate(`document.querySelector('[aria-label="Close encryption details"]').click()`);

  // Reload keeps the non-extractable IndexedDB identity and decryptable history.
  const reloaded = alice.waitFor('Page.loadEventFired');
  await alice.send('Page.reload');
  await reloaded;
  await enterRoom(alice, 'Alice', room);
  await waitFor(alice, `document.querySelector('.encryption-badge')?.textContent.includes('Verified on this browser')`, 'verification after refresh');
  await waitFor(alice, `document.querySelector('.message-list')?.textContent.includes('Reply decrypted on Bob’s partner browser.')`, 'decrypted history after refresh');
  await alice.evaluate(`document.querySelector('.encryption-badge').click()`);
  assert(await alice.evaluate(`document.querySelector('[aria-label="Safety code"]').textContent.trim()`) === aliceCode, 'Refresh changed the persisted identity');
  await alice.evaluate(`document.querySelector('[aria-label="Close encryption details"]').click()`);

  for (const page of [alice, bob]) await page.evaluate(`document.querySelector('[aria-label="Open BB84 Security Lab"]').click()`);
  await waitFor(alice, `Number(getComputedStyle(document.querySelector('.protocol-lab')).opacity) >= 0.99`, 'lab entrance transition');
  await alice.screenshot('09-bb84-overview-desktop.png');
  await alice.evaluate(`document.querySelector('#bb84-qubits').value = '1024'; document.querySelector('#bb84-qubits').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('.lab-advanced-settings').open = true;`);
  await setInput(alice, '#bb84-seed', '7');
  await clickText(alice, 'Start BB84 Experiment');
  await Promise.all([alice, bob].map((page) => waitFor(page, `document.querySelector('.lab-outcome')?.textContent.includes('Experiment completed')`, 'completed BB84 result')));
  const successfulRun = await alice.evaluate(`window.__labResults.at(-1)`);
  assert(successfulRun.post_processing.status === 'completed', 'The actual backend run did not complete');
  assert(await bob.evaluate(`window.__labResults.at(-1).session_id`) === successfulRun.session_id, 'Browsers received different BB84 sessions');
  assert(await alice.evaluate(`document.querySelector('.lab-protection').textContent.includes('Not connected')`), 'Lab falsely claimed a key contribution');
  assert(await alice.evaluate(`!document.querySelector('.lab-technical-report').open`), 'Technical details should start collapsed');

  // Check every stage against the actual returned report, never test animations with invented values.
  await clickText(alice, 'Show all steps');
  const actualMetrics = await alice.evaluate(`Object.fromEntries([...document.querySelectorAll('.lab-simple-metrics > div')].map(el => [el.querySelector('dt').textContent, el.querySelector('dd').textContent]))`);
  const expectedMetrics = {
    'Bits prepared': successfulRun.metrics.transmitted,
    'Matching positions': successfulRun.metrics.sifted,
    'Discarded positions': successfulRun.metrics.transmitted - successfulRun.metrics.sifted,
    'Candidates after sample removal': successfulRun.metrics.retained,
    'Sample bits checked': successfulRun.metrics.sample,
    'Mismatches': successfulRun.metrics.mismatches,
    'Errors corrected': successfulRun.post_processing.reconciliation.corrected_errors,
    'Remaining errors': successfulRun.post_processing.reconciliation.remaining_errors,
  };
  for (const [label, value] of Object.entries(expectedMetrics)) assert(actualMetrics[label] === String(value), `Incorrect walkthrough metric: ${label}`);
  assert(actualMetrics['Final simulated key length'] === `${successfulRun.post_processing.privacy_amplification.output_bits} bits`, 'Wrong final simulated key length');
  await clickText(alice, 'Show one step');
  await alice.evaluate(`document.querySelector('[aria-label^="Step 5:"]').click(); document.querySelector('.lab-walkthrough').scrollIntoView({ block: 'start' })`);
  await alice.screenshot('06-bb84-walkthrough-desktop.png');

  // Modal keyboard cycle skips the hidden controls inside both disclosures.
  await alice.evaluate(`document.querySelector('.lab-advanced-settings').open = false; document.querySelector('[aria-label="Close protocol lab"]').focus()`);
  await alice.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 8 });
  await alice.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', modifiers: 8 });
  assert(await alice.evaluate(`document.activeElement === document.querySelector('.lab-technical-report > summary')`), 'Focus entered a closed disclosure');
  await alice.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' });
  await alice.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' });
  assert(await alice.evaluate(`document.activeElement.getAttribute('aria-label') === 'Close protocol lab'`), 'Modal focus escaped');

  await bob.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await bob.evaluate(`document.querySelector('[aria-label^="Step 3:"]').click(); document.querySelector('.lab-walkthrough').scrollIntoView({ block: 'start' })`);
  const labMobile = await bob.evaluate(`({ viewport: innerWidth, panel: document.querySelector('.protocol-lab').getBoundingClientRect().width, body: document.querySelector('.protocol-lab__body').scrollWidth, client: document.querySelector('.protocol-lab__body').clientWidth })`);
  assert(labMobile.panel <= labMobile.viewport && labMobile.body <= labMobile.client, 'Mobile BB84 lab overflows');
  await bob.screenshot('07-bb84-walkthrough-mobile.png');
  await bob.evaluate(`document.querySelector('.lab-technical-report').open = true; document.querySelector('.lab-technical-report').scrollIntoView({ block: 'start' })`);
  assert(await bob.evaluate(`document.querySelector('.protocol-lab__body').scrollWidth <= document.querySelector('.protocol-lab__body').clientWidth`), 'Technical details cause mobile overflow');

  await bob.screenshot('10-bb84-technical-mobile.png');

  await setInput(alice, '#bb84-intercept', '100');
  await clickText(alice, 'Run another experiment');
  await waitFor(alice, `document.querySelector('.lab-outcome')?.textContent.includes('error level was too high')`, 'high-error rejection');
  const rejectedRun = await alice.evaluate(`window.__labResults.at(-1)`);
  assert(rejectedRun.decision.status === 'aborted', 'High-error run did not abort');
  assert(rejectedRun.post_processing.status === 'skipped', 'Rejected run executed post-processing');
  await alice.evaluate(`document.querySelector('.lab-walkthrough').scrollIntoView({ block: 'start' })`);
  await alice.screenshot('08-bb84-rejected-desktop.png');

  await setInput(alice, '#bb84-intercept', '0');
  await alice.evaluate(`document.querySelector('#bb84-qubits').value = '128'; document.querySelector('#bb84-qubits').dispatchEvent(new Event('change', { bubbles: true }))`);
  await clickText(alice, 'Run another experiment');
  await waitFor(alice, `document.querySelector('.lab-outcome')?.textContent.includes('too little estimated secret information')`, 'insufficient entropy result');
  assert(await alice.evaluate(`window.__labResults.at(-1).decision.status`) === 'accepted', 'Small clean sample did not pass its separate error check');

  for (const page of [alice, bob]) await page.evaluate(`document.querySelector('[aria-label="Close protocol lab"]').click()`);
  await setInput(alice, '#message-composer', 'Chat still works after all three BB84 outcomes.');
  await alice.evaluate(`document.querySelector('.send-button').click()`);
  await waitFor(bob, `document.querySelector('.message-list')?.textContent.includes('Chat still works after all three BB84 outcomes.')`, 'chat after lab runs');
  const history = await (await fetch(`${appUrl}/api/rooms/${room}/messages`)).json();
  assert(history.messages.every((message) => message.kind === 'encrypted_message' && !('text' in message)), 'History exposed plaintext');

  // Generate actual media locally and drive the normal picker/preview/send controls.
  // The test fetch wrapper retains only size/digest information, never file keys.
  await alice.send('Page.bringToFront');
  for (const [name, mime, size, errorText] of [
    ['unsupported.html', 'text/html', 20, 'Choose a JPEG'],
    ['oversized.png', 'image/png', 10 * 1024 * 1024 + 1, 'up to 10 MB'],
  ]) {
    await alice.evaluate(`(() => {
      const input = document.querySelector('[aria-label="Choose image or video"]');
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(${size})], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(alice, `document.querySelector('.file-error')?.textContent.includes(${JSON.stringify(errorText)})`, 'attachment validation');
    assert(await alice.evaluate(`window.__mediaUploads.length === 0 && !document.querySelector('.file-review')`), 'Rejected file reached upload');
  }
  const imageName = 'mentor-demo-image.png';
  const videoName = 'mentor-demo-video.webm';
  await chooseFixture(alice, imageName, 'image');
  await clickText(alice, 'Remove file');
  assert(await alice.evaluate(`window.__mediaUploads.length === 0 && !document.querySelector('.file-review')`), 'Removing preview uploaded the file');
  // Emulate a partner without media support: no acknowledgement means no upload.
  await bob.evaluate(`window.__originalMediaSend = WebSocket.prototype.send; WebSocket.prototype.send = function(data) { if (JSON.parse(data).type !== 'encrypted_message') return window.__originalMediaSend.call(this, data); };`);
  await chooseFixture(alice, imageName, 'image');
  await clickText(alice, 'Send file');
  await waitFor(alice, `document.querySelector('.file-error')?.textContent.includes('updated app')`, 'unsupported partner guard');
  assert(await alice.evaluate(`window.__mediaUploads.length === 0`), 'File uploaded before authenticated media support');
  await bob.evaluate(`WebSocket.prototype.send = window.__originalMediaSend; delete window.__originalMediaSend;`);
  await clickText(alice, 'Remove file');
  await chooseFixture(alice, imageName, 'image');
  await clickText(alice, 'Send file');
  await openMedia(bob, imageName, 'image');
  for (const page of [alice, bob]) assert(await page.evaluate(`!document.querySelector('.message-list').textContent.includes('QKD-MEDIA-CONTROL-V1:')`), 'Capability controls leaked into the chat UI');

  await bob.send('Page.bringToFront');
  await chooseFixture(bob, videoName, 'video');
  await clickText(bob, 'Send file');
  await openMedia(alice, videoName, 'video');
  await openMedia(alice, imageName, 'image');
  await openMedia(bob, videoName, 'video');

  for (const [page, name] of [[alice, imageName], [bob, videoName]]) {
    const uploadEvidence = await page.evaluate(`(() => {
      const fixture = window.__mediaFixtures[${JSON.stringify(name)}];
      const uploads = window.__mediaUploads;
      return uploads.length === 1 && uploads[0].type === 'application/octet-stream'
        && uploads[0].bytes === fixture.file.size + 16 && uploads[0].digest !== fixture.digest
        && !uploads[0].url.includes(${JSON.stringify(name)});
    })()`);
    assert(uploadEvidence, 'Attachment HTTP upload was not an opaque authenticated ciphertext body');
    assert(await page.evaluate(`!document.querySelector('.message-list').textContent.includes('QKD-ATTACHMENT-V1:')`), 'A private attachment manifest was rendered');
  }
  const mediaHistory = await (await fetch(`${appUrl}/api/rooms/${room}/messages`)).json();
  const publicHistory = JSON.stringify(mediaHistory);
  assert(mediaHistory.messages.every(message => message.kind === 'encrypted_message' && !('text' in message)), 'Media history contained plaintext');
  assert(!publicHistory.includes(imageName) && !publicHistory.includes(videoName) && !publicHistory.includes('QKD-ATTACHMENT-V1:'), 'Media metadata escaped the encrypted message envelope');
  await alice.evaluate(`document.querySelector('.message-list').scrollTop = document.querySelector('.message-list').scrollHeight`);
  await alice.screenshot('14-media-desktop.png');
  await bob.evaluate(`document.querySelector('.message-list').scrollTop = document.querySelector('.message-list').scrollHeight`);
  assert(await bob.evaluate(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.attachment-message')].every(card => card.scrollWidth <= card.clientWidth)`), 'Mobile attachments overflow');
  await bob.screenshot('15-media-mobile.png');

  await alice.evaluate(`document.querySelector('.encryption-story > summary').click()`);
  assert(await alice.evaluate(`document.querySelector('.encryption-story').open && document.querySelector('.encryption-story').textContent.includes('Sample passed · final key preparation failed')`), 'Encryption explanation lost the actual BB84 result');
  assert(await alice.evaluate(`document.querySelector('.encryption-story').textContent.includes('not used for chat encryption')`), 'Encryption explanation falsely connects the simulation');
  await alice.screenshot('16-encryption-story-desktop.png');
  await alice.evaluate(`document.querySelector('.encryption-story > summary').click()`);
  await bob.evaluate(`document.querySelector('.encryption-story > summary').click()`);
  assert(await bob.evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.encryption-story__body').scrollWidth <= document.querySelector('.encryption-story__body').clientWidth`), 'Mobile encryption explanation overflows');
  await bob.screenshot('17-encryption-story-mobile.png');
  await bob.evaluate(`document.querySelector('.encryption-story > summary').click()`);

  const mediaReloaded = alice.waitFor('Page.loadEventFired');
  await alice.send('Page.reload');
  await mediaReloaded;
  await enterRoom(alice, 'Alice', room);
  await waitFor(alice, `document.querySelector('.encryption-badge')?.textContent.includes('Verified on this browser')`, 'verification after media refresh');
  await openMedia(alice, imageName, 'image');
  await openMedia(alice, videoName, 'video');

  // Losing Bob's persistent identity must pause Alice, not silently accept a new key.
  await bob.evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('qkd-chat-e2ee', 1);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('room-identities', 'readwrite');
      transaction.objectStore('room-identities').delete(${JSON.stringify(`e2ee-v1:${room}:bob`)});
      transaction.oncomplete = () => { db.close(); resolve(true); };
      transaction.onerror = reject;
    };
    request.onerror = reject;
  })`);
  const bobReloaded = bob.waitFor('Page.loadEventFired');
  await bob.send('Page.reload');
  await bobReloaded;
  await enterRoom(bob, 'Bob', room);
  await waitFor(alice, `document.querySelector('.encryption-badge')?.textContent.includes('Device key changed')`, 'key change detection');
  assert(await alice.evaluate(`document.querySelector('#message-composer').disabled`), 'Key change did not pause sending');

  assert(alice.diagnostics.length === 0, `Alice console diagnostics: ${alice.diagnostics.join(' | ')}`);
  assert(bob.diagnostics.length === 0, `Bob console diagnostics: ${bob.diagnostics.join(' | ')}`);

  const report = {
    status: 'PASS',
    room,
    refreshAndHistory: 'PASS',
    keyChangeDetection: 'PASS',
    bb84Walkthrough: 'PASS',
    bb84RejectedAndInsufficient: 'PASS',
    ciphertextOnlyHistory: 'PASS',
    entryValidationAndResponsiveLayout: 'PASS',
    multilineComposer: 'PASS',
    mobileSidebarLabNavigation: 'PASS',
    encryptedImageAndVideo: 'PASS',
    authenticatedMediaCapability: 'PASS',
    attachmentValidationAndCancel: 'PASS',
    opaqueAttachmentUploads: 'PASS',
    attachmentHistoryRecovery: 'PASS',
    encryptionExplanation: 'PASS',
    labMobile,
    independentBrowserProfiles: secondaryDebuggingUrl !== debuggingUrl,
    onboarding: onboardingVisual,
    desktop: desktopLayout,
    mobile: mobileLayout,
    screenshots: [
      '01-onboarding-desktop.png',
      '02-security-drawer-desktop.png',
      '03-encrypted-conversation-desktop.png',
      '04-encrypted-conversation-mobile.png',
      '05-security-drawer-mobile.png',
      '06-bb84-walkthrough-desktop.png',
      '07-bb84-walkthrough-mobile.png',
      '08-bb84-rejected-desktop.png',
      '09-bb84-overview-desktop.png',
      '10-bb84-technical-mobile.png',
      '11-onboarding-mobile.png',
      '12-empty-room-desktop.png',
      '13-multiline-composer-mobile.png',
      '14-media-desktop.png',
      '15-media-mobile.png',
      '16-encryption-story-desktop.png',
      '17-encryption-story-mobile.png',
    ].map((name) => resolve(artifactDir, name)),
  };
  await writeFile(resolve(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  alice.close();
  bob.close();
}
