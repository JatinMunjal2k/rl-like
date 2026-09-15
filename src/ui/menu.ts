import { ACTIONS, ACTION_LABELS, gamepadButtonName, keyName, type Action, type Captured, type InputManager } from '../input/input';
import type { FrameInput } from '../input/types';
import { CAMERA_DEFS, CONTROL_DEFS, DEFAULT_SETTINGS, getSetting, setSetting, type SettingDef, type Settings } from '../settings';

export type MenuScreen = 'main' | 'settings' | 'controls' | 'camera' | 'gameplay' | 'hidden';
type PanelId = Exclude<MenuScreen, 'hidden'>;

/** Something the gamepad focus can land on. Buttons activate; slider rows adjust with left/right. */
interface Item {
  el: HTMLElement;
  row: number;
  col: number;
  activate?: () => void;
  adjust?: (dir: 1 | -1) => void;
}

interface Panel {
  el: HTMLElement;
  items: Item[];
  parent: MenuScreen;
  focus: number;
}

const REPEAT_DELAY = 0.4;
const REPEAT_INTERVAL = 0.12;

/**
 * DOM menu usable with mouse, keyboard (arrows / Enter / Backspace) and gamepad (D-pad or
 * stick, A accepts, B goes back). Screens: main → settings → controls | camera | gameplay.
 */
export class Menu {
  screen: MenuScreen = 'main';
  onPlay: (() => void) | null = null;
  onBindingsChanged: (() => void) | null = null;
  onSettingsChanged: (() => void) | null = null;

  private readonly root: HTMLElement;
  private readonly panels = {} as Record<PanelId, Panel>;
  private capturingCell: HTMLButtonElement | null = null;
  private hasStarted = false;
  private playButton!: HTMLButtonElement;
  private heldDir: 'up' | 'down' | 'left' | 'right' | null = null;
  private repeatTimer = 0;

  constructor(
    container: HTMLElement,
    private readonly input: InputManager,
    private readonly settings: Settings,
  ) {
    this.root = el('div', 'menu');
    this.buildMain();
    this.buildSettingsHub();
    this.buildControls();
    this.buildSliders('camera', 'Camera', CAMERA_DEFS, 'settings');
    this.buildSliders('gameplay', 'Gameplay', CONTROL_DEFS, 'settings');
    container.appendChild(this.root);
    this.show('main');
  }

  get open(): boolean {
    return this.screen !== 'hidden';
  }

  show(screen: MenuScreen): void {
    if (this.capturingCell) this.cancelCapture();
    this.screen = screen;
    this.root.hidden = screen === 'hidden';
    for (const [id, p] of Object.entries(this.panels) as [PanelId, Panel][]) p.el.hidden = id !== screen;
    if (screen !== 'hidden') {
      this.playButton.textContent = this.hasStarted ? 'Resume Free Play' : 'Free Play';
      this.setFocus(this.panels[screen].focus);
    }
    this.heldDir = null;
  }

  /** Menu button while playing opens the menu; inside the menu it backs out one level. */
  toggle(): void {
    if (this.screen === 'hidden') this.show('main');
    else this.back();
  }

  back(): void {
    if (this.screen === 'hidden') return;
    if (this.capturingCell) {
      this.cancelCapture();
      return;
    }
    const parent = this.panels[this.screen].parent;
    if (parent === 'hidden') this.play();
    else this.show(parent);
  }

  /** Feed navigation every frame while open. */
  navigate(nav: FrameInput['nav'], dt: number): void {
    if (this.screen === 'hidden' || this.input.capturing) return;
    const dir = nav.upHeld ? 'up' : nav.downHeld ? 'down' : nav.leftHeld ? 'left' : nav.rightHeld ? 'right' : null;
    if (dir !== this.heldDir) {
      this.heldDir = dir;
      if (dir) {
        this.move(dir);
        this.repeatTimer = REPEAT_DELAY;
      }
    } else if (dir) {
      this.repeatTimer -= dt;
      if (this.repeatTimer <= 0) {
        this.move(dir);
        this.repeatTimer = REPEAT_INTERVAL;
      }
    }
    if (nav.accept) this.activateFocused();
    if (nav.back) this.back();
  }

  // ---------------------------------------------------------------------------
  // Focus handling
  // ---------------------------------------------------------------------------

  private get panel(): Panel | null {
    return this.screen === 'hidden' ? null : this.panels[this.screen];
  }

  private setFocus(index: number): void {
    const p = this.panel;
    if (!p || p.items.length === 0) return;
    p.focus = Math.max(0, Math.min(p.items.length - 1, index));
    p.items.forEach((it, i) => it.el.classList.toggle('focused', i === p.focus));
    p.items[p.focus].el.scrollIntoView({ block: 'nearest' });
  }

  private move(dir: 'up' | 'down' | 'left' | 'right'): void {
    const p = this.panel;
    if (!p || p.items.length === 0) return;
    const cur = p.items[p.focus];
    if ((dir === 'left' || dir === 'right') && cur.adjust) {
      cur.adjust(dir === 'right' ? 1 : -1);
      return;
    }
    let best = -1;
    let bestScore = Infinity;
    p.items.forEach((it, i) => {
      if (i === p.focus) return;
      let ok = false;
      let score = 0;
      if (dir === 'up' || dir === 'down') {
        ok = dir === 'up' ? it.row < cur.row : it.row > cur.row;
        score = Math.abs(it.row - cur.row) * 10 + Math.abs(it.col - cur.col);
      } else {
        ok = it.row === cur.row && (dir === 'left' ? it.col < cur.col : it.col > cur.col);
        score = Math.abs(it.col - cur.col);
      }
      if (ok && score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best >= 0) this.setFocus(best);
  }

  private activateFocused(): void {
    const p = this.panel;
    if (!p || p.items.length === 0) return;
    p.items[p.focus].activate?.();
  }

  private addPanel(id: PanelId, parent: MenuScreen, title: string, wide = false): Panel {
    const panelEl = el('div', 'menu-panel' + (wide ? ' wide' : ''));
    const h = el(id === 'main' ? 'h1' : 'h2', 'menu-title');
    h.textContent = title;
    panelEl.appendChild(h);
    const panel: Panel = { el: panelEl, items: [], parent, focus: 0 };
    this.panels[id] = panel;
    this.root.appendChild(panelEl);
    return panel;
  }

  private addButton(panel: Panel, parentEl: HTMLElement, text: string, row: number, col: number, onClick: () => void): HTMLButtonElement {
    const b = button(text, onClick);
    parentEl.appendChild(b);
    panel.items.push({ el: b, row, col, activate: onClick });
    return b;
  }

  // ---------------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------------

  private buildMain(): void {
    const p = this.addPanel('main', 'hidden', '');
    const title = p.el.querySelector('.menu-title')!;
    title.innerHTML = 'RL<span class="accent">-</span>like';
    const sub = el('div', 'menu-subtitle');
    sub.textContent = 'Browser car soccer · free play';
    title.after(sub);
    this.playButton = this.addButton(p, p.el, 'Free Play', 0, 0, () => this.play());
    this.playButton.classList.add('primary');
    this.addButton(p, p.el, 'Settings', 1, 0, () => this.show('settings'));
    const hint = el('p', 'menu-hint');
    hint.innerHTML =
      '<span class="btn-glyph">Esc</span> / <span class="btn-glyph">Start</span> opens this menu during play. ' +
      'Navigate with the D-pad or stick, <span class="btn-glyph">A</span> selects, <span class="btn-glyph">B</span> goes back. ' +
      'Keyboard: arrows, <kbd>Enter</kbd>, <kbd>Backspace</kbd>.';
    p.el.appendChild(hint);
  }

  private buildSettingsHub(): void {
    const p = this.addPanel('settings', 'main', 'Settings');
    this.addButton(p, p.el, 'Controls', 0, 0, () => this.show('controls'));
    this.addButton(p, p.el, 'Camera', 1, 0, () => this.show('camera'));
    this.addButton(p, p.el, 'Gameplay', 2, 0, () => this.show('gameplay'));
    this.addButton(p, p.el, 'Back', 3, 0, () => this.back());
  }

  private buildControls(): void {
    const p = this.addPanel('controls', 'settings', 'Controls', true);
    const hint = el('p', 'menu-hint');
    hint.textContent = 'Select a binding, then press the gamepad button or key. Esc cancels.';
    p.el.appendChild(hint);
    const table = el('div', 'bind-table');
    p.el.appendChild(table);
    const footer = el('div', 'menu-row');
    p.el.appendChild(footer);

    const render = () => {
      // Rebuild the table and the item list (footer buttons re-added after).
      table.replaceChildren();
      p.items = [];
      const header = el('div', 'bind-row bind-head');
      for (const t of ['Action', 'Gamepad', 'Keyboard']) {
        const c = el('div');
        c.textContent = t;
        header.appendChild(c);
      }
      table.appendChild(header);
      ACTIONS.forEach((action, r) => {
        const row = el('div', 'bind-row');
        const name = el('div');
        name.textContent = ACTION_LABELS[action];
        row.appendChild(name);
        row.appendChild(this.bindCell(p, action, 'gamepad', r, 1, render));
        row.appendChild(this.bindCell(p, action, 'key', r, 2, render));
        table.appendChild(row);
      });
      footer.replaceChildren();
      const r = ACTIONS.length;
      this.addButton(p, footer, 'Reset to defaults', r, 1, () => {
        this.input.resetBindings();
        render();
        this.onBindingsChanged?.();
      });
      this.addButton(p, footer, 'Back', r, 2, () => this.back());
      if (this.screen === 'controls') this.setFocus(p.focus);
    };
    render();
  }

  private bindCell(p: Panel, action: Action, kind: 'gamepad' | 'key', row: number, col: number, rerender: () => void): HTMLButtonElement {
    const b = this.input.bindings;
    const label = kind === 'gamepad' ? gamepadButtonName(b.gamepad[action]) : keyName(b.keyboard[action]);
    const cell = button(label, () => {
      if (this.capturingCell) this.cancelCapture();
      this.capturingCell = cell;
      cell.textContent = 'Press…';
      cell.classList.add('capturing');
      const onCapture = (c: Captured) => {
        if (c.kind !== kind) {
          this.input.startCapture(onCapture); // wrong device, keep waiting
          return;
        }
        this.input.rebind(action, c);
        this.capturingCell = null;
        rerender();
        this.onBindingsChanged?.();
      };
      this.input.startCapture(onCapture);
    });
    cell.classList.add('bind-cell');
    p.items.push({ el: cell, row, col, activate: () => cell.click() });
    return cell;
  }

  private cancelCapture(): void {
    this.input.cancelCapture();
    this.capturingCell = null;
    // Restore labels.
    this.rerenderPanel('controls');
  }

  private rerenderPanel(id: PanelId): void {
    const p = this.panels[id];
    const focus = p.focus;
    // Cheap approach: rebuild the whole panel's dynamic parts by re-invoking its builder.
    if (id === 'controls') {
      this.root.removeChild(p.el);
      this.buildControls();
      this.panels.controls.focus = focus;
      if (this.screen === 'controls') {
        this.panels.controls.el.hidden = false;
        this.setFocus(focus);
      } else this.panels.controls.el.hidden = true;
    }
  }

  private buildSliders(id: PanelId, title: string, defs: SettingDef[], parent: MenuScreen): void {
    const p = this.addPanel(id, parent, title, true);
    const list = el('div', 'slider-list');
    p.el.appendChild(list);

    defs.forEach((def, r) => {
      const row = el('div', 'slider-row');
      const name = el('div', 'slider-label');
      const title = el('div', 'slider-title');
      title.textContent = def.label;
      const desc = el('div', 'slider-desc');
      desc.textContent = def.description;
      name.append(title, desc);
      const minus = button('−', () => adjust(-1));
      minus.classList.add('adj');
      const val = el('div', 'slider-value');
      const plus = button('+', () => adjust(1));
      plus.classList.add('adj');
      const bar = el('div', 'slider-bar');
      const fill = el('div', 'slider-fill');
      bar.appendChild(fill);
      row.append(name, minus, val, plus, bar);
      list.appendChild(row);

      const refresh = () => {
        const v = getSetting(this.settings, def);
        val.textContent = `${v.toFixed(def.decimals)}${def.unit ?? ''}`;
        fill.style.width = `${((v - def.min) / (def.max - def.min)) * 100}%`;
      };
      const adjust = (dir: 1 | -1) => {
        setSetting(this.settings, def, getSetting(this.settings, def) + dir * def.step);
        refresh();
        this.onSettingsChanged?.();
      };
      refresh();
      p.items.push({ el: row, row: r, col: 0, adjust, activate: () => adjust(1) });
      (row as HTMLElement & { refresh?: () => void }).refresh = refresh;
    });

    const footer = el('div', 'menu-row');
    p.el.appendChild(footer);
    this.addButton(p, footer, 'Reset to defaults', defs.length, 0, () => {
      for (const section of new Set(defs.map((d) => d.section))) {
        Object.assign(this.settings[section], structuredClone(DEFAULT_SETTINGS[section]));
      }
      for (const row of list.children) (row as HTMLElement & { refresh?: () => void }).refresh?.();
      this.onSettingsChanged?.();
    });
    this.addButton(p, footer, 'Back', defs.length, 1, () => this.back());
  }

  private play(): void {
    this.hasStarted = true;
    this.show('hidden');
    this.onPlay?.();
  }
}

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'menu-button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}
