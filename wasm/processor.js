import createEngineSimModule from './engine-sim.js';

// Engine Simulator (MIT), via Torque Zero's browser ABI. License alongside this file.
class RevProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = 0;
    this.enabled = false;
    this.failed = false;
    this.rpm = 750;
    this.throttle = 0;
    this.cycle = 0;
    this.envelope = 0;
    this.frame = { rpm: 750, redline: 6500, throttle: 0 };
    this.parameters = [8, 350, 10.5, 48, 35, .64, .08, .8, 18, .9];
    this.port.onmessage = ({ data }) => {
      if (data.type === 'frame') this.frame = data.frame;
      if (data.type === 'enabled') this.enabled = data.value;
      if (data.type === 'configure') {
        this.pendingParameters = data.parameters;
      }
    };
    createEngineSimModule({
      instantiateWasm: (imports, receive) => {
        const instance = new WebAssembly.Instance(options.processorOptions.module, imports);
        receive(instance);
        return instance.exports;
      },
    }).then(module => {
      this.module = module;
      this.engine = module._tz_engine_create(sampleRate);
      this.configure();
      this.port.postMessage({ type: 'ready' });
    }).catch(() => this.fail());
  }

  configure() {
    this.module._tz_engine_configure(this.engine, ...this.parameters);
    this.module._tz_engine_set_simulation_frequency(this.engine, 10000);
  }

  fail() {
    this.failed = true;
    this.port.postMessage({ type: 'error' });
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    if (!output) return true;
    output.fill(0);
    if (!this.engine || this.failed) return true;
    try {
      // Fade through preset changes before rebuilding the upstream synthesizer.
      if (this.pendingParameters && (!this.enabled || this.envelope < .002)) {
        this.parameters = this.pendingParameters;
        this.pendingParameters = null;
        this.configure();
      }
      if (!this.enabled && this.envelope < .00001) return true;
      const dt = output.length / sampleRate;
      this.rpm += (this.frame.rpm - this.rpm) * (1 - Math.exp(-dt / .025));
      this.throttle += (this.frame.throttle - this.throttle) * (1 - Math.exp(-dt / .018));
      const idleVariation = (1 - this.throttle) * .006 * Math.sin(this.cycle * 2 * Math.PI);
      this.module._tz_engine_set_state(this.engine, this.rpm * (1 + idleVariation), this.frame.redline, this.throttle);
      const count = this.module._tz_engine_render(this.engine, output.length);
      const offset = this.module._tz_engine_output(this.engine) >> 1;
      const target = this.enabled && !this.pendingParameters ? 1 : 0;
      const smoothing = 1 - Math.exp(-1 / (sampleRate * (target ? .018 : .012)));
      const depth = (this.parameters[0] === 8 ? .075 : .035) * (1 - .5 * this.throttle);
      for (let i = 0; i < output.length; i++) {
        this.envelope += (target - this.envelope) * smoothing;
        this.cycle = (this.cycle + this.rpm / (120 * sampleRate)) % 1;
        const pulse = 1 + depth * Math.sin(this.cycle * 2 * Math.PI);
        if (i < count) output[i] = this.module.HEAP16[offset + i] / 32768 * this.envelope * pulse;
      }
    } catch {
      output.fill(0);
      this.fail();
    }
    return true;
  }
}
registerProcessor('rev-engine', RevProcessor);
