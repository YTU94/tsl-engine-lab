import createEngineSimModule from './engine-sim.js';

// Engine Simulator (MIT), via Torque Zero's browser ABI. License alongside this file.
class RevProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = 0;
    this.enabled = false;
    this.failed = false;
    this.frame = { rpm: 750, redline: 6500, throttle: 0 };
    this.parameters = [8, 350, 10.5, 48, 35, .64, .08, .8, 18, .9];
    this.port.onmessage = ({ data }) => {
      if (data.type === 'frame') this.frame = data.frame;
      if (data.type === 'enabled') this.enabled = data.value;
      if (data.type === 'configure') {
        this.parameters = data.parameters;
        if (this.engine) this.configure();
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
    if (!this.engine || !this.enabled || this.failed) return true;
    try {
      this.module._tz_engine_set_state(this.engine, this.frame.rpm, this.frame.redline, this.frame.throttle);
      const count = this.module._tz_engine_render(this.engine, output.length);
      const offset = this.module._tz_engine_output(this.engine) >> 1;
      for (let i = 0; i < count; i++) output[i] = this.module.HEAP16[offset + i] / 32768;
    } catch {
      output.fill(0);
      this.fail();
    }
    return true;
  }
}
registerProcessor('rev-engine', RevProcessor);
