import type { AguiEvent } from './events.ts';
import type { AguiContentProjector } from './content-projector.ts';

/** Fan-out point for the native event stream: observer sink + content projection. */
export class AguiEmitter {
  readonly #projector: AguiContentProjector;
  readonly #sink?: (ev: AguiEvent) => void;

  constructor(opts: { projector: AguiContentProjector; sink?: (ev: AguiEvent) => void }) {
    this.#projector = opts.projector;
    this.#sink = opts.sink;
  }

  emit(ev: AguiEvent): void {
    this.#sink?.(ev);
    this.#projector.handle(ev);
  }
}
