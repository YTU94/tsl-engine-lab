// A restrained cabin transfer: centered bass, softened exterior detail, short side reflections.
export function createCabinAudio(context) {
  const filter = (type, frequency, q, gain = 0) => {
    const node = context.createBiquadFilter();
    node.type = type; node.frequency.value = frequency; node.Q.value = q; node.gain.value = gain;
    return node;
  };
  const input = filter('highpass', 32, .7);
  const body = filter('lowshelf', 125, .7, 3);
  const boom = filter('peaking', 260, .8, -2.5);
  const harshness = filter('peaking', 1100, .65, -4);
  const shell = filter('lowpass', 1800, .55);
  input.connect(body).connect(boom).connect(harshness).connect(shell);

  const space = context.createGain();
  shell.connect(space);
  // Bass stays in phase; only quieter upper-body reflections reach the sides.
  const reflections = filter('highpass', 320, .7);
  shell.connect(reflections);
  for (const [seconds, level, pan] of [[.007, .09, -.65], [.011, .075, .65]]) {
    const delay = context.createDelay(.03);
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    delay.delayTime.value = seconds; gain.gain.value = level; panner.pan.value = pan;
    reflections.connect(delay).connect(gain).connect(panner).connect(space);
  }
  const output = context.createDynamicsCompressor();
  output.threshold.value = -9; output.knee.value = 8; output.ratio.value = 3;
  output.attack.value = .012; output.release.value = .18;
  // The upstream leveler flattens combustion volume; restore load-dependent dynamics.
  const dynamics = context.createGain(); dynamics.gain.value = .4;
  space.connect(dynamics).connect(output);
  return {
    input, output,
    update(rpm, redline, throttle) {
      const load = Math.max(0, Math.min(1, throttle));
      const revs = Math.max(0, Math.min(1, rpm / redline));
      shell.frequency.setTargetAtTime(1500 + load * 1200 + revs * 500, context.currentTime, .09);
      body.gain.setTargetAtTime(2 + load * 1.5, context.currentTime, .12);
      dynamics.gain.setTargetAtTime(.36 + load * .95 + revs * .18, context.currentTime, .07);
    },
  };
}
