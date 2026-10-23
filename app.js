import { createCabinAudio } from './cabin-audio.js?v=1.5.0';

const $ = id => document.getElementById(id);
const presets = {
  v6: { idle: 850, redline: 7200, parameters: [6, 183, 10.8, 38, 25, .43, .025, .85, 20, .95] },
  v8: { idle: 750, redline: 6500, parameters: [8, 350, 10.5, 56, 30, .52, .03, .8, 18, .9] },
  v10: { idle: 900, redline: 8500, parameters: [10, 317, 12, 32, 21, .36, .02, .72, 22, 1.02] },
  v12: { idle: 950, redline: 9000, parameters: [12, 396, 12.5, 28, 18, .3, .018, .67, 24, 1.05] },
};
let selected = 'v8', running = false, loading = false, pressed = false, mode = 'manual';
let context, worklet, gain, cabin, watchId, gpsEpoch = 0, gpsSpeed = null, lastFix = 0;
let rpm = 0, throttle = 0, gear = 1, previousSpeed = 0, lastFrame = performance.now(), lastUi = 0;
const ratios = [3.5, 2.3, 1.6, 1.2, .95, .78];
const svgNS = 'http://www.w3.org/2000/svg';
let gaugeMax = 8000, lastClockMinute = -1;
let weatherRequest, weatherKey = '', weatherUpdated = 0, weatherAttempt = 0;
const cluster = document.querySelector('.cluster');

function updateGaugeEngine() {
  const preset = presets[selected];
  gaugeMax = Math.max(8000, Math.ceil(preset.redline / 1000) * 1000);
  $('dial-ticks').replaceChildren();
  $('dial-rays').replaceChildren();
  for (let value = 0; value <= gaugeMax; value += 100) {
    const angle = (-128 + value / gaugeMax * 256) * Math.PI / 180;
    const major = value % 1000 === 0;
    const point = radius => [210 + radius * Math.sin(angle), 190 - radius * Math.cos(angle)];
    const tick = document.createElementNS(svgNS, 'line');
    const [x1, y1] = point(major ? 153 : 162), [x2, y2] = point(171);
    for (const [name, number] of Object.entries({ x1, y1, x2, y2 })) tick.setAttribute(name, number);
    tick.setAttribute('class', `dial-tick${major ? ' major' : ''}${value >= preset.redline ? ' redline' : ''}`);
    $('dial-ticks').append(tick);
    const ray = document.createElementNS(svgNS, 'line');
    const [rx, ry] = point(38);
    for (const [name, number] of Object.entries({ x1: rx, y1: ry, x2, y2 })) ray.setAttribute(name, number);
    ray.setAttribute('class', 'dial-ray');
    $('dial-rays').append(ray);
    if (major) {
      const label = document.createElementNS(svgNS, 'text');
      const [x, y] = point(136);
      label.setAttribute('x', x); label.setAttribute('y', y);
      label.setAttribute('class', 'dial-number'); label.textContent = value / 1000;
      $('dial-ticks').append(label);
    }
  }
  const angle = (-128 + preset.redline / gaugeMax * 256) * Math.PI / 180;
  const x = 210 + 173 * Math.sin(angle), y = 190 - 173 * Math.cos(angle);
  $('redline-arc').setAttribute('d', `M ${x} ${y} A 173 173 0 0 1 346.32 296.51`);
  $('redline-arc').style.opacity = preset.redline < gaugeMax ? 1 : 0;
  $('engine-code').textContent = selected.toUpperCase();
}

function message(text, error = false) {
  $('status-message').textContent = text;
  $('status-message').classList.toggle('error', error);
}

function releasePedal() {
  pressed = false;
  $('pedal').classList.remove('pressed');
}

function updateControls() {
  $('ignition-label').textContent = loading ? '正在点火…' : running ? '熄火' : '点火';
  $('ignition').disabled = loading;
  $('ignition').classList.toggle('running', running);
  $('signal-dot').classList.toggle('running', running);
  $('engine-status').textContent = running ? '引擎运转中' : '引擎待命';
  $('pedal').disabled = !running || mode === 'gps';
  $('pedal-title').textContent = mode === 'gps' ? '随车速自动轰油' : '按住油门';
  $('pedal-hint').textContent = mode === 'gps' ? 'GPS 自动跟随 · 同步当地气温' : running ? '松开回到怠速 · 也可按住空格键' : '先点火，再按住这里或空格键';
  for (const name of ['manual', 'gps']) {
    $(`${name}-mode`).classList.toggle('active', mode === name);
    $(`${name}-mode`).setAttribute('aria-pressed', String(mode === name));
  }
}

function clearGps() {
  gpsEpoch++;
  if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
  watchId = undefined;
  gpsSpeed = null;
  previousSpeed = 0;
  lastFix = 0;
  gear = 1;
  weatherRequest?.abort();
  weatherRequest = undefined;
  weatherKey = ''; weatherUpdated = weatherAttempt = 0;
  $('temperature').textContent = '—°C';
  $('temperature').title = '开启 GPS 跟随并点火后获取当前位置气温';
  $('temperature').setAttribute('aria-label', '当前位置气温未获取');
}

async function updateWeather(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return;
  // City-level coordinates are sufficient for weather; never send precise GPS coordinates.
  const lat = latitude.toFixed(1), lon = longitude.toFixed(1), key = `${lat},${lon}`;
  const now = Date.now(), epoch = gpsEpoch;
  if (weatherRequest || now - weatherAttempt < 60000 || (key === weatherKey && now - weatherUpdated < 900000)) return;
  weatherKey = key; weatherAttempt = now;
  const request = new AbortController();
  weatherRequest = request;
  const timeout = setTimeout(() => request.abort(), 10000);
  const temperature = $('temperature');
  temperature.textContent = '…°C';
  temperature.title = '正在查询当前位置气温';
  temperature.setAttribute('aria-label', '正在获取当地气温');
  try {
    const params = new URLSearchParams({ latitude: lat, longitude: lon, current: 'temperature_2m', temperature_unit: 'celsius', timeformat: 'unixtime', forecast_days: '1' });
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: request.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error('weather');
    const data = await response.json(), value = data.current?.temperature_2m, time = data.current?.time;
    if (!Number.isFinite(value) || value < -90 || value > 70 || !Number.isFinite(time) || Math.abs(Date.now() - time * 1000) > 7200000) throw new Error('weather');
    if (epoch !== gpsEpoch) return;
    weatherUpdated = Date.now();
    temperature.textContent = `${Math.round(value)}°C`;
    temperature.title = `当地气温 · ${new Date(time * 1000).toLocaleString()} · Open-Meteo`;
    temperature.setAttribute('aria-label', `当前位置气温 ${Math.round(value)} 摄氏度`);
  } catch {
    if (epoch !== gpsEpoch) return;
    temperature.textContent = '—°C';
    temperature.title = '天气暂不可用，将在后续定位更新时重试';
    temperature.setAttribute('aria-label', '当地气温暂不可用');
  } finally {
    clearTimeout(timeout);
    if (weatherRequest === request) weatherRequest = undefined;
  }
}

function stop(text = '声浪已停止。随时再来一次。') {
  running = false;
  releasePedal();
  clearGps();
  if (context && gain) gain.gain.setTargetAtTime(0, context.currentTime, .025);
  worklet?.port.postMessage({ type: 'enabled', value: false });
  rpm = throttle = 0;
  updateControls();
  message(text);
}

function disposeAudio() {
  const oldContext = context;
  if (worklet) {
    worklet.port.onmessage = null;
    worklet.onprocessorerror = null;
    worklet.disconnect();
  }
  context = worklet = gain = cabin = undefined;
  return oldContext?.state !== 'closed' ? oldContext?.close().catch(() => {}) : Promise.resolve();
}

function startGps() {
  clearGps();
  if (!navigator.geolocation) {
    mode = 'manual'; updateControls();
    message('这个浏览器不支持定位，已切回手动试听。', true);
    return;
  }
  const epoch = gpsEpoch;
  message('等待定位授权与 GPS 车速；没有速度时保持怠速。');
  watchId = navigator.geolocation.watchPosition(position => {
    if (epoch !== gpsEpoch || !running || mode !== 'gps') return;
    const { speed, accuracy, latitude, longitude } = position.coords;
    const accurate = Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 80;
    const age = Date.now() - position.timestamp;
    const recent = Number.isFinite(age) && age >= -1000 && age <= 8000;
    if (accurate && recent) void updateWeather(latitude, longitude);
    if (!accurate || !recent || !Number.isFinite(speed) || speed < 0 || speed > 72.3) {
      gpsSpeed = null;
      message(accuracy > 80 ? '定位精度不足，暂时保持怠速。' : 'GPS 暂未提供有效车速，保持怠速。');
      return;
    }
    previousSpeed = gpsSpeed ?? speed * 3.6;
    gpsSpeed = speed * 3.6;
    lastFix = performance.now();
    message('GPS 已连接 · 请勿在行驶中操作屏幕。');
  }, error => {
    if (epoch !== gpsEpoch) return;
    clearGps(); mode = 'manual'; updateControls();
    message(error.code === 1 ? '定位未获允许，已切回手动试听。' : '暂时无法获取定位，已切回手动试听。', true);
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 12000 });
}

async function prepareAudio() {
  if (context && worklet) {
    await context.resume();
    return;
  }
  if (!window.AudioContext || !window.AudioWorkletNode || !window.WebAssembly) throw new Error('unsupported');
  context = new AudioContext({ latencyHint: 'interactive' });
  // Resume inside the tap before awaiting downloads; mobile audio requires the gesture.
  const resumed = context.resume();
  gain = context.createGain(); gain.gain.value = 0;
  cabin = createCabinAudio(context);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15000);
  let bytes;
  try {
    const response = await fetch('./wasm/engine-sim.wasm', { signal: abort.signal });
    if (!response.ok) throw new Error('download');
    bytes = await response.arrayBuffer();
  } finally { clearTimeout(timeout); }
  const module = await WebAssembly.compile(bytes);
  await context.audioWorklet.addModule('./wasm/processor.js?v=1.5.0');
  worklet = new AudioWorkletNode(context, 'rev-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { module } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('audio-timeout')), 8000);
    worklet.port.onmessage = ({ data }) => {
      if (data.type === 'ready') { clearTimeout(timer); resolve(); }
      if (data.type === 'error') { clearTimeout(timer); stop('声音引擎发生错误，请重新点火。'); void disposeAudio(); reject(new Error('processor')); }
    };
    worklet.onprocessorerror = () => { clearTimeout(timer); stop('声音引擎已停止，请重新点火。'); void disposeAudio(); reject(new Error('processor')); };
  });
  worklet.connect(cabin.input);
  cabin.output.connect(gain).connect(context.destination);
  await resumed;
}

$('ignition').addEventListener('click', async () => {
  if (running) { stop(); return; }
  if (loading) return;
  loading = true; updateControls(); message('正在唤醒引擎…');
  try {
    await prepareAudio();
    if (document.hidden) throw new Error('hidden');
    worklet.port.postMessage({ type: 'configure', parameters: presets[selected].parameters });
    worklet.port.postMessage({ type: 'enabled', value: true });
    gain.gain.setTargetAtTime(Number($('volume').value) / 100 * .65, context.currentTime, .04);
    running = true; rpm = presets[selected].idle; updateControls();
    message('引擎已就绪。按住油门，听见变化。');
    if (mode === 'gps') startGps();
    else if (document.activeElement === $('ignition')) $('pedal').focus({ preventScroll: true });
  } catch (error) {
    stop();
    await disposeAudio();
    message(error.message === 'unsupported' ? '浏览器不支持此声音引擎，请使用较新版本的 Chrome 或 Safari。' : '点火未成功，请检查网络与浏览器音频权限后重试。', true);
  } finally { loading = false; updateControls(); }
});

document.querySelectorAll('[data-engine]').forEach(button => button.addEventListener('click', () => {
  selected = button.dataset.engine;
  updateGaugeEngine();
  document.querySelectorAll('[data-engine]').forEach(option => {
    const active = option === button;
    option.classList.toggle('selected', active); option.setAttribute('aria-pressed', String(active));
  });
  releasePedal();
  gear = 1;
  worklet?.port.postMessage({ type: 'configure', parameters: presets[selected].parameters });
  if (running && mode === 'manual' && document.activeElement === button) $('pedal').focus({ preventScroll: true });
}));

for (const name of ['manual', 'gps']) $(`${name}-mode`).addEventListener('click', () => {
  if (mode === name) return;
  releasePedal(); clearGps(); mode = name; updateControls();
  if (mode === 'gps' && running) startGps();
  else message(mode === 'gps' ? '点火后开启定位；车速只在当前页面使用。' : '手动试听 · 按住油门或空格键。');
  if (running && mode === 'manual' && document.activeElement === $('manual-mode')) $('pedal').focus({ preventScroll: true });
});

$('pedal').addEventListener('pointerdown', event => {
  if (!running || mode !== 'manual' || event.button !== 0) return;
  event.preventDefault(); pressed = true; $('pedal').classList.add('pressed');
  $('pedal').setPointerCapture(event.pointerId);
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('pedal').addEventListener(event, releasePedal);
$('pedal').addEventListener('contextmenu', event => event.preventDefault());
document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.repeat || !running || mode !== 'manual') return;
  if (event.target !== document.body && event.target !== $('pedal')) return;
  event.preventDefault(); pressed = true; $('pedal').classList.add('pressed');
});
document.addEventListener('keyup', event => { if (event.code === 'Space') releasePedal(); });
window.addEventListener('blur', releasePedal);
document.addEventListener('visibilitychange', () => { if (document.hidden && running) stop('页面离开，声浪已停止。点火即可继续。'); });
window.addEventListener('pagehide', () => { stop(); void disposeAudio(); });
$('volume').addEventListener('input', () => {
  $('volume-value').textContent = `${$('volume').value}%`;
  if (gain && running) gain.gain.setTargetAtTime(Number($('volume').value) / 100 * .65, context.currentTime, .04);
});
$('about-toggle').addEventListener('click', () => {
  $('about').hidden = !$('about').hidden;
  $('about-toggle').setAttribute('aria-expanded', String(!$('about').hidden));
});
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { message('当前浏览器无法全屏，可直接继续使用。'); }
});
document.addEventListener('fullscreenchange', () => $('fullscreen').setAttribute('aria-label', document.fullscreenElement ? '退出全屏' : '进入全屏'));

function tick(now) {
  const dt = Math.min((now - lastFrame) / 1000, .06); lastFrame = now;
  const preset = presets[selected];
  if (running) {
    let target = preset.idle, input = pressed ? 1 : 0;
    if (mode === 'gps') {
      const valid = gpsSpeed !== null && now - lastFix < 8000;
      if (!valid) {
        if (gpsSpeed !== null) { gpsSpeed = null; message('GPS 车速已过期，暂时保持怠速。'); }
        input = 0;
      } else {
        const wheelRpm = gpsSpeed / 3.6 / 2.1 * 60 * 3.4;
        if (wheelRpm * ratios[gear - 1] > preset.redline * .83 && gear < ratios.length) gear++;
        else if (wheelRpm * ratios[gear - 1] < 1800 && gear > 1) gear--;
        target = Math.max(preset.idle, Math.min(preset.redline, wheelRpm * ratios[gear - 1]));
        input = Math.min(1, Math.max(.12, (gpsSpeed - previousSpeed) / 12 + .25));
      }
    } else target = pressed ? preset.redline * .98 : preset.idle;
    throttle += (input - throttle) * (1 - Math.exp(-dt * 6));
    rpm += (target - rpm) * (1 - Math.exp(-dt * (pressed ? 2 : 2.8)));
    cabin?.update(rpm, preset.redline, throttle);
    worklet?.port.postMessage({ type: 'frame', frame: { rpm, redline: preset.redline, throttle } });
  }
  if (now - lastUi > 50) {
    lastUi = now;
    $('rpm').textContent = (rpm / 1000).toFixed(1);
    const hasSpeed = running && mode === 'gps' && gpsSpeed !== null && now - lastFix < 8000;
    $('speed').textContent = hasSpeed ? String(Math.round(gpsSpeed)) : '—';
    $('speed-source').textContent = hasSpeed ? 'GPS 实时' : mode === 'gps' ? '等待 GPS 车速' : 'GPS 未连接';
    $('gear').textContent = running && mode === 'gps' ? String(gear) : 'N';
    $('gear-label').textContent = mode === 'gps' ? '自动跟随' : '自由轰油';
    $('pedal').style.setProperty('--throttle', throttle);
    const fraction = Math.min(1, rpm / gaugeMax);
    $('needle').setAttribute('transform', `rotate(${-128 + fraction * 256} 210 190)`);
    $('rpm-sweep').style.strokeDashoffset = 1 - fraction;
    cluster.style.setProperty('--throttle', throttle);
    const minute = Math.floor(Date.now() / 60000);
    if (minute !== lastClockMinute) {
      lastClockMinute = minute;
      const date = new Date();
      $('cluster-clock').textContent = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      $('cluster-weekday').textContent = date.toLocaleDateString('en-US', { weekday: 'long' });
      $('cluster-date').textContent = date.toLocaleDateString('en-GB');
      $('cluster-clock').dateTime = $('cluster-date').dateTime = date.toISOString();
    }
  }
  requestAnimationFrame(tick);
}
updateControls();
updateGaugeEngine();
requestAnimationFrame(tick);
