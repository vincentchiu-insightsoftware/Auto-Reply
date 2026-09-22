import { IllegalTransitionError, type DirectorState } from '../types.js';

const ALLOWED: Record<DirectorState, DirectorState[]> = {
  STOPPED: ['IDLE'],
  IDLE: ['GENERATING', 'PAUSED', 'ERROR', 'STOPPED'],
  GENERATING: ['SYNTHESIZING', 'IDLE', 'PAUSED', 'ERROR', 'STOPPED'],
  SYNTHESIZING: ['PLAYING', 'IDLE', 'PAUSED', 'ERROR', 'STOPPED'],
  PLAYING: ['IDLE', 'PAUSED', 'ERROR', 'STOPPED'],
  PAUSED: ['IDLE', 'STOPPED', 'ERROR'],
  ERROR: ['IDLE', 'STOPPED'],
};

export class StateMachine {
  private s: DirectorState = 'STOPPED';
  constructor(private onChange?: (from: DirectorState, to: DirectorState) => void) {}
  get state(): DirectorState {
    return this.s;
  }
  can(to: DirectorState): boolean {
    return ALLOWED[this.s].includes(to);
  }
  transition(to: DirectorState): void {
    if (!this.can(to)) throw new IllegalTransitionError(this.s, to);
    const from = this.s;
    this.s = to;
    this.onChange?.(from, to);
  }
}
