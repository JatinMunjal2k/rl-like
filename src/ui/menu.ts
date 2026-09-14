import { ACTIONS, ACTION_LABELS, gamepadButtonName, keyName, type Action, type InputManager } from '../input/input';

export type MenuScreen = 'main' | 'settings' | 'hidden';

/**
 * Minimal DOM menu: Free Play and Settings. Settings lists the rebindable actions with their
 * gamepad and keyboard bindings; clicking a binding waits for the next button or key.
 */
export class Menu {
  screen: MenuScreen = 'main';
  onPlay: (() => void) | null = null;
  onBindingsChanged: (() => void) | null = null;

  private readonly root: HTMLElement;
  private readonly main: HTMLElement;
  private readonly settings: HTMLElement;
  private readonly table: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private capturingCell: HTMLButtonElement | null = null;
  private hasStarted = false;

  constructor(
    container: HTMLElement,
    private readonly input: InputManager,
  ) {
    this.root = el('div', 'menu');
    this.main = el('div', 'menu-panel');
    this.settings = el('div', 'menu-panel');
    this.settings.hidden = true;

    const title = el('h1', 'menu-title');
    title.textContent = 'RL-like';
    this.main.appendChild(title);
    this.playButton = button('Free Play', () => this.play());
    this.main.appendChild(this.playButton);
    this.main.appendChild(button('Settings', () => this.show('settings')));
    const hint = el('p', 'menu-hint');
    hint.textContent = 'Esc / Start opens this menu during play.';
    this.main.appendChild(hint);

    const sTitle = el('h2', 'menu-title');
    sTitle.textContent = 'Controls';
    this.settings.appendChild(sTitle);
    const sHint = el('p', 'menu-hint');
    sHint.textContent = 'Click a binding, then press the gamepad button or key. Esc cancels.';
    this.settings.appendChild(sHint);
    this.table = el('div', 'bind-table');
    this.settings.appendChild(this.table);
    const row = el('div', 'menu-row');
    row.appendChild(
      button('Reset to defaults', () => {
        this.input.resetBindings();
        this.renderTable();
        this.onBindingsChanged?.();
      }),
    );
    row.appendChild(button('Back', () => this.show('main')));
    this.settings.appendChild(row);

    this.root.appendChild(this.main);
    this.root.appendChild(this.settings);
    container.appendChild(this.root);
    this.renderTable();
  }

  get open(): boolean {
    return this.screen !== 'hidden';
  }

  show(screen: MenuScreen): void {
    if (screen === 'hidden' && this.capturingCell) this.cancelCapture();
    this.screen = screen;
    this.root.hidden = screen === 'hidden';
    this.main.hidden = screen !== 'main';
    this.settings.hidden = screen !== 'settings';
    this.playButton.textContent = this.hasStarted ? 'Resume Free Play' : 'Free Play';
  }

  /** Esc / Start while playing: open the menu. Inside the menu: back out one level. */
  toggle(): void {
    if (this.screen === 'hidden') this.show('main');
    else if (this.screen === 'settings') {
      if (this.capturingCell) this.cancelCapture();
      else this.show('main');
    } else this.play();
  }

  private play(): void {
    this.hasStarted = true;
    this.show('hidden');
    this.onPlay?.();
  }

  private renderTable(): void {
    this.table.replaceChildren();
    const header = el('div', 'bind-row bind-head');
    for (const t of ['Action', 'Gamepad', 'Keyboard']) {
      const c = el('div');
      c.textContent = t;
      header.appendChild(c);
    }
    this.table.appendChild(header);

    for (const action of ACTIONS) {
      const row = el('div', 'bind-row');
      const name = el('div');
      name.textContent = ACTION_LABELS[action];
      row.appendChild(name);
      row.appendChild(this.bindCell(action, 'gamepad'));
      row.appendChild(this.bindCell(action, 'key'));
      this.table.appendChild(row);
    }
  }

  private bindCell(action: Action, kind: 'gamepad' | 'key'): HTMLButtonElement {
    const b = this.input.bindings;
    const label = kind === 'gamepad' ? gamepadButtonName(b.gamepad[action]) : keyName(b.keyboard[action]);
    const cell = button(label, () => {
      if (this.capturingCell) this.cancelCapture();
      this.capturingCell = cell;
      cell.textContent = 'Press…';
      cell.classList.add('capturing');
      this.input.startCapture((c) => {
        if (c.kind !== kind) {
          // Wrong device: keep waiting for the right one.
          this.input.startCapture((c2) => this.applyCapture(action, c2, kind));
          return;
        }
        this.applyCapture(action, c, kind);
      });
    });
    cell.classList.add('bind-cell');
    return cell;
  }

  private applyCapture(action: Action, c: { kind: 'gamepad'; button: number } | { kind: 'key'; code: string }, kind: 'gamepad' | 'key'): void {
    if (c.kind === kind) this.input.rebind(action, c);
    this.capturingCell = null;
    this.renderTable();
    this.onBindingsChanged?.();
  }

  private cancelCapture(): void {
    this.input.cancelCapture();
    this.capturingCell = null;
    this.renderTable();
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
