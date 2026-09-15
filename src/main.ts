import { Game } from './sim/game';
import { CAR, TICK_DT, UU } from './sim/rl';
import { Renderer } from './render/renderer';
import { FollowCamera } from './render/camera';
import { InputManager } from './input/input';
import { Menu } from './ui/menu';
import { loadSettings, saveSettings } from './settings';

const app = document.getElementById('app')!;
const hudEl = document.getElementById('hud')!;
const scoreEl = document.getElementById('score')!;
const bannerEl = document.getElementById('banner')!;
const bannerTitleEl = bannerEl.querySelector('.title')!;
const bannerSpeedEl = bannerEl.querySelector('.goalSpeed')!;
const fpsEl = document.getElementById('fps')!;
const camModeEl = document.getElementById('camMode')!;
const controllerEl = document.getElementById('controller')!;
const speedEl = document.getElementById('speed')!;
const speedValueEl = speedEl.querySelector('.value')!;
const boostFillEl = document.getElementById('boostFill') as unknown as SVGCircleElement;
const boostValueEl = document.getElementById('boostValue')!;

const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 56;
boostFillEl.style.strokeDasharray = `${GAUGE_CIRCUMFERENCE}`;
/** Speed readout goes red only at the hard cap (within 10 uu/s of 2300). */
const MAX_SPEED_UU = CAR.maxSpeed / UU - 10;

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
  const settings = loadSettings();
  const game = await Game.create();
  const renderer = new Renderer(app, game.arena, game.pads);
  const followCam = new FollowCamera(settings);
  const input = new InputManager(settings);
  const menu = new Menu(document.body, input, settings);

  // Debug handle for the browser console.
  (window as unknown as { __game: Game; __input: InputManager; __menu: Menu }).__game = game;
  (window as unknown as { __game: Game; __input: InputManager; __menu: Menu }).__input = input;
  (window as unknown as { __game: Game; __input: InputManager; __menu: Menu }).__menu = menu;

  const applySettings = () => {
    saveSettings(settings);
    followCam.applyProjection(renderer.camera);
    game.car.dodgeDeadzone = settings.controls.dodgeDeadzone;
  };
  applySettings();
  window.addEventListener('resize', () => followCam.applyProjection(renderer.camera));

  let controllerName: string | null = null;
  input.onControllerChange = (name) => {
    controllerName = name;
    setController(name);
  };
  menu.onSettingsChanged = applySettings;
  menu.onPlay = () => {
    last = performance.now();
    accumulator = 0;
    input.blockJumpUntilRelease();
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
  let ballCamBeforeGoal = followCam.ballCam;
  let wasInGoalPause = false;

  const frame = (now: number): void => {
    const frameDt = Math.min((now - last) / 1000, 0.1);
    last = now;

    const fi = input.poll();
    if (fi.controllerName !== controllerName) {
      controllerName = fi.controllerName;
      setController(controllerName);
    }
    if (fi.menuPressed) menu.toggle();

    if (menu.open) {
      // Menu: black screen, no simulation, no rendering.
      menu.navigate(fi.nav, frameDt);
      hudEl.hidden = true;
      requestAnimationFrame(frame);
      return;
    }
    hudEl.hidden = false;

    accumulator += frameDt;
    if (fi.resetPressed) game.resetMatch();
    if (fi.toggleCameraPressed) {
      followCam.toggle();
      setCamMode(followCam.ballCam);
      if (game.goalPause > 0) ballCamBeforeGoal = followCam.ballCam; // user's choice during the pause sticks
    }

    // Goal: no ball to look at, so car cam until kickoff, then back to what the player had.
    const inGoalPause = game.goalPause > 0;
    if (inGoalPause && !wasInGoalPause) {
      ballCamBeforeGoal = followCam.ballCam;
      followCam.ballCam = false;
      setCamMode(false);
    } else if (!inGoalPause && wasInGoalPause) {
      followCam.ballCam = ballCamBeforeGoal;
      setCamMode(followCam.ballCam);
    }
    wasInGoalPause = inGoalPause;

    // Fixed-step simulation; render interpolates between the last two ticks.
    let steps = 0;
    while (accumulator >= TICK_DT && steps < 12) {
      game.step(fi.car, TICK_DT);
      accumulator -= TICK_DT;
      steps++;
    }
    if (steps === 12) accumulator = 0; // Tab was hidden or the machine stalled; drop the backlog.
    const alpha = Math.min(1, accumulator / TICK_DT);

    renderer.sync(game.prev.car, game.curr.car, game.prev.ball, game.curr.ball, alpha, game.car.boosting, game.car.supersonic, game.ballVisible);
    renderer.syncPads(game.pads);
    const q = renderer.carGroup.quaternion;
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    followCam.update(renderer.camera, renderer.carGroup, renderer.ballMesh, { holdHeading: game.car.isFlipping || Math.abs(upY) < 0.35 }, frameDt);
    renderer.render();

    // --- HUD ---------------------------------------------------------------------
    const lv = game.car.body.linvel();
    const speedUU = Math.round(Math.hypot(lv.x, lv.y, lv.z) / UU / 10) * 10;
    if (speedUU !== lastSpeedUU) {
      lastSpeedUU = speedUU;
      speedValueEl.textContent = String(speedUU);
      speedEl.classList.toggle('max', speedUU >= MAX_SPEED_UU);
    }

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
        const uu = game.lastGoalSpeed / UU;
        bannerTitleEl.textContent = game.lastGoal === 'blue' ? 'GOAL!' : 'OWN GOAL';
        bannerSpeedEl.textContent = `${Math.round(uu * 0.036)} km/h  ·  ${Math.round(uu)} uu/s`;
        bannerEl.style.color = game.lastGoal === 'blue' ? '#4aa3ff' : '#ff9a3c';
        bannerEl.style.display = 'block';
        bannerUntil = now + 2500;
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
