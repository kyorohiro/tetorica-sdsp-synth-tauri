(() => {
  'use strict';
  const local = (location.protocol === 'tauri:' && location.hostname === 'localhost') ||
    (['http:', 'https:'].includes(location.protocol) && location.hostname === 'tauri.localhost');
  if (window.top !== window || !local || typeof window.__TAURI_INTERNALS__?.invoke !== 'function') return;
  const invoke = (command, args = {}) => window.__TAURI_INTERNALS__.invoke(command, args);
  const status = text => {const element = document.getElementById('audioStatus'); if (element) element.textContent = text;};
  const MAX_EXPORT_BYTES = 128 * 1024 * 1024, MAX_EXPORT_HEADER_BYTES = 4 * 1024;
  async function saveExport(blob, filename) {
    if (blob.size > MAX_EXPORT_BYTES) throw new Error('Export exceeds 128 MiB');
    const header = new TextEncoder().encode(JSON.stringify({filename}));
    if (!header.byteLength || header.byteLength > MAX_EXPORT_HEADER_BYTES) throw new Error('Export header exceeds 4096 bytes');
    const bytes = await blob.arrayBuffer();
    if (bytes.byteLength > MAX_EXPORT_BYTES) throw new Error('Export exceeds 128 MiB');
    const packet = new Uint8Array(4 + header.byteLength + bytes.byteLength);
    new DataView(packet.buffer).setUint32(0, header.byteLength, true);
    packet.set(header, 4);
    packet.set(new Uint8Array(bytes), 4 + header.byteLength);
    return invoke('save_export_binary', packet.buffer);
  }
  const blobs = new Map();
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => {const url = create(blob); blobs.set(url, blob); return url;};
  URL.revokeObjectURL = url => {blobs.delete(url); return revoke(url);};
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const blob = blobs.get(this.href);
    if (!this.download || !blob) return click.call(this);
    // Hold the Blob before the Synth immediately revokes its temporary URL.
    const filename = this.download;
    void saveExport(blob, filename)
      .then(path => status(path ? `Saved ${path}` : 'Save cancelled.'))
      .catch(error => status(`Could not save: ${String(error)}`));
  };
  function confirmReload() {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.style.cssText = 'padding:24px;border:1px solid #9ca7b0;border-radius:12px;background:#e0e3e6;color:#30353c;font:16px system-ui';
      const message = document.createElement('p');
      message.textContent = 'Reload Synth? Playback and unsaved instrument changes will be cleared. Save a preset before reloading to keep the instrument.';
      const cancel = document.createElement('button'), confirm = document.createElement('button');
      cancel.textContent = 'Cancel'; confirm.textContent = 'Reload';
      cancel.addEventListener('click', () => dialog.close('cancel'));
      confirm.addEventListener('click', () => dialog.close('reload'));
      dialog.addEventListener('close', () => {const accepted = dialog.returnValue === 'reload'; dialog.remove(); resolve(accepted);}, {once:true});
      dialog.append(message, cancel, confirm); document.body.append(dialog); dialog.showModal(); cancel.focus();
    });
  }
  // The packaged browser assets stay unchanged. Add the same desktop toolbar
  // used by FM2612 / SPU, using the S-DSP app's palette.
  function ensureToolbarHost() {
    if (document.getElementById('synthDesktopTools')) return;
    const title = document.querySelector('.title-row');
    if (!title) return;
    const host = document.createElement('div'); host.id = 'synthDesktopTools';
    const pin = document.createElement('button');
    pin.id = 'synthPinButton'; pin.type = 'button'; pin.hidden = true;
    const audio = document.createElement('div'); audio.id = 'synthMenuAudio';
    const reload = document.createElement('button');
    reload.type = 'button'; reload.dataset.resetOfflineCache = ''; reload.textContent = 'Reload';
    host.append(audio, reload, pin); title.append(host);
  }
  function mountToolbar() {
    const host = document.getElementById('synthDesktopTools');
    if (!host || host.dataset.toolbarMounted) return;
    const identity = document.querySelector('.product-identity');
    const pin = document.getElementById('synthPinButton');
    const audio = document.getElementById('synthMenuAudio');
    const reload = host.querySelector('[data-reset-offline-cache]');
    const load = document.getElementById('loadPreset'), save = document.getElementById('savePreset');
    const presetInput = document.getElementById('presetFileInput');
    if (!identity || !pin || !audio || !reload || !load || !save || !presetInput) return;
    host.dataset.toolbarMounted = 'true';
    const style = document.createElement('style');
    style.textContent = `
      .synth-title-group { display:flex; align-items:center; flex-wrap:wrap; gap:12px; flex:1; min-width:0; }
      .synth-title-group .product-identity { flex:1 1 260px; }
      #synthDesktopTools { display:flex; align-items:center; gap:6px; position:relative; flex-shrink:0; }
      .synth-menu { position:relative; }
      .synth-icon-button { display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; min-height:36px; padding:0; border:1px solid var(--line); border-radius:50%; background:var(--panel); color:var(--accent-dark); cursor:pointer; list-style:none; box-shadow:none; }
      .synth-icon-button::-webkit-details-marker { display:none; }
      .synth-icon-button svg { width:19px; height:19px; }
      .synth-icon-button:hover, .synth-icon-button.is-selected { background:#e4eff8; border-color:var(--accent); color:var(--accent); }
      .synth-icon-button.is-selected .pin-head { fill:var(--accent); }
      .synth-icon-button:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
      .synth-menu-panel { position:absolute; top:calc(100% + 8px); left:0; z-index:30; width:min(320px, calc(100vw - 52px)); max-height:min(70vh, 520px); overflow-y:auto; box-sizing:border-box; padding:14px; border:1px solid var(--line); border-radius:14px; background:var(--panel); box-shadow:0 12px 32px #30353b50; }
      .synth-menu-section + .synth-menu-section { margin-top:12px; padding-top:12px; border-top:1px solid var(--line); }
      .synth-menu-section h2 { margin:0 0 8px; color:var(--muted); font-size:.72rem; }
      .synth-menu-actions { display:grid; gap:6px; }
      .synth-menu-actions .toolbar-button { text-align:left; padding:8px 10px; min-height:32px; }
    `;
    document.head.append(style);
    const menu = document.createElement('details');
    menu.id = 'synthMenu'; menu.className = 'synth-menu';
    menu.innerHTML = `<summary id="synthMenuButton" class="synth-icon-button" aria-label="Menu" title="Menu" aria-expanded="false" aria-controls="synthMenuPanel">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
      </summary><div id="synthMenuPanel" class="synth-menu-panel"></div>`;
    pin.classList.add('synth-icon-button');
    pin.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path class="pin-head" d="M9 3h6v5l3 5v2H6v-2l3-5z"/><path d="M12 15v7"/></svg>';
    const panel = menu.querySelector('.synth-menu-panel');
    function section(title, control, label) {
      const section = document.createElement('section'); section.className = 'synth-menu-section synth-menu-actions';
      if (title) { const heading = document.createElement('h2'); heading.textContent = title; section.append(heading); }
      if (control) {
        control.classList.add('toolbar-button'); control.dataset.closeSynthMenu = '';
        if (label) control.textContent = label;
        section.append(control);
      }
      panel.append(section); return section;
    }
    const imports = section('Import', load, 'Instrument · S-DSP preset…'); imports.append(presetInput);
    for (const [id, originalId, cardId, label] of [
      ['synthMenuSpc', 'loadSpc', 'spcSection', 'Sounds · SPC snapshot…'],
      ['synthMenuAudioImport', 'loadAudio', 'sampleSection', 'Selected sample · Audio file…'],
      ['synthMenuBrrImport', 'loadBrr', 'sampleSection', 'Selected sample · BRR file…'],
    ]) {
      const original = document.getElementById(originalId);
      if (!original) continue;
      const button = document.createElement('button'); button.id = id; button.type = 'button';
      button.className = 'toolbar-button'; button.dataset.closeSynthMenu = ''; button.textContent = label;
      button.addEventListener('click', () => {
        button.blur();
        const card = document.getElementById(cardId);
        if (card) card.open = true;
        original.click();
      }); imports.append(button);
    }
    section('Export', save, 'Instrument · S-DSP preset…');
    audio.classList.add('synth-menu-section'); panel.append(audio);
    section(null, reload);
    host.replaceChildren(menu, pin);
    const group = document.createElement('div'); group.className = 'synth-title-group';
    identity.before(group); group.append(host, identity);

    const button = document.getElementById('synthMenuButton');
    const close = () => {menu.open = false; button.setAttribute('aria-expanded', 'false');};
    menu.addEventListener('toggle', () => button.setAttribute('aria-expanded', String(menu.open)));
    button.addEventListener('pointerdown', event => event.preventDefault());
    button.addEventListener('keydown', event => {if ([' ', 'Enter'].includes(event.key)) event.stopPropagation();});
    panel.addEventListener('pointerdown', event => {if (event.target.closest('button')) event.preventDefault();});
    panel.addEventListener('click', event => {if (event.target.closest('[data-close-synth-menu]')) close();}, {capture:true});
    panel.addEventListener('keydown', event => {
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End',' ','Enter'].includes(event.key)) event.stopPropagation();
    });
    document.addEventListener('pointerdown', event => {if (menu.open && !menu.contains(event.target)) close();});
    window.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !menu.open) return;
      event.preventDefault(); event.stopPropagation(); close(); button.focus();
    }, {capture:true});
  }
  const mountedReloadButtons = new WeakSet(), mountedPinButtons = new WeakSet();
  function mountPin() {
    const button = document.getElementById('synthPinButton');
    if (!button || mountedPinButtons.has(button)) return;
    mountedPinButtons.add(button);
    let pinned = false, busy = true;
    const render = () => {
      button.disabled = busy;
      button.setAttribute('aria-pressed', String(pinned));
      button.classList.toggle('is-selected', pinned);
      button.title = pinned ? 'Unpin window' : 'Pin window on top';
      button.setAttribute('aria-label', button.title);
    };
    const readState = value => {
      if (typeof value !== 'boolean') throw new TypeError('Invalid native pin state');
      pinned = value;
    };
    // Keep the keyboard's performance target when clicking the toolbar.
    button.addEventListener('pointerdown', event => event.preventDefault());
    button.addEventListener('click', async () => {
      if (busy) return;
      busy = true; render();
      try {readState(await invoke('set_window_pin', {pinned: !pinned}));}
      catch (error) {status(`Could not pin window: ${String(error)}`);}
      finally {busy = false; render();}
    });
    render();
    void invoke('window_pin_state')
      .then(value => {readState(value); button.hidden = false;})
      .catch(error => status(`Could not read window pin state: ${String(error)}`))
      .finally(() => {busy = false; render();});
  }
  function mount() {
    ensureToolbarHost();
    mountToolbar();
    mountPin();
    const button = document.querySelector('[data-reset-offline-cache]');
    if (!button || mountedReloadButtons.has(button)) return;
    mountedReloadButtons.add(button);
    button.addEventListener('click', async event => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (button.disabled) return;
      button.disabled = true;
      try {if (await confirmReload()) await invoke('reload_window');}
      catch (error) {status(`Could not reload: ${String(error)}`);}
      finally {button.disabled = false;}
    }, {capture: true});
  }
  window.addEventListener('tetorica-synth-ready', mount);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true});
  else mount();
})();
