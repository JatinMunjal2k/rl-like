import { Game } from './sim/game';
import { TICK_DT } from './sim/constants';
import { Renderer } from './render/renderer';
import { FollowCamera } from './render/camera';
import { InputManager } from './input/input';

const app = document.getElementById('app')!;
const statusEl = document.getElementById('status')!;
const scoreEl = document.getElementById('score')!;
const bannerEl = document.getElementById('banner')!;

function setStatus(controller: string | null, ballCam: boolean): void {
  const pad = controller
    ? `<span class="ok">Controller: ${escapeHtml(controller)}</span>`
    : `<span class="warn">No controller detected.</span> Plug one in and press any button.`;
  statusEl.innerHTML =
    `${pad}<br>` +
    `Gamepad: RT throttle · LT reverse · A jump · B boost · X powerslide / air roll · LB/RB air roll · Y ball cam · Start reset<br>` +
    `Keyboard: <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> drive · <kbd>Space</kbd> jump · <kbd>Shift</kbd> boost · <kbd>Q</kbd>/<kbd>E</kbd> air roll · <kbd>C</kbd> ball cam · <kbd>R</kbd> reset<br>` +
    `Camera: ${ballCam ? 'ball cam' : 'car cam'}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

async function main(): Promise<void> {
  statusEl.textContent = 'Loading physics…';
  const game = await Game.create();
  const renderer = new Renderer(app);
  const followCam = new FollowCamera();
  const input = new InputManager();
  // Debug handle for the browser console.
  (window as unknown as { __game: Game; __input: InputManager }).__game = game;
  (window as unknown as { __game: Game; __input: InputManager }).__input = input;

  let controllerName: string | null = null;
  input.onControllerChange = (name) => {
    controllerName = name;
    setStatus(controllerName, followCam.ballCam);
  };
  setStatus(null, followCam.ballCam);

  let lastScore = '';
  let bannerUntil = 0;
  let last = performance.now();
  let accumulator = 0;

  const frame = (now: number): void => {
    const frameDt = Math.min((now - last) / 1000, 0.1);
    last = now;
    accumulator += frameDt;

    const fi = input.poll();
    if (fi.controllerName !== controllerName) {
      controllerName = fi.controllerName;
      setStatus(controllerName, followCam.ballCam);
    }
    if (fi.resetPressed) game.resetMatch();
    if (fi.toggleCameraPressed) {
      followCam.toggle();
      setStatus(controllerName, followCam.ballCam);
    }

    // Fixed-step simulation; render interpolates between the last two ticks.
    let steps = 0;
    while (accumulator >= TICK_DT && steps < 12) {
      game.step(fi.car, TICK_DT);
      accumulator -= TICK_DT;
      steps++;
    }
    if (steps === 12) accumulator = 0; // Tab was hidden or the machine stalled; drop the backlog.
    const alpha = accumulator / TICK_DT;

    renderer.sync(game.prev.car, game.curr.car, game.prev.ball, game.curr.ball, alpha, game.car.boosting);
    followCam.update(renderer.camera, renderer.carGroup, renderer.ballMesh, frameDt);
    renderer.render();

    const scoreText = `${game.score.blue}-${game.score.orange}`;
    if (scoreText !== lastScore) {
      lastScore = scoreText;
      scoreEl.innerHTML = `<span class="blue">BLUE ${game.score.blue}</span> &nbsp;–&nbsp; <span class="orange">${game.score.orange} ORANGE</span>`;
      if (game.lastGoal) {
        bannerEl.textContent = game.lastGoal === 'blue' ? 'GOAL!' : 'OWN GOAL';
        bannerEl.style.color = game.lastGoal === 'blue' ? '#4aa3ff' : '#ff9a3c';
        bannerEl.style.display = 'block';
        bannerUntil = now + 1800;
      }
    }
    if (bannerUntil && now > bannerUntil) {
      bannerEl.style.display = 'none';
      bannerUntil = 0;
    }

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  statusEl.innerHTML = `<span class="warn">Failed to start: ${escapeHtml(String(err))}</span>`;
});
