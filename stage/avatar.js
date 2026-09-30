// VTuber 皮：用 three.js + three-vrm 在瀏覽器畫 VRM 角色。
// 口型：量播放中聲音的音量；表情：由大腦決定的 emotion；待機：呼吸、眨眼、頭微擺。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const box = document.getElementById('avatarbox');
const canvas = document.getElementById('avatarCanvas');
const note = document.getElementById('avatarnote');
const say = (t) => { if (note) note.textContent = t; console.log('[vtuber] ' + t); };

const EMO = {
  neutral: {},
  happy: { happy: 1 },
  surprised: { surprised: 1 },
  thinking: { relaxed: 0.6 },
  sorry: { sad: 0.6 },
};
const TILT = { thinking: 0.16, sorry: -0.06 };

let vrm = null, renderer, scene, camera, timer;
let mouth = 0, talking = false, analyser = null, timeData = null, audioCtx = null;
let emotion = 'neutral', neutralAt = 0;
const cur = { happy: 0, surprised: 0, relaxed: 0, sad: 0 };
let tilt = 0, nextBlink = 2, blinkT = -1;
let armSign = -1; // 左上臂往下的旋轉方向；載入後依骨頭位置判定

export function setEmotion(e) { emotion = EMO[e] ? e : 'neutral'; neutralAt = 0; }
export function setTalking(on) {
  talking = on;
  if (!on) neutralAt = performance.now() + 2000;
}
export function stopNow() { talking = false; mouth = 0; emotion = 'neutral'; neutralAt = 0; }
export function attachAudio(el) {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaElementSource(el);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.5;
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    timeData = new Uint8Array(analyser.fftSize);
  } catch (e) { say('聲音分析不可用：' + e.message); }
}
export function unlock() { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); }

function level() {
  if (!analyser || !talking) return 0;
  analyser.getByteTimeDomainData(timeData);
  let sum = 0;
  for (let i = 0; i < timeData.length; i++) { const v = (timeData[i] - 128) / 128; sum += v * v; }
  const rms = Math.sqrt(sum / timeData.length);
  return Math.min(1, Math.max(0, (rms - 0.012) * 7));
}

function resize() {
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 400;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function frameCamera() {
  const head = vrm.humanoid.getNormalizedBoneNode('head');
  const p = new THREE.Vector3();
  vrm.scene.updateMatrixWorld(true);
  head.getWorldPosition(p);
  // head 骨頭在脖子上端；臉的中心約再往上 8 公分
  camera.position.set(0, p.y + 0.07, 0.95);
  camera.lookAt(0, p.y + 0.04, 0);
}

function poseArms() {
  const h = vrm.humanoid;
  const lu = h.getNormalizedBoneNode('leftUpperArm'), ru = h.getNormalizedBoneNode('rightUpperArm');
  const ll = h.getNormalizedBoneNode('leftLowerArm'), rl = h.getNormalizedBoneNode('rightLowerArm');
  // 左手在世界 +X 側就往 -Z 方向轉才會下垂；反之相反
  const lp = new THREE.Vector3(); lu.getWorldPosition(lp);
  armSign = lp.x > 0 ? -1 : 1;
  if (lu) lu.rotation.z = armSign * 1.15;
  if (ru) ru.rotation.z = -armSign * 1.15;
  if (ll) ll.rotation.z = armSign * 0.2;
  if (rl) rl.rotation.z = -armSign * 0.2;
}

function animate() {
  timer.update();
  const dt = Math.min(0.05, timer.getDelta());
  const t = timer.getElapsed();
  if (vrm) {
    const h = vrm.humanoid, em = vrm.expressionManager;
    // 待機：呼吸 + 頭微擺
    const spine = h.getNormalizedBoneNode('spine'), chest = h.getNormalizedBoneNode('chest') || spine;
    const head = h.getNormalizedBoneNode('head'), neck = h.getNormalizedBoneNode('neck') || head;
    const breath = Math.sin(t * 1.3) * 0.012;
    if (spine) spine.rotation.x = breath;
    if (chest && chest !== spine) chest.rotation.x = breath * 0.6;
    const lv = level();
    mouth += (lv - mouth) * Math.min(1, dt * 22);
    const nod = talking ? Math.sin(t * 5.2) * 0.035 * (0.4 + mouth) : 0;
    const targetTilt = TILT[emotion] || 0;
    tilt += (targetTilt - tilt) * Math.min(1, dt * 4);
    head.rotation.set(Math.sin(t * 0.61) * 0.03 + nod, Math.sin(t * 0.37) * 0.08 + (talking ? Math.sin(t * 1.7) * 0.04 : 0), tilt);
    if (neck !== head) neck.rotation.y = Math.sin(t * 0.37) * 0.03;
    // 眨眼
    if (blinkT < 0 && t > nextBlink) { blinkT = 0; nextBlink = t + 2.5 + Math.random() * 3.5; }
    let blink = 0;
    if (blinkT >= 0) { blinkT += dt; blink = blinkT < 0.07 ? blinkT / 0.07 : blinkT < 0.16 ? 1 - (blinkT - 0.07) / 0.09 : 0; if (blinkT >= 0.16) blinkT = -1; }
    // 表情漸變；說完 2 秒回 neutral
    if (neutralAt && performance.now() > neutralAt) { emotion = 'neutral'; neutralAt = 0; }
    const want = EMO[emotion] || {};
    for (const k of Object.keys(cur)) { const tv = want[k] || 0; cur[k] += (tv - cur[k]) * Math.min(1, dt * 6); em.setValue(k, cur[k]); }
    em.setValue('blink', Math.max(blink, 0));
    // 口型：aa 為主，帶一點 oh 讓嘴型有變化
    em.setValue('aa', mouth * 0.85);
    em.setValue('oh', mouth * 0.25 * (0.5 + 0.5 * Math.sin(t * 9)));
    vrm.update(dt);
  }
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

async function main() {
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(26, 0.75, 0.05, 20);
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(0.6, 1.6, 1.4); scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fb6ff, 0.5); fill.position.set(-1, 1, 0.5); scene.add(fill);
    timer = new THREE.Timer();
    resize();
    new ResizeObserver(resize).observe(canvas);
    say('載入角色中…');
    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    const gltf = await loader.loadAsync('/avatar.vrm');
    vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    if (VRMUtils.combineSkeletons) VRMUtils.combineSkeletons(gltf.scene); else VRMUtils.removeUnnecessaryJoints(gltf.scene);
    VRMUtils.rotateVRM0(vrm);
    scene.add(vrm.scene);
    if (vrm.lookAt) vrm.lookAt.target = camera;
    poseArms();
    frameCamera();
    const meta = vrm.meta || {};
    const author = (meta.authors && meta.authors[0]) || meta.author || '';
    say(`角色：${meta.name || 'VRM'}${author ? ' · ' + author : ''}`);
    window.__vrm = vrm; window.__THREE = THREE;
    window.avatarReady = true;
    animate();
  } catch (e) {
    say('皮載入失敗（不影響測試）：' + (e && e.message ? e.message : e));
    if (box) box.classList.add('failed');
    window.avatarError = String(e && e.message ? e.message : e);
  }
}
window.vtuber = { setEmotion, setTalking, stopNow, attachAudio, unlock };
main();
