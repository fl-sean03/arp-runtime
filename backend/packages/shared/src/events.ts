export interface BaseEvent {
  type: string;
  ts: string; // ISO8601
  runId: string;
}

export interface RunStarted extends BaseEvent {
  type: 'run-start';
}

export interface RunToken extends BaseEvent {
  type: 'token';
  delta: string;
  sequence: number;
}

export interface RunDiffReady extends BaseEvent {
  type: 'diff';
  diff: string;
}

export interface RunCompleted extends BaseEvent {
  type: 'run-complete';
  status: 'succeeded' | 'failed';
  error?: string;
}

export type CodexEvent = RunStarted | RunToken | RunDiffReady | RunCompleted;