import { Game } from './sim/game';
import { CAR, TICK_DT, UU } from './sim/rl';
import { Renderer } from './render/renderer';
import { FollowCamera } from './render/camera';
import { InputManager } from './input/input';
import { Menu } from './ui/menu';

const app = document.getElementById('app')!;
const scoreEl = document.getElementById('score')!;
const bannerEl = document.getElementById('banner')!;
const fpsEl = document.getElementById('fps')!;
const camModeEl = document.getElementById('camMode')!;
const controllerEl = document.getElementById('controller')!;
const speedEl = document.getElementById('speed')!;
const speedValueEl = speedEl.querySelector('.value')!;
const boostFillEl = document.getElementById('boostFill') as unknown as SVGCircleElement;
const boostValueEl = document.getElementById('boostValue')!;

const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 56;
boostFillEl.style.strokeDasharray = `${GAUGE_CIRCUMFERENCE}`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function setController(name: string | null): void {
  controllerEl.innerHTML = name
    ? `<span class="ok">Controller: ${escapeHtml(name)}</span>`
    : `<span class="warn">No controller.</span> Press a button on your controller, or use the keyboard.`;
}

function setCamMode(ballCam: boolean): void {
  camModeEl.textContent = ballCam ? 'BALL CAM' : 'CAR CAM';
  camModeEl.classList.toggle('on', ballCam);
}

async function main(): Promise<void> {
  controllerEl.textContent = 'Loading physics…';
  const game = await Game.create();
  const renderer = new Renderer(app, game.arena, game.pads);
  const followCam = new FollowCamera();
  const input = new InputManager();
  const menu = new Menu(document.body, input);

  // Debug handle for the browser console.
  (window as unknown as { __game: Game; __input: InputManager }).__game = game;
  (window as unknown as { __game: Game; __input: InputManager }).__input = input;

  let controllerName: string | null = null;
  input.onControllerChange = (name) => {
    controllerName = name;
    setController(name);
  };
  menu.onPlay = () => {
    last = performance.now();
    accumulator = 0;
  };
  setController(null);
  setCamMode(followCam.ballCam);

  let lastScore = '';
  let bannerUntil = 0;
  let last = performance.now();
  let accumulator = 0;
  let fpsFrames = 0;
  let fpsWindowStart = performance.now();
  let lastSpeedUU = -1;
  let lastBoost = -1;
  let lastBoostState = '';

  const frame = (now: number): void => {
    const frameDt = Math.min((now - last) / 1000, 0.1);
    last = now;

    const fi = input.poll();
    if (fi.controllerName !== controllerName) {
      controllerName = fi.controllerName;
      setController(controllerName);
    }
    if (fi.menuPressed) menu.toggle();

    if (!menu.open) {
      accumulator += frameDt;
      if (fi.resetPressed) game.resetMatch();
      if (fi.toggleCameraPressed) {
        followCam.toggle();
        setCamMode(followCam.ballCam);
      }

      // Fixed-step simulation; render interpolates between the last two ticks.
      let steps = 0;
      while (accumulator >= TICK_DT && steps < 12) {
        game.step(fi.car, TICK_DT);
        accumulator -= TICK_DT;
        steps++;
      }
      if (steps === 12) accumulator = 0; // Tab was hidden or the machine stalled; drop the backlog.
    }
    const alpha = Math.min(1, accumulator / TICK_DT);

    renderer.sync(game.prev.car, game.curr.car, game.prev.ball, game.curr.ball, alpha, game.car.boosting, game.car.supersonic, game.ballVisible);
    renderer.syncPads(game.pads);
    followCam.update(renderer.camera, renderer.carGroup, renderer.ballMesh, frameDt);
    renderer.render();

    // --- HUD ---------------------------------------------------------------------
    const lv = game.car.body.linvel();
    const speedUU = Math.round(Math.hypot(lv.x, lv.y, lv.z) / UU / 10) * 10;
    if (speedUU !== lastSpeedUU) {
      lastSpeedUU = speedUU;
      speedValueEl.textContent = String(speedUU);
    }
    speedEl.classList.toggle('supersonic', game.car.supersonic);

    const boost = Math.round(game.car.boost);
    if (boost !== lastBoost) {
      lastBoost = boost;
      boostValueEl.textContent = String(boost);
      boostFillEl.style.strokeDashoffset = `${GAUGE_CIRCUMFERENCE * (1 - boost / CAR.boostMax)}`;
    }
    const boostState = game.car.boosting ? 'boosting' : boost === 0 ? 'empty' : '';
    if (boostState !== lastBoostState) {
      lastBoostState = boostState;
      boostFillEl.setAttribute('class', `fill ${boostState}`);
    }

    fpsFrames++;
    if (now - fpsWindowStart >= 500) {
      fpsEl.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsWindowStart))} fps`;
      fpsFrames = 0;
      fpsWindowStart = now;
    }

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
  controllerEl.innerHTML = `<span class="warn">Failed to start: ${escapeHtml(String(err))}</span>`;
});
